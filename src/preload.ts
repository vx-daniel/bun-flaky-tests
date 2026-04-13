/**
 * bun-flaky-tests preload.
 *
 * Loaded by `bun test` via `bunfig.toml`'s `[test] preload` array. Monkey-patches
 * `bun:test` so every `test`/`it`/`describe` call is wrapped with a try/catch
 * that writes failures to SQLite at
 * `node_modules/.cache/bun-flaky-tests/failures.db` (overridable with the
 * `TEST_TELEMETRY_DB` environment variable).
 *
 * Set `TEST_TELEMETRY_DISABLE=1` to skip all telemetry — escape hatch.
 *
 * Design notes: the `afterEach` hook in `bun:test` does not receive the test's
 * pass/fail state, so direct result observation is impossible. The working
 * mechanism is `mock.module('bun:test', ...)` which replaces the builtin
 * module's `test`/`it`/`describe` exports with wrappers. Rethrowing the caught
 * error preserves Bun's own reporting.
 *
 * The preload MUST NOT throw. All DB operations are wrapped in try/catch and
 * failures are reported via `console.warn` to stderr.
 */

// biome-ignore-all lint/suspicious/noConsole: preload is dev tooling; pino is not available here.

import { mkdirSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import * as bunTest from 'bun:test'
import { afterAll, mock } from 'bun:test'
import { categorizeError, extractMessage, extractStack } from './categorize'
import { DescribeStack } from './describe-stack'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id                TEXT PRIMARY KEY,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  duration_ms           INTEGER,
  status                TEXT,
  total_tests           INTEGER,
  passed_tests          INTEGER,
  failed_tests          INTEGER,
  errors_between_tests  INTEGER,
  git_sha               TEXT,
  git_dirty             INTEGER,
  bun_version           TEXT,
  bun_test_args         TEXT
);

CREATE TABLE IF NOT EXISTS failures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(run_id),
  test_file      TEXT NOT NULL,
  test_name      TEXT NOT NULL,
  failure_kind   TEXT NOT NULL,
  error_message  TEXT,
  error_stack    TEXT,
  duration_ms    INTEGER,
  failed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_failures_test ON failures(test_file, test_name);
CREATE INDEX IF NOT EXISTS idx_failures_run  ON failures(run_id);
`

type TestCallback = (...args: unknown[]) => unknown | Promise<unknown>
type TestFn = (name: string, fn: TestCallback, timeout?: number) => unknown
type DescribeFn = (name: string, body: () => void) => unknown

/** Safely run a side-effect that must never throw into the caller. */
function safe(label: string, effect: () => void): void {
  try {
    effect()
  } catch (error) {
    console.warn(`[test-telemetry] ${label} failed:`, error)
  }
}

function resolveDbPath(): string {
  const override = process.env.TEST_TELEMETRY_DB
  if (override !== undefined && override.length > 0) {
    return override
  }
  return 'node_modules/.cache/bun-flaky-tests/failures.db'
}

/**
 * Ensures the parent directory for the DB exists. `new Database(path,
 * { create: true })` creates the file but not any missing parent dirs,
 * which bites us on fresh checkouts of projects that install this package.
 */
function ensureDbDirectory(dbPath: string): void {
  const lastSlash = dbPath.lastIndexOf('/')
  if (lastSlash <= 0) return
  const parent = dbPath.slice(0, lastSlash)
  try {
    mkdirSync(parent, { recursive: true })
  } catch {
    // Directory exists or cannot be created; let Database open attempt anyway.
  }
}

function runGit(args: string[]): string | null {
  try {
    const result = Bun.spawnSync({
      cmd: ['git', ...args],
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (result.exitCode !== 0) return null
    return new TextDecoder().decode(result.stdout)
  } catch {
    return null
  }
}

function captureGitInfo(): { sha: string | null; dirty: 0 | 1 | null } {
  const sha = runGit(['rev-parse', 'HEAD'])
  const porcelain = runGit(['status', '--porcelain'])
  if (sha === null) return { sha: null, dirty: null }
  return {
    sha: sha.trim(),
    dirty: porcelain !== null && porcelain.trim().length > 0 ? 1 : 0,
  }
}

/**
 * Idempotent column adds. SQLite lacks `ADD COLUMN IF NOT EXISTS`, so each
 * ALTER throws when the column already exists — catch and ignore. This lets
 * old DBs created before the column split auto-migrate on next open.
 */
function migrateSchema(database: Database): void {
  const migrations = [
    'ALTER TABLE runs ADD COLUMN passed_tests INTEGER',
    'ALTER TABLE runs ADD COLUMN errors_between_tests INTEGER',
  ]
  for (const statement of migrations) {
    try {
      database.exec(statement)
    } catch {
      // Column already present — expected on fresh DBs where CREATE TABLE
      // included it, or on already-migrated DBs.
    }
  }
}

function openDatabase(dbPath: string): Database {
  const database = new Database(dbPath, { create: true })
  database.exec('PRAGMA journal_mode = WAL')
  database.exec(SCHEMA)
  migrateSchema(database)
  return database
}

/**
 * Resolves the test source file from a thrown error's stack by locating the
 * first frame that isn't in `tools/test-telemetry/`. Falls back to `'unknown'`.
 */
function resolveTestFile(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return 'unknown'
  }
  const lines = error.stack.split('\n')
  for (const line of lines) {
    const match = line.match(/\(([^)]+\.(?:ts|tsx|js|jsx|mjs|cjs)):\d+:\d+\)/)
    if (!match) continue
    const file = match[1] ?? ''
    if (file.includes('/test-telemetry/')) continue
    return file
  }
  return 'unknown'
}

// --- Setup ----------------------------------------------------------------

if (process.env.TEST_TELEMETRY_DISABLE !== '1') {
  setup()
}

function setup(): void {
  let database: Database | null = null
  safe('open database', () => {
    const dbPath = resolveDbPath()
    ensureDbDirectory(dbPath)
    database = openDatabase(dbPath)
  })

  if (database === null) {
    // Nothing to do — stay out of the test runner's way entirely.
    return
  }

  // If a wrapper script (run-tracked.ts) set a shared run id, use it so the
  // wrapper can UPDATE the same row post-exit with authoritative status.
  // Otherwise generate our own.
  const providedRunId = process.env.TEST_TELEMETRY_RUN_ID
  const runId =
    providedRunId !== undefined && providedRunId.length > 0
      ? providedRunId
      : crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const startedPerf = performance.now()
  const git = captureGitInfo()
  const bunTestArgs = process.argv.slice(2).join(' ')

  safe('insert runs row', () => {
    database?.run(
      `INSERT INTO runs
         (run_id, started_at, git_sha, git_dirty, bun_version, bun_test_args)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, startedAt, git.sha, git.dirty, Bun.version, bunTestArgs],
    )
  })

  let testsRun = 0
  let testsFailed = 0
  let errorsBetweenTests = 0
  const describeStack = new DescribeStack()

  // Errors that escape our test wrapper — unhandled promise rejections or
  // uncaught exceptions thrown during module load, describe registration,
  // or background work. Bun reports these as "errors between tests" in its
  // summary; we count them so the run's `status` reflects the truth.
  const onRunLevelError = (error: unknown): void => {
    errorsBetweenTests += 1
    safe('insert inter-test error row', () => {
      database?.run(
        `INSERT INTO failures
           (run_id, test_file, test_name, failure_kind, error_message, error_stack, duration_ms, failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          resolveTestFile(error),
          '<between tests>',
          categorizeError(error),
          extractMessage(error),
          extractStack(error),
          0,
          new Date().toISOString(),
        ],
      )
    })
  }
  process.on('uncaughtException', onRunLevelError)
  process.on('unhandledRejection', onRunLevelError)

  // Known limitation: Bun's "# Unhandled error between tests" for
  // module-load errors (e.g. `it.each is not a function` at import time) is
  // UNOBSERVABLE from within a preload. Bun writes the marker directly to
  // fd 2 (bypassing `process.stderr.write`), does not propagate the error
  // to `uncaughtException`/`unhandledRejection`, and hard-exits without
  // firing `beforeExit`/`exit`. The only signal is the non-zero exit code,
  // which we can't read for our own process. Fixing this requires a
  // wrapper script that spawns `bun test` and updates the DB from outside.
  // For now, runs where only module-load errors occurred will still record
  // status='pass' — the CI/user-visible exit code remains accurate.

  const recordFailure = (opts: {
    testFile: string
    testName: string
    error: unknown
    durationMs: number
  }): void => {
    safe('insert failure row', () => {
      database?.run(
        `INSERT INTO failures
           (run_id, test_file, test_name, failure_kind, error_message, error_stack, duration_ms, failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          opts.testFile,
          opts.testName,
          categorizeError(opts.error),
          extractMessage(opts.error),
          extractStack(opts.error),
          Math.round(opts.durationMs),
          new Date().toISOString(),
        ],
      )
    })
  }

  // Proxy-based wrapping: sub-APIs like `.each`, `.skip`, `.only`, `.todo`,
  // `.failing`, `.if`, `.concurrent`, `.serial` live on the PROTOTYPE chain
  // of Bun's test/it/describe functions — NOT as own properties — so a
  // property-copy loop misses them entirely, and test files using
  // `it.each(...)` or `it.skip(...)` throw TypeError at import time. The
  // Proxy falls through to the original for every property we haven't
  // wrapped, so all current and future sub-APIs keep working.

  const wrapTest = (originalTest: TestFn): TestFn => {
    const callWrapped: TestFn = (name, fn, timeout) => {
      // Preserve `done`-callback style tests — wrapping would change arity
      // and trigger Bun's async-done timeout.
      if (fn.length > 0) {
        return originalTest(name, fn, timeout)
      }
      const fullPath = describeStack.path(name)
      const wrappedFn: TestCallback = async () => {
        testsRun += 1
        const startedTestPerf = performance.now()
        try {
          await fn()
        } catch (error) {
          const durationMs = performance.now() - startedTestPerf
          testsFailed += 1
          recordFailure({
            testFile: resolveTestFile(error),
            testName: fullPath,
            error,
            durationMs,
          })
          throw error
        }
      }
      return originalTest(name, wrappedFn, timeout)
    }
    return new Proxy(originalTest, {
      apply: (_target, _thisArg, args) =>
        callWrapped(
          args[0] as string,
          args[1] as TestCallback,
          args[2] as number | undefined,
        ),
      // Forward property access (`.each`, `.skip`, `.only`, ...) to the
      // original. Sub-APIs on Bun's test/it are native getters with strict
      // `this` validation, so we pass `target` as the receiver — otherwise
      // accessing `wrapped.skip` throws "getter can only be used on
      // instances of ScopeFunctions".
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target)
        // Sub-APIs on Bun's test/it/describe check `this instanceof
        // ScopeFunctions` at invocation time. Binding to the real target
        // ensures that check passes when the user writes `it.each(...)` or
        // `describe.skip(...)` through our Proxy.
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as TestFn
  }

  const wrapDescribe = (originalDescribe: DescribeFn): DescribeFn => {
    const callWrapped: DescribeFn = (name, body) => {
      // Capture the path SYNCHRONOUSLY at describe-call time — Bun defers
      // nested describe body execution past the point where the outer frame
      // is still on the live stack, so a relative push/pop can't see it.
      const capturedFrames = [...describeStack.snapshot, name]
      return originalDescribe(name, () =>
        describeStack.runWithFrames(capturedFrames, body),
      )
    }
    return new Proxy(originalDescribe, {
      apply: (_target, _thisArg, args) =>
        callWrapped(args[0] as string, args[1] as () => void),
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target)
        // Sub-APIs on Bun's test/it/describe check `this instanceof
        // ScopeFunctions` at invocation time. Binding to the real target
        // ensures that check passes when the user writes `it.each(...)` or
        // `describe.skip(...)` through our Proxy.
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as DescribeFn
  }

  const wrappedTest = wrapTest(bunTest.test as unknown as TestFn)
  const wrappedIt = wrapTest(bunTest.it as unknown as TestFn)
  const wrappedDescribe = wrapDescribe(
    bunTest.describe as unknown as DescribeFn,
  )

  safe('monkey-patch bun:test', () => {
    mock.module('bun:test', () => ({
      ...bunTest,
      test: wrappedTest,
      it: wrappedIt,
      describe: wrappedDescribe,
    }))
  })

  afterAll(() => {
    const endedAt = new Date().toISOString()
    const durationMs = Math.round(performance.now() - startedPerf)
    // A run is only 'pass' if every test passed AND no errors escaped the
    // wrapper (unhandled rejections, module-load throws, etc.). Columns are
    // kept separate so the flakiness query can distinguish a run with
    // in-test failures from a run with only between-tests errors.
    const passedTests = testsRun - testsFailed
    const hasAnyFailure = testsFailed > 0 || errorsBetweenTests > 0
    const status = hasAnyFailure ? 'fail' : 'pass'
    safe('finalise runs row', () => {
      database?.run(
        `UPDATE runs
            SET ended_at             = ?,
                duration_ms          = ?,
                status               = ?,
                total_tests          = ?,
                passed_tests         = ?,
                failed_tests         = ?,
                errors_between_tests = ?
          WHERE run_id = ?`,
        [
          endedAt,
          durationMs,
          status,
          testsRun,
          passedTests,
          testsFailed,
          errorsBetweenTests,
          runId,
        ],
      )
    })
    safe('close database', () => {
      database?.close()
    })
  })
}
