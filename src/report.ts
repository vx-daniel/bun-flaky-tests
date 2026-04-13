/**
 * @module
 *
 * Generates a self-contained HTML report from the test-telemetry SQLite DB.
 *
 * Usage:
 *   bun x jsr:@barf/bun-flaky-tests/report            # reads default DB, writes ./test-report.html
 *   TEST_TELEMETRY_DB=<path> bun x jsr:@barf/bun-flaky-tests/report
 *   bun x jsr:@barf/bun-flaky-tests/report --out <path>
 *   bun x jsr:@barf/bun-flaky-tests/report --open     # also open it in the default browser
 *
 * Single HTML file, no JS, no dependencies beyond bun:sqlite. Opens in any
 * browser. Colors convey severity + failure kind at a glance.
 */

// biome-ignore-all lint/suspicious/noConsole: CLI script; pino is not wired up here.

import { Database } from 'bun:sqlite'

const DB_PATH =
  process.env.TEST_TELEMETRY_DB ?? 'node_modules/.cache/bun-flaky-tests/failures.db'
const DEFAULT_OUT_PATH = 'test-report.html'
const outFlagIndex = process.argv.indexOf('--out')
const OUT_PATH =
  outFlagIndex !== -1 && outFlagIndex + 1 < process.argv.length
    ? (process.argv[outFlagIndex + 1] ?? DEFAULT_OUT_PATH)
    : DEFAULT_OUT_PATH

interface FlakyRow {
  test_file: string
  test_name: string
  fails: number
  last_failed: string
  kinds: string
}

interface KindRow {
  failure_kind: string
  count: number
}

interface RunRow {
  run_id: string
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  status: string | null
  total_tests: number | null
  passed_tests: number | null
  failed_tests: number | null
  errors_between_tests: number | null
  git_sha: string | null
  git_dirty: number | null
}

interface HotFileRow {
  test_file: string
  fails: number
  distinct_tests: number
}

interface Summary {
  activeFlakyTests: number
  dominantKind: { kind: string; count: number } | null
  worstFile: { file: string; fails: number } | null
  recentRunPassRate: number | null
}

function loadData(): {
  summary: Summary
  flaky: FlakyRow[]
  kinds: KindRow[]
  recentRuns: RunRow[]
  hotFiles: HotFileRow[]
  totalFailures: number
  totalRuns: number
} {
  const database = new Database(DB_PATH, { readonly: true })

  const flaky = database
    .query(
      `SELECT f.test_file, f.test_name,
              COUNT(*) AS fails,
              MAX(f.failed_at) AS last_failed,
              GROUP_CONCAT(DISTINCT f.failure_kind) AS kinds
         FROM failures f
         JOIN runs r ON r.run_id = f.run_id
        WHERE r.failed_tests < 10
          AND r.ended_at IS NOT NULL
          AND f.failed_at > datetime('now', '-30 days')
        GROUP BY f.test_file, f.test_name
        ORDER BY fails DESC
        LIMIT 20`,
    )
    .all() as FlakyRow[]

  const kinds = database
    .query(
      `SELECT failure_kind, COUNT(*) AS count
         FROM failures
        WHERE failed_at > datetime('now', '-30 days')
        GROUP BY failure_kind
        ORDER BY count DESC`,
    )
    .all() as KindRow[]

  const recentRuns = database
    .query(
      `SELECT run_id, started_at, ended_at, duration_ms, status,
              total_tests, passed_tests, failed_tests, errors_between_tests,
              git_sha, git_dirty
         FROM runs
        ORDER BY started_at DESC
        LIMIT 20`,
    )
    .all() as RunRow[]

  const hotFiles = database
    .query(
      `SELECT test_file,
              COUNT(*) AS fails,
              COUNT(DISTINCT test_name) AS distinct_tests
         FROM failures
        WHERE failed_at > datetime('now', '-30 days')
        GROUP BY test_file
        ORDER BY fails DESC
        LIMIT 15`,
    )
    .all() as HotFileRow[]

  const totalFailures = (
    database.query('SELECT COUNT(*) AS n FROM failures').get() as { n: number }
  ).n
  const totalRuns = (
    database.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }
  ).n

  const activeFlakyTests = (
    database
      .query(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1
             FROM failures f
             JOIN runs r ON r.run_id = f.run_id
            WHERE r.failed_tests < 10
              AND r.ended_at IS NOT NULL
              AND f.failed_at > datetime('now', '-30 days')
            GROUP BY f.test_file, f.test_name
           HAVING COUNT(*) >= 2
         )`,
      )
      .get() as { n: number }
  ).n

  const dominantKindRow = database
    .query(
      `SELECT failure_kind AS kind, COUNT(*) AS count
         FROM failures
        WHERE failed_at > datetime('now', '-30 days')
        GROUP BY failure_kind
        ORDER BY count DESC
        LIMIT 1`,
    )
    .get() as { kind: string; count: number } | null

  const worstFileRow = database
    .query(
      `SELECT test_file AS file, COUNT(*) AS fails
         FROM failures
        WHERE failed_at > datetime('now', '-30 days')
        GROUP BY test_file
        ORDER BY fails DESC
        LIMIT 1`,
    )
    .get() as { file: string; fails: number } | null

  const recentRunStats = database
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed
         FROM runs
        WHERE ended_at IS NOT NULL
          AND started_at > datetime('now', '-30 days')`,
    )
    .get() as { total: number; passed: number }

  const recentRunPassRate =
    recentRunStats.total > 0
      ? recentRunStats.passed / recentRunStats.total
      : null

  const summary: Summary = {
    activeFlakyTests,
    dominantKind: dominantKindRow,
    worstFile: worstFileRow,
    recentRunPassRate,
  }

  database.close()

  return {
    summary,
    flaky,
    kinds,
    recentRuns,
    hotFiles,
    totalFailures,
    totalRuns,
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function severityClass(count: number): string {
  if (count >= 10) return 'sev-high'
  if (count >= 5) return 'sev-med'
  if (count >= 2) return 'sev-low'
  return 'sev-single'
}

function kindBadge(kind: string): string {
  const safe = escapeHtml(kind)
  return `<span class="badge kind-${safe}">${safe}</span>`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function shortSha(sha: string | null): string {
  if (sha === null) return '—'
  return sha.slice(0, 7)
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffSec = Math.floor((now - then) / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

function passRateToneFor(passRatePct: number | null): string {
  if (passRatePct === null) return 'tone-muted'
  if (passRatePct >= 95) return 'tone-good'
  if (passRatePct >= 80) return 'tone-warn'
  return 'tone-bad'
}

function summaryTone(
  value: number,
  thresholds: { good: number; warn: number },
): string {
  if (value <= thresholds.good) return 'tone-good'
  if (value <= thresholds.warn) return 'tone-warn'
  return 'tone-bad'
}

function renderSummary(summary: Summary): string {
  const flakyTone = summaryTone(summary.activeFlakyTests, {
    good: 0,
    warn: 3,
  })
  const flakyLabel =
    summary.activeFlakyTests === 0
      ? 'none'
      : `${summary.activeFlakyTests} test${summary.activeFlakyTests === 1 ? '' : 's'}`

  const kindLabel = summary.dominantKind
    ? `<span class="badge kind-${escapeHtml(summary.dominantKind.kind)}">${escapeHtml(summary.dominantKind.kind)}</span>`
    : '<span class="muted">—</span>'
  const kindCount = summary.dominantKind
    ? `${summary.dominantKind.count} failures`
    : 'no failures'

  const fileLabel = summary.worstFile
    ? escapeHtml(
        summary.worstFile.file.split('/').pop() ?? summary.worstFile.file,
      )
    : '—'
  const fileCount = summary.worstFile
    ? `${summary.worstFile.fails} failures`
    : 'no failures'
  const fileTitle = summary.worstFile ? escapeHtml(summary.worstFile.file) : ''

  const passRate = summary.recentRunPassRate
  const passRatePct = passRate === null ? null : Math.round(passRate * 100)
  const passRateTone = passRateToneFor(passRatePct)
  const passRateLabel = passRatePct === null ? '—' : `${passRatePct}%`

  return `<section class="summary-grid">
    <div class="summary-card ${flakyTone}">
      <div class="summary-label">Active flaky tests</div>
      <div class="summary-value">${flakyLabel}</div>
      <div class="summary-hint">Distinct tests that failed ≥ 2× in last 30 days</div>
    </div>
    <div class="summary-card ${passRateTone}">
      <div class="summary-label">Recent run pass rate</div>
      <div class="summary-value">${passRateLabel}</div>
      <div class="summary-hint">Clean runs over last 30 days</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Dominant failure kind</div>
      <div class="summary-value">${kindLabel}</div>
      <div class="summary-hint">${escapeHtml(kindCount)}</div>
    </div>
    <div class="summary-card" title="${fileTitle}">
      <div class="summary-label">Worst file</div>
      <div class="summary-value mono summary-file">${fileLabel}</div>
      <div class="summary-hint">${escapeHtml(fileCount)}</div>
    </div>
  </section>`
}

function renderFlaky(rows: FlakyRow[]): string {
  if (rows.length === 0) {
    return '<p class="empty">No failures in the last 30 days. Clean house.</p>'
  }
  const items = rows
    .map((row) => {
      const kinds = row.kinds
        .split(',')
        .map((kind) => kindBadge(kind.trim()))
        .join(' ')
      return `
        <tr>
          <td><span class="count ${severityClass(row.fails)}">${row.fails}</span></td>
          <td class="test-name">${escapeHtml(row.test_name)}</td>
          <td class="file-path">${escapeHtml(row.test_file)}</td>
          <td>${kinds}</td>
          <td class="muted">${formatRelative(row.last_failed)}</td>
        </tr>`
    })
    .join('')
  return `<table>
    <thead>
      <tr><th>Fails</th><th>Test</th><th>File</th><th>Kinds</th><th>Last seen</th></tr>
    </thead>
    <tbody>${items}</tbody>
  </table>`
}

function renderKinds(rows: KindRow[]): string {
  if (rows.length === 0) return '<p class="empty">No data.</p>'
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return `<div class="kind-grid">${rows
    .map((row) => {
      const pct = total === 0 ? 0 : Math.round((row.count / total) * 100)
      return `
      <div class="kind-card kind-${escapeHtml(row.failure_kind)}">
        <div class="kind-label">${escapeHtml(row.failure_kind)}</div>
        <div class="kind-count">${row.count}</div>
        <div class="kind-pct">${pct}%</div>
      </div>`
    })
    .join('')}</div>`
}

function statusClassFor(status: string | null): string {
  if (status === 'pass') return 'status-pass'
  if (status === 'fail') return 'status-fail'
  return 'status-crashed'
}

function renderRuns(rows: RunRow[]): string {
  if (rows.length === 0) return '<p class="empty">No runs recorded.</p>'
  const items = rows
    .map((row) => {
      const statusClass = statusClassFor(row.status)
      const statusLabel = row.status ?? 'crashed'
      const dirty =
        row.git_dirty === 1
          ? '<span class="dirty" title="working tree dirty">●</span>'
          : ''
      const total = row.total_tests ?? 0
      const passed = row.passed_tests ?? 0
      const failed = row.failed_tests ?? 0
      const errorsBetween = row.errors_between_tests ?? 0
      const passedCell =
        passed > 0 ? `<span class="pass-count">${passed}</span>` : '0'
      const failedCell =
        failed > 0 ? `<span class="fail-count">${failed}</span>` : '0'
      const errorsCell =
        errorsBetween > 0
          ? `<span class="fail-count" title="errors outside tests — unhandled rejections, module-load throws">${errorsBetween}</span>`
          : '0'
      return `
        <tr>
          <td><span class="status ${statusClass}">${statusLabel}</span></td>
          <td class="muted">${formatRelative(row.started_at)}</td>
          <td>${formatDuration(row.duration_ms)}</td>
          <td>${total}</td>
          <td>${passedCell}</td>
          <td>${failedCell}</td>
          <td>${errorsCell}</td>
          <td class="muted mono">${shortSha(row.git_sha)}${dirty}</td>
        </tr>`
    })
    .join('')
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>When</th>
        <th>Duration</th>
        <th>Total</th>
        <th>Passed</th>
        <th>Failed</th>
        <th>Errors</th>
        <th>SHA</th>
      </tr>
    </thead>
    <tbody>${items}</tbody>
  </table>`
}

function renderHotFiles(rows: HotFileRow[]): string {
  if (rows.length === 0) return '<p class="empty">No data.</p>'
  const items = rows
    .map(
      (row) => `
      <tr>
        <td><span class="count ${severityClass(row.fails)}">${row.fails}</span></td>
        <td>${row.distinct_tests}</td>
        <td class="file-path">${escapeHtml(row.test_file)}</td>
      </tr>`,
    )
    .join('')
  return `<table>
    <thead>
      <tr><th>Fails</th><th>Distinct tests</th><th>File</th></tr>
    </thead>
    <tbody>${items}</tbody>
  </table>`
}

const STYLES = `
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-2: #1f2630;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --pass: #3fb950;
    --fail: #f85149;
    --warn: #d29922;
    --crashed: #8b949e;
    --kind-assertion: #58a6ff;
    --kind-timeout: #d29922;
    --kind-uncaught: #f85149;
    --kind-unknown: #8b949e;
    --sev-single: #3fb950;
    --sev-low: #d29922;
    --sev-med: #fb8500;
    --sev-high: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 2rem;
    max-width: 1200px;
    margin-inline: auto;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2rem;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .mascot {
    width: 56px;
    height: 56px;
    flex-shrink: 0;
    border-radius: 8px;
  }
  h1 { margin: 0; font-size: 1.5rem; font-weight: 600; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  h2 { margin: 2rem 0 1rem; font-size: 1.1rem; font-weight: 600; color: var(--text); }
  .subtitle { color: var(--text-muted); font-size: 0.85rem; }
  .summary {
    display: flex;
    gap: 2rem;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .summary strong { color: var(--text); font-weight: 600; }
  section { margin-bottom: 2.5rem; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  th, td {
    text-align: left;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  th {
    background: var(--surface-2);
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface-2); }
  .muted { color: var(--text-muted); }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .file-path { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.85rem; color: var(--text-muted); }
  .test-name { font-weight: 500; }
  .count {
    display: inline-block;
    min-width: 2.25rem;
    text-align: center;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-weight: 600;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }
  .sev-single { background: color-mix(in srgb, var(--sev-single) 20%, transparent); color: var(--sev-single); }
  .sev-low    { background: color-mix(in srgb, var(--sev-low) 20%, transparent); color: var(--sev-low); }
  .sev-med    { background: color-mix(in srgb, var(--sev-med) 25%, transparent); color: var(--sev-med); }
  .sev-high   { background: color-mix(in srgb, var(--sev-high) 25%, transparent); color: var(--sev-high); }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid transparent;
  }
  .kind-assertion { background: color-mix(in srgb, var(--kind-assertion) 18%, transparent); color: var(--kind-assertion); border-color: color-mix(in srgb, var(--kind-assertion) 35%, transparent); }
  .kind-timeout   { background: color-mix(in srgb, var(--kind-timeout) 20%, transparent); color: var(--kind-timeout); border-color: color-mix(in srgb, var(--kind-timeout) 40%, transparent); }
  .kind-uncaught  { background: color-mix(in srgb, var(--kind-uncaught) 20%, transparent); color: var(--kind-uncaught); border-color: color-mix(in srgb, var(--kind-uncaught) 40%, transparent); }
  .kind-unknown   { background: color-mix(in srgb, var(--kind-unknown) 20%, transparent); color: var(--kind-unknown); border-color: color-mix(in srgb, var(--kind-unknown) 40%, transparent); }
  .kind-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
  }
  .kind-card {
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .kind-card.kind-assertion { border-left: 4px solid var(--kind-assertion); }
  .kind-card.kind-timeout   { border-left: 4px solid var(--kind-timeout); }
  .kind-card.kind-uncaught  { border-left: 4px solid var(--kind-uncaught); }
  .kind-card.kind-unknown   { border-left: 4px solid var(--kind-unknown); }
  .kind-label {
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .kind-count { font-size: 2rem; font-weight: 700; margin-top: 0.25rem; }
  .kind-pct { color: var(--text-muted); font-size: 0.8rem; }
  .status {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .status-pass    { background: color-mix(in srgb, var(--pass) 20%, transparent); color: var(--pass); }
  .status-fail    { background: color-mix(in srgb, var(--fail) 20%, transparent); color: var(--fail); }
  .status-crashed { background: color-mix(in srgb, var(--crashed) 25%, transparent); color: var(--crashed); }
  .fail-count { color: var(--fail); font-weight: 600; }
  .pass-count { color: var(--pass); font-weight: 600; }
  .dirty { color: var(--warn); margin-left: 0.3rem; font-size: 0.7rem; }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 2.5rem;
  }
  .summary-card {
    padding: 1rem 1.25rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    border-left: 4px solid var(--text-muted);
  }
  .summary-card.tone-good { border-left-color: var(--pass); }
  .summary-card.tone-warn { border-left-color: var(--warn); }
  .summary-card.tone-bad  { border-left-color: var(--fail); }
  .summary-card.tone-muted { border-left-color: var(--text-muted); }
  .summary-label {
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .summary-value {
    font-size: 1.75rem;
    font-weight: 700;
    margin-top: 0.25rem;
    line-height: 1.2;
  }
  .summary-file {
    font-size: 1rem;
    word-break: break-all;
  }
  .summary-hint {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-top: 0.35rem;
  }
  footer {
    margin-top: 3rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  footer a {
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 1px dotted var(--border);
    padding-bottom: 1px;
  }
  footer a:hover {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  footer .sep {
    color: var(--border);
    margin: 0 0.6rem;
  }
  .empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px dashed var(--border);
    border-radius: 6px;
  }
`

function render(data: ReturnType<typeof loadData>): string {
  const generatedAt = new Date().toISOString()
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bun-flaky-tests report</title>
<style>${STYLES}</style>
</head>
<body>
  <header>
    <div class="brand">
      <img
        class="mascot"
        src="https://raw.githubusercontent.com/vx-daniel/bun-flaky-tests/refs/heads/main/mrflaky.png"
        alt="Mr. Flaky — a cracked, worried pastry"
        width="56"
        height="56"
      />
      <div>
        <h1>bun-flaky-tests</h1>
        <div class="subtitle">Generated ${escapeHtml(generatedAt)} · ${escapeHtml(DB_PATH)}</div>
      </div>
    </div>
    <div class="summary">
      <div><strong>${data.totalRuns}</strong> runs</div>
      <div><strong>${data.totalFailures}</strong> recorded failures</div>
    </div>
  </header>

  ${renderSummary(data.summary)}

  <section>
    <h2>Top 20 flaky tests (last 30 days)</h2>
    <p class="subtitle">Runs with &ge; 10 simultaneous failures and crashed runs excluded.</p>
    ${renderFlaky(data.flaky)}
  </section>

  <section>
    <h2>Failure kinds (last 30 days)</h2>
    ${renderKinds(data.kinds)}
  </section>

  <section>
    <h2>Hot spots by file (last 30 days)</h2>
    ${renderHotFiles(data.hotFiles)}
  </section>

  <section>
    <h2>Recent runs</h2>
    ${renderRuns(data.recentRuns)}
  </section>

  <footer>
    Generated by
    <a href="https://jsr.io/@barf/bun-flaky-tests" target="_blank" rel="noopener">@barf/bun-flaky-tests</a>
    <span class="sep">·</span>
    <a href="https://github.com/vx-daniel/bun-flaky-tests" target="_blank" rel="noopener">GitHub</a>
    <span class="sep">·</span>
    <a href="https://jsr.io/@barf/bun-flaky-tests" target="_blank" rel="noopener">JSR</a>
  </footer>
</body>
</html>`
}

/**
 * Fire-and-forget browser launch. Respects `$BROWSER` when set, otherwise
 * uses the platform default (`open` on macOS, `xdg-open` on Linux, `start`
 * on Windows). Never throws — report generation has already succeeded;
 * failing to open is a warning, not an error.
 */
function openInBrowser(filePath: string): void {
  const absolutePath = Bun.fileURLToPath(
    new URL(filePath, `file://${process.cwd()}/`),
  )
  const url = `file://${absolutePath}`

  const envBrowser = process.env.BROWSER
  let command: string[]
  if (envBrowser !== undefined && envBrowser.length > 0) {
    command = [envBrowser, url]
  } else if (process.platform === 'darwin') {
    command = ['open', url]
  } else if (process.platform === 'win32') {
    command = ['cmd', '/c', 'start', '', url]
  } else {
    command = ['xdg-open', url]
  }

  try {
    const child = Bun.spawn({
      cmd: command,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    // Don't await — let the browser process detach.
    child.unref?.()
  } catch (error) {
    console.warn(
      `[test-telemetry-report] Could not open browser (${command[0]}):`,
      error,
    )
  }
}

async function main(): Promise<void> {
  if (!(await Bun.file(DB_PATH).exists())) {
    console.error(
      `[test-telemetry-report] DB not found at ${DB_PATH}. Run \`bun test\` at least once.`,
    )
    process.exit(1)
  }
  const data = loadData()
  const html = render(data)
  await Bun.write(OUT_PATH, html)
  console.log(
    `[test-telemetry-report] Wrote ${OUT_PATH} (${data.totalRuns} runs, ${data.totalFailures} failures)`,
  )
  if (process.argv.includes('--open')) {
    openInBrowser(OUT_PATH)
  }
}

await main()
