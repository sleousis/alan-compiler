// Runs deeply recursive code without deep native recursion. A recursive
// function is written as a generator that yields the task it would call and
// gets the task's result back from the yield:
//
//   function* depth(n: Node): Task<number> {
//     let d = 0;
//     for (const c of n.children) d = Math.max(d, (yield depth(c)) as number);
//     return d + 1;
//   }
//   run(depth(root));
//
// run() keeps the pending tasks in an array, so the nesting is limited by
// memory, not by the stack. An exception in a task is thrown into the task
// that waits for it, at its yield, just as a call would throw it.

export type Task<T> = Generator<Task<unknown>, T, unknown>;

export function run<T>(task: Task<T>): T {
  const stack: Task<unknown>[] = [task];
  let value: unknown;
  let error: unknown;
  let failed = false;
  for (;;) {
    const top = stack[stack.length - 1];
    let step: IteratorResult<Task<unknown>, unknown>;
    try {
      step = failed ? top.throw(error) : top.next(value);
    } catch (e) {
      stack.pop();
      if (stack.length === 0) throw e;
      failed = true;
      error = e;
      value = undefined;
      continue;
    }
    failed = false;
    error = undefined;
    if (step.done) {
      stack.pop();
      if (stack.length === 0) return step.value as T;
      value = step.value;
    } else {
      stack.push(step.value);
      value = undefined;
    }
  }
}
