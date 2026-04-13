/**
 * Classifies a thrown test error into a coarse category used by the flakiness
 * query. The categories are deliberately few — we want to answer "is this test
 * timing out vs. a bad assertion vs. an uncaught crash" at a glance, not
 * produce fine-grained diagnostics.
 */
export type FailureKind = 'assertion' | 'timeout' | 'uncaught' | 'unknown'

/**
 * Derives the {@link FailureKind} from whatever was thrown. Accepts `unknown`
 * because JavaScript allows throwing non-Error values (`throw 'oops'`), and
 * we must classify those too.
 *
 * Ordering of checks matters: a timeout thrown as an AssertionError should
 * classify as `timeout` — the timeout signal is the more useful category for
 * flakiness analysis.
 *
 * @param error - Value thrown by the failing test
 */
export function categorizeError(error: unknown): FailureKind {
  if (!(error instanceof Error)) {
    return 'unknown'
  }
  const message = error.message ?? ''
  if (error.name === 'TimeoutError' || /timed? ?out/i.test(message)) {
    return 'timeout'
  }
  if (
    error.name === 'AssertionError' ||
    // Bun's `expect` attaches a `matcherResult` to failures.
    'matcherResult' in error ||
    // Fallback: Bun's expect error message format
    message.startsWith('expect(received)')
  ) {
    return 'assertion'
  }
  return 'uncaught'
}

/**
 * Extracts a message string from a thrown value, coercing non-Error throws
 * to their string representation.
 *
 * @param error - Value thrown by the failing test
 */
export function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/**
 * Extracts a stack string from a thrown value, returning `null` for non-Error
 * throws that have no stack.
 *
 * @param error - Value thrown by the failing test
 */
export function extractStack(error: unknown): string | null {
  if (error instanceof Error && typeof error.stack === 'string') {
    return error.stack
  }
  return null
}
