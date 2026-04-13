// Fixture: deliberately throws at module load time, before any test can
// register. This is the exact blind-spot case the wrapper exists to
// reconcile — the preload cannot observe it, only the exit code can.
import { describe, expect, test } from 'bun:test'

// biome-ignore lint/suspicious/noExplicitAny: deliberate runtime failure
const _forcedError = (test as any).propertyThatDoesNotExist.definitelyMissing()

describe('never registered', () => {
  test('never runs', () => {
    expect(true).toBe(true)
  })
})
