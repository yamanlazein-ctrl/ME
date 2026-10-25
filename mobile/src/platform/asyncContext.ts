// Phone adapter for `node:async_hooks` (research R3). Hermes has no AsyncLocalStorage. This stack-based
// replacement is correct only because every use-case runs through src/core/serialExecutor.ts: nothing
// interleaves, so the innermost active `run` is always the right store.
export class AsyncLocalStorage<T> {
  private stack: T[] = [];

  run<R>(store: T, fn: () => R): R {
    this.stack.push(store);
    const depth = this.stack.length;
    const pop = (): void => {
      this.stack.length = depth - 1;
    };
    let result: R;
    try {
      result = fn();
    } catch (error) {
      pop();
      throw error;
    }
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (result as unknown as Promise<unknown>).finally(pop) as unknown as R;
    }
    pop();
    return result;
  }

  getStore(): T | undefined {
    return this.stack[this.stack.length - 1];
  }

  enterWith(store: T): void {
    if (this.stack.length === 0) this.stack.push(store);
    else this.stack[this.stack.length - 1] = store;
  }

  exit<R>(fn: () => R): R {
    const saved = this.stack;
    this.stack = [];
    try {
      return fn();
    } finally {
      this.stack = saved;
    }
  }
}
