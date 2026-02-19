const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('push-queue', () => {
  it('processes tasks up to concurrency limit', async () => {
    // Temporarily override concurrency for test
    process.env.PUSH_QUEUE_CONCURRENCY = '2';
    const { enqueue, stats } = require('../src/queue/push-queue');

    const results = await Promise.all([
      enqueue(() => Promise.resolve(1)),
      enqueue(() => Promise.resolve(2)),
      enqueue(() => Promise.resolve(3)),
    ]);

    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(stats().active, 0);
  });
});

describe('create-feat-branch input validation', () => {
  it('rejects empty files array', async () => {
    const { createFeatBranch } = require('../src/github/create-feat-branch');
    await assert.rejects(
      () => createFeatBranch({ description: 'test', files: [] }),
      /No files provided/
    );
  });
});
