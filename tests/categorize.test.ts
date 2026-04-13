import { describe, expect, test } from 'bun:test'
import { categorizeError, extractMessage, extractStack } from '../src/categorize'

describe('categorizeError', () => {
  test('classifies TimeoutError by name', () => {
    const error = new Error('whatever')
    error.name = 'TimeoutError'
    expect(categorizeError(error)).toBe('timeout')
  })

  test('classifies timeout by message content', () => {
    expect(categorizeError(new Error('the operation timed out'))).toBe('timeout')
    expect(categorizeError(new Error('timeout after 5000ms'))).toBe('timeout')
  })

  test('classifies AssertionError by name', () => {
    const error = new Error('nope')
    error.name = 'AssertionError'
    expect(categorizeError(error)).toBe('assertion')
  })

  test('classifies Bun expect() failures by message prefix', () => {
    expect(categorizeError(new Error('expect(received).toBe(expected)\n\nFoo'))).toBe('assertion')
  })

  test('classifies errors with matcherResult as assertions', () => {
    const error = Object.assign(new Error('fail'), { matcherResult: {} })
    expect(categorizeError(error)).toBe('assertion')
  })

  test('classifies generic Error as uncaught', () => {
    expect(categorizeError(new Error('boom'))).toBe('uncaught')
    expect(categorizeError(new TypeError('bad type'))).toBe('uncaught')
  })

  test('classifies non-Error throws as unknown', () => {
    expect(categorizeError('just a string')).toBe('unknown')
    expect(categorizeError(42)).toBe('unknown')
    expect(categorizeError(null)).toBe('unknown')
    expect(categorizeError(undefined)).toBe('unknown')
  })

  test('timeout check ordering wins over assertion', () => {
    const error = new Error('timed out')
    error.name = 'AssertionError'
    expect(categorizeError(error)).toBe('timeout')
  })
})

describe('extractMessage', () => {
  test('returns Error.message for Error instances', () => {
    expect(extractMessage(new Error('hello'))).toBe('hello')
  })

  test('coerces non-Error values to string', () => {
    expect(extractMessage('oops')).toBe('oops')
    expect(extractMessage(42)).toBe('42')
    expect(extractMessage(null)).toBe('null')
  })
})

describe('extractStack', () => {
  test('returns stack for Error instances', () => {
    const error = new Error('x')
    expect(extractStack(error)).toBe(error.stack ?? null)
  })

  test('returns null for non-Error values', () => {
    expect(extractStack('oops')).toBeNull()
    expect(extractStack(42)).toBeNull()
  })
})
