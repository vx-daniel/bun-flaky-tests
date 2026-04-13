/**
 * Tracks the current `describe` nesting so tests report their full
 * `"outer > inner > test name"` path. The stack is module-private and
 * mutated by the wrapped `describe` callback via {@link DescribeStack.run}.
 *
 * A class rather than a module-level array to keep state explicit and
 * testable without cross-test pollution.
 */
export class DescribeStack {
  private frames: string[] = []

  /**
   * Snapshot of the current frames. Used by the `describe` wrapper to capture
   * the path at describe-call time (synchronous w.r.t. the outer body), then
   * replay it via {@link DescribeStack.runWithFrames} whenever Bun decides to
   * actually execute the nested body.
   */
  get snapshot(): readonly string[] {
    return this.frames
  }

  /**
   * Runs `body` with `name` pushed onto the stack. Pop is guaranteed by a
   * try/finally so a thrown describe body does not leave a dangling frame
   * and poison every subsequent test's path.
   *
   * @param name - The describe block label
   * @param body - The describe body — sync or async
   */
  run<T>(name: string, body: () => T): T {
    this.frames.push(name)
    try {
      return body()
    } finally {
      this.frames.pop()
    }
  }

  /**
   * Runs `body` with the stack temporarily replaced by `frames` (absolute,
   * not appended). Used to restore a describe-path captured at registration
   * time, since Bun defers nested describe body execution past the point
   * where the outer frame is still on the stack.
   *
   * @param frames - Absolute frame list to install for the duration of `body`
   * @param body - The describe body — sync or async
   */
  runWithFrames<T>(frames: readonly string[], body: () => T): T {
    const saved = this.frames
    this.frames = [...frames]
    try {
      return body()
    } finally {
      this.frames = saved
    }
  }

  /**
   * Returns the full path for a test with `testName`, joined by ` > `.
   *
   * @param testName - The leaf test name (the string passed to `test()` / `it()`)
   */
  path(testName: string): string {
    if (this.frames.length === 0) {
      return testName
    }
    return `${this.frames.join(' > ')} > ${testName}`
  }

  /**
   * Returns the current depth — exposed for tests; not used by the preload.
   */
  get depth(): number {
    return this.frames.length
  }
}
