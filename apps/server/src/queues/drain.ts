import type Queue from 'queue';

/**
 * Resolve once a queue has no queued OR running jobs (`queue.length`
 * counts both). Used by the test harness to quiesce fire-and-forget DB
 * writers (activity log, logins) before truncating tables — a job that
 * outlives its test otherwise races the next test's TRUNCATE and
 * produces deadlocks / duplicate-key seed collisions.
 *
 * `capMs` bounds the wait: a wedged job (each queue already has a 3s
 * job timeout) must not hang the caller forever.
 */
const drainQueue = (queue: Queue, capMs = 4000): Promise<void> => {
  if (queue.length === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      queue.removeEventListener('end', onEnd);
      clearTimeout(cap);
      resolve();
    };
    const onEnd = () => finish();
    const cap = setTimeout(finish, capMs);
    queue.addEventListener('end', onEnd);
    // Re-check after subscribing — the queue may have emptied between
    // the length check and addEventListener (the 'end' event would
    // already have fired).
    if (queue.length === 0) finish();
  });
};

export { drainQueue };
