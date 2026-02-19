/**
 * Concurrency-capped async queue for /push requests.
 *
 * Prevents GitHub API rate-limit bursts when many external services
 * call simultaneously. Requests beyond the concurrency cap are queued
 * in memory and processed as slots free up.
 */

const CONCURRENCY = parseInt(process.env.PUSH_QUEUE_CONCURRENCY || '5', 10);

let active = 0;
const waiting = [];

/**
 * Enqueue a task function. Returns a Promise that resolves/rejects
 * with the task's result once a concurrency slot is available.
 *
 * @param {() => Promise<any>} task - Async function to run
 * @returns {Promise<any>}
 */
function enqueue(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    drain();
  });
}

function drain() {
  while (active < CONCURRENCY && waiting.length > 0) {
    const { task, resolve, reject } = waiting.shift();
    active++;
    task()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        drain();
      });
  }
}

/**
 * Current queue stats — useful for health/debug endpoints.
 */
function stats() {
  return { active, queued: waiting.length, concurrency: CONCURRENCY };
}

module.exports = { enqueue, stats };
