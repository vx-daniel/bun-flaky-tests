import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Integration test: spawn an isolated `bun test` run against a fixture with
 * a known pass/fail mix and assert the telemetry DB matches.
 *
 * The spawned `bun test` uses an empty tmp dir as cwd so it doesn't pick up
 * the repo's `bunfig.toml` — we pass our preload explicitly via `--preload`
 * and point it at a tmp DB via `TEST_TELEMETRY_DB`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PRELOAD_PATH = join(REPO_ROOT, 'src/preload.ts')
const FIXTURE_PATH = join(REPO_ROOT, 'tests/__fixtures__/sample.fixture.ts')
const RUN_TRACKED_PATH = join(REPO_ROOT, 'src/run-tracked.ts')
const MODULE_LOAD_ERROR_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/__fixtures__/module-load-error.fixture.ts',
)

describe('test-telemetry integration', () => {
  let tempRoot = ''
  let dbPath = ''

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'test-telemetry-'))
    dbPath = join(tempRoot, 'telemetry.db')

    const result = Bun.spawnSync({
      cmd: ['bun', 'test', '--preload', PRELOAD_PATH, FIXTURE_PATH],
      cwd: tempRoot,
      env: {
        ...process.env,
        TEST_TELEMETRY_DB: dbPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // The fixture has 2 failing tests, so exit code will be non-zero — that's
    // expected. We only care that the DB got populated.
    if (!(await Bun.file(dbPath).exists())) {
      const stdout = new TextDecoder().decode(result.stdout)
      const stderr = new TextDecoder().decode(result.stderr)
      throw new Error(
        `telemetry DB was never created.\nexit=${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }
  })

  afterAll(() => {
    if (tempRoot.length > 0) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('inserts exactly one run row with split pass/fail counts', () => {
    const database = new Database(dbPath, { readonly: true })
    const rows = database.query('SELECT * FROM runs').all() as Array<Record<string, unknown>>
    database.close()
    expect(rows).toHaveLength(1)
    const run = rows[0]!
    expect(run.status).toBe('fail')
    expect(run.ended_at).not.toBeNull()
    expect(run.total_tests).toBe(3)
    expect(run.passed_tests).toBe(1)
    expect(run.failed_tests).toBe(2)
    expect(run.errors_between_tests).toBe(0)
    expect(typeof run.duration_ms).toBe('number')
    expect(run.bun_version).toBe(Bun.version)
  })

  test('inserts one failure row per failing test', () => {
    const database = new Database(dbPath, { readonly: true })
    const rows = database
      .query('SELECT test_name, failure_kind, error_message FROM failures ORDER BY test_name')
      .all() as Array<{ test_name: string; failure_kind: string; error_message: string }>
    database.close()

    expect(rows).toHaveLength(2)

    const assertionFailure = rows.find((row) => row.failure_kind === 'assertion')
    expect(assertionFailure).toBeDefined()
    expect(assertionFailure?.test_name).toBe('outer > inner > failing assertion')
    expect(assertionFailure?.error_message).toContain('expect(received).toBe(expected)')

    const uncaughtFailure = rows.find((row) => row.failure_kind === 'uncaught')
    expect(uncaughtFailure).toBeDefined()
    expect(uncaughtFailure?.test_name).toBe('top-level thrown error')
    expect(uncaughtFailure?.error_message).toBe('boom')
  })

  test('links every failure to the run', () => {
    const database = new Database(dbPath, { readonly: true })
    const orphans = database
      .query(
        `SELECT COUNT(*) AS count
         FROM failures f
         LEFT JOIN runs r ON r.run_id = f.run_id
         WHERE r.run_id IS NULL`,
      )
      .get() as { count: number }
    database.close()
    expect(orphans.count).toBe(0)
  })
})

describe('run-tracked wrapper: reconciles module-load errors', () => {
  // The blind-spot case: a fixture that throws at module load time cannot
  // be observed by the preload (no uncaughtException, no stderr.write hook,
  // no afterAll). Only the subprocess exit code reveals the failure. The
  // wrapper spawns `bun test`, reads exit code, and overrides the row.
  let tempRoot = ''
  let dbPath = ''
  let exitCode: number | null = null

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'test-telemetry-tracked-'))
    dbPath = join(tempRoot, 'telemetry.db')

    const result = Bun.spawnSync({
      cmd: [
        'bun',
        RUN_TRACKED_PATH,
        '--preload',
        PRELOAD_PATH,
        MODULE_LOAD_ERROR_FIXTURE_PATH,
      ],
      cwd: tempRoot,
      env: { ...process.env, TEST_TELEMETRY_DB: dbPath },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    exitCode = result.exitCode

    if (!(await Bun.file(dbPath).exists())) {
      const stdout = new TextDecoder().decode(result.stdout)
      const stderr = new TextDecoder().decode(result.stderr)
      throw new Error(
        `telemetry DB was never created.\nexit=${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }
  })

  afterAll(() => {
    if (tempRoot.length > 0) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('propagates the non-zero exit code from bun test', () => {
    expect(exitCode).not.toBe(0)
  })

  test('overrides status to fail even though the preload saw no failures', () => {
    const database = new Database(dbPath, { readonly: true })
    const run = database.query('SELECT * FROM runs').get() as Record<string, unknown>
    database.close()
    expect(run.status).toBe('fail')
    expect(run.failed_tests).toBe(0)
    expect(run.errors_between_tests).toBeGreaterThanOrEqual(1)
  })
})

