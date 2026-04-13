import { describe, expect, test } from 'bun:test'
import { DescribeStack } from '../src/describe-stack'

describe('DescribeStack', () => {
  test('path returns the test name alone at depth 0', () => {
    const stack = new DescribeStack()
    expect(stack.path('just a test')).toBe('just a test')
    expect(stack.depth).toBe(0)
  })

  test('path joins describe frames with " > "', () => {
    const stack = new DescribeStack()
    let recorded = ''
    stack.run('outer', () => {
      stack.run('inner', () => {
        recorded = stack.path('leaf')
      })
    })
    expect(recorded).toBe('outer > inner > leaf')
  })

  test('pops the frame even when the body throws', () => {
    const stack = new DescribeStack()
    expect(() => {
      stack.run('outer', () => {
        throw new Error('body boom')
      })
    }).toThrow('body boom')
    expect(stack.depth).toBe(0)
    expect(stack.path('after')).toBe('after')
  })

  test('runWithFrames installs an absolute frame set and restores it after', () => {
    const stack = new DescribeStack()
    stack.run('original', () => {
      stack.runWithFrames(['captured-outer', 'captured-inner'], () => {
        expect(stack.path('leaf')).toBe('captured-outer > captured-inner > leaf')
      })
      // Back to the 'original' frame after runWithFrames returns
      expect(stack.path('leaf')).toBe('original > leaf')
    })
    expect(stack.depth).toBe(0)
  })

  test('runWithFrames restores frames even when body throws', () => {
    const stack = new DescribeStack()
    expect(() => {
      stack.runWithFrames(['captured'], () => {
        throw new Error('nope')
      })
    }).toThrow('nope')
    expect(stack.depth).toBe(0)
  })

  test('sibling describes do not leak frames', () => {
    const stack = new DescribeStack()
    stack.run('a', () => {
      // intentionally empty
    })
    stack.run('b', () => {
      expect(stack.path('x')).toBe('b > x')
    })
    expect(stack.depth).toBe(0)
  })
})
