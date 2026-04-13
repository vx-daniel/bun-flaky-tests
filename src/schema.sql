-- Test telemetry schema. Applied on DB open if tables are missing.
--
-- Flakiness reference query (paste into sqlite3):
--
--   SELECT f.test_file, f.test_name, COUNT(*) AS fails, MAX(f.failed_at) AS last
--   FROM failures f
--   JOIN runs r ON r.run_id = f.run_id
--   WHERE r.failed_tests < 10              -- skip suite-wide breakage runs
--     AND r.ended_at IS NOT NULL           -- skip crashed runs
--     AND f.failed_at > datetime('now', '-30 days')
--   GROUP BY f.test_file, f.test_name
--   ORDER BY fails DESC
--   LIMIT 20;

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
