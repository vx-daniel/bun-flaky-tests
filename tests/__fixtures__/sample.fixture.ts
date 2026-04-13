// Fixture run by the test-telemetry integration test in an isolated `bun test`
// subprocess. Deliberately NOT named `*.test.ts` so the main suite ignores it.
import { describe, expect, test } from 'bun:test'

describe('outer', () => {
  test('passing', () => {
    expect(1 + 1).toBe(2)
  })

  describe('inner', () => {
    test('failing assertion', () => {
      expect(1 + 1).toBe(3)
    })
  })
})

test('top-level thrown error', () => {
  throw new Error('boom')
})
