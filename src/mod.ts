/**
 * @module
 *
 * `@barf/bun-flaky-tests` — public API.
 *
 * Most users don't import from this module directly. The tool is activated
 * via `bunfig.toml`:
 *
 *   [test]
 *   preload = ["jsr:@barf/bun-flaky-tests/preload"]
 *
 * And used via the bundled CLIs:
 *
 *   bun x jsr:@barf/bun-flaky-tests/run-tracked   # wrapper for authoritative status
 *   bun x jsr:@barf/bun-flaky-tests/report --open # HTML report
 *
 * This module re-exports the pure helpers for anyone wanting to build a
 * custom reporter or alternative query layer on top of the same DB.
 */

export { categorizeError, extractMessage, extractStack } from './categorize'
export type { FailureKind } from './categorize'
export { DescribeStack } from './describe-stack'
