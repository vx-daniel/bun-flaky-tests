#!/usr/bin/env bun
/**
 * Authoritative test-telemetry runner.
 *
 * Spawns `bun test` as a subprocess so we can observe the true exit code
 * from outside the test process. Addresses the limitation documented in
 * preload.ts: module-load errors (e.g. `TypeError` at describe-registration
 * time) are reported by Bun but invisible to any in-process observer —
 * they don't hit `uncaughtException`, don't reach `process.stderr.write`,
 * and hard-exit without firing `beforeExit`. The exit code is the only
 * authoritative signal, and we can only read that from outside.
 *
 * Usage:
 *   bun tools/test-telemetry/run-tracked.ts [bun-test-args...]
 *
 * Behaviour:
 *   1. Generate a run id and export it via TEST_TELEMETRY_RUN_ID so the
 *      preload writes to the row we can update.
 *   2. Spawn `bun test` forwarding all argv through.
 *   3. On non-zero exit, if the row still says status='pass' it means the
 *      preload was blind to whatever killed the run — override to 'fail'
 *      and bump errors_between_tests so the flakiness query surfaces it.
 *   4. Propagate the child's exit code so CI behaviour is unchanged.
 */

// biome-ignore-all lint/suspicious/noConsole: CLI wrapper; pino is not wired up here.

import { Database } from 'bun:sqlite'

const DB_PATH =
  process.env.TEST_TELEMETRY_DB ?? 'node_modules/.cache/bun-flaky-tests/failures.db'

async function main(): Promise<number> {
  const runId = crypto.randomUUID()
  const forwardedArgs = process.argv.slice(2)

  const child = Bun.spawn({
    cmd: ['bun', 'test', ...forwardedArgs],
    env: { ...process.env, TEST_TELEMETRY_RUN_ID: runId },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
  const exitCode = await child.exited

  if (exitCode !== 0) {
    reconcileRun(runId, exitCode)
  }
  return exitCode
}

/**
 * Reconcile the preload's view of the run against the child's real exit
 * code. Opens the DB read-write, only to update the row matching `runId`,
 * and closes immediately. Never throws — a reconcile failure must not
 * mask the original test failure from CI.
 */
function reconcileRun(runId: string, exitCode: number): void {
  try {
    if (!Bun.file(DB_PATH).size) {
      // DB doesn't exist — preload never ran (e.g. `bun test` crashed
      // before loading the preload, or a different DB path was used).
      // Nothing to reconcile.
      return
    }
    const database = new Database(DB_PATH)
    try {
      const row = database
        .query(
          'SELECT status, failed_tests, errors_between_tests FROM runs WHERE run_id = ?',
        )
        .get(runId) as {
        status: string | null
        failed_tests: number | null
        errors_between_tests: number | null
      } | null

      if (row === null) {
        // Preload couldn't insert the runs row (DB open failed inside the
        // child, process died before the INSERT, etc.). Nothing to update.
        return
      }

      if (row.status !== 'pass') {
        // Preload already reported failure — nothing to override.
        return
      }

      // Preload said pass but bun disagreed. Some error bypassed every
      // in-process hook — mark it and bump the uncounted error bucket.
      database.run(
        `UPDATE runs
            SET status = 'fail',
                errors_between_tests = COALESCE(errors_between_tests, 0) + 1
          WHERE run_id = ?`,
        [runId],
      )
      console.warn(
        `[test-telemetry] Run ${runId} exited ${exitCode} but preload recorded status=pass. Overriding to fail.`,
      )
    } finally {
      database.close()
    }
  } catch (error) {
    console.warn('[test-telemetry] Failed to reconcile run status:', error)
  }
}

process.exit(await main())
