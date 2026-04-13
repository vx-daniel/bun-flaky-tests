<h1 align="center">
  <img src="./mrflaky.png" alt="Mr. Flaky — a cracked, worried pastry" width="180" /><br />
  <code>@barf/bun-flaky-tests</code>
</h1>

<p align="center"><em>Your bun should be flaky. Your tests shouldn't.</em></p>

Meet **Mr. Flaky** — the cracked pastry who represents every test in your
suite that can't be trusted. This package helps you find him.

SQLite-backed test-failure telemetry for Bun projects. Runs as a `bun test`
preload, records every failure with rich context (stack, kind, describe
path, timing, git SHA), and surfaces the ones that fail repeatedly — the
flaky tests worth improving, reworking, splitting, or deleting.

Zero runtime dependencies beyond Bun builtins (`bun:sqlite`, `bun:test`).

## Install

```bash
bun add -D jsr:@barf/bun-flaky-tests
```

Then in `bunfig.toml`:

```toml
[test]
preload = ["jsr:@barf/bun-flaky-tests/preload"]
```

That's it. Next `bun test` run will write to
`node_modules/.cache/bun-flaky-tests/failures.db`.

## Usage

```bash
bun test                                               # run tests; preload captures data automatically
bun x jsr:@barf/bun-flaky-tests/report --open          # render HTML report, open in browser
bun x jsr:@barf/bun-flaky-tests/run-tracked            # run tests with authoritative status reconciliation
```

Add to your own `package.json` for convenience:

```json
{
  "scripts": {
    "test:report": "bun x jsr:@barf/bun-flaky-tests/report --open",
    "test:tracked": "bun x jsr:@barf/bun-flaky-tests/run-tracked"
  }
}
```

## Why a wrapper (`run-tracked`)

The preload catches every failure that occurs **inside** a test function.
But Bun can also emit errors **between** tests — module-load failures,
unhandled rejections from native code paths — that bypass every in-process
hook (`uncaughtException`, `process.stderr.write`, `beforeExit`). From
inside the process these are unobservable.

`run-tracked` spawns `bun test` as a subprocess, reads the true exit code
after it completes, and reconciles the DB's `status` column if it lies.
Use it in CI and anywhere you need the telemetry to be bulletproof.

Plain `bun test` is faster and fine for daily dev. The only difference is
accuracy of the `status` column on exotic failure modes.

## What it captures

### `runs` table
One row per `bun test` invocation:

| Column | Meaning |
|---|---|
| `run_id` | UUID |
| `started_at` / `ended_at` | ISO timestamps (`ended_at` NULL if the run crashed) |
| `duration_ms` | wall time |
| `status` | `pass` / `fail` |
| `total_tests` / `passed_tests` / `failed_tests` / `errors_between_tests` | counters |
| `git_sha` / `git_dirty` | commit context |
| `bun_version` / `bun_test_args` | environment |

### `failures` table
One row per failing test (or inter-test error):

| Column | Meaning |
|---|---|
| `run_id` | FK to `runs` |
| `test_file` / `test_name` | full `describe > describe > test` path |
| `failure_kind` | `assertion` / `timeout` / `uncaught` / `unknown` |
| `error_message` / `error_stack` | full Error data |
| `duration_ms` / `failed_at` | timing |

### Flakiness query

```sql
SELECT f.test_file, f.test_name, COUNT(*) AS fails, MAX(f.failed_at) AS last
FROM failures f
JOIN runs r ON r.run_id = f.run_id
WHERE r.failed_tests < 10              -- skip runs where the whole suite broke
  AND r.ended_at IS NOT NULL           -- skip crashed runs
  AND f.failed_at > datetime('now', '-30 days')
GROUP BY f.test_file, f.test_name
ORDER BY fails DESC
LIMIT 20;
```

The HTML report runs this and several companion queries — top flaky
tests, failure-kind breakdown, hot-spot files, recent runs — in a
dark-themed single-page document.

## Environment variables

| Variable | Effect |
|---|---|
| `TEST_TELEMETRY_DB` | Override DB path (default: `node_modules/.cache/bun-flaky-tests/failures.db`) |
| `TEST_TELEMETRY_RUN_ID` | Pre-set the run id — used internally by `run-tracked` to share rows between preload and wrapper |
| `TEST_TELEMETRY_DISABLE=1` | Skip all telemetry; preload becomes a no-op |

## Compatibility

- **Bun ≥ 1.3.0** (uses `mock.module()` to intercept builtin `bun:test`).
- **Not compatible with Node.** Depends on `bun:sqlite` and `bun:test` builtins.
- Should Just Work with any Bun project using `bun:test`. Framework-specific
  test helpers (React Testing Library, etc.) are orthogonal.

## Known limitations

See the design notes at the top of `src/preload.ts`:

1. **Parameterized tests undercount.** Tests registered via `test.each([...])(...)`
   bypass the wrapper's counter (they call Bun's original `test` through the
   Proxy's bound sub-API forwarding). They execute and pass/fail correctly,
   but don't increment `total_tests`.
2. **`done`-callback tests lose telemetry.** Tests with `fn.length > 0` are
   passed through unwrapped to preserve Bun's async-done detection.
3. **Stack traces include a `preload.ts` frame.** Cosmetic.
4. **Module-load errors are invisible to the preload.** Use `run-tracked`
   to reconcile status via exit code.

## Development

```bash
git clone https://github.com/<org>/bun-flaky-tests
cd bun-flaky-tests
bun install
bun test                # run the 23 unit + integration tests
bun run publish:dry     # dry-run JSR publish
```

## License

MIT
