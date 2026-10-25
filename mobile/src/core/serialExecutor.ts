// One use-case at a time, start to finish (research R3). A FIFO queue of promises.
let tail: Promise<unknown> = Promise.resolve();

export function runSerial<T>(fn: () => Promise<T>): Promise<T> {
  const job = tail.then(fn, fn);
  tail = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}
