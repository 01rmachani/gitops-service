const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { enqueue, stats } = require('../src/queue/push-queue');

const tick = () => new Promise(r => setImmediate(r));

describe('push-queue', () => {
  it('processes tasks and returns results in order', async () => {
    const results = await Promise.all([
      enqueue(() => Promise.resolve(1)),
      enqueue(() => Promise.resolve(2)),
      enqueue(() => Promise.resolve(3)),
    ]);

    await tick(); // allow .finally() callbacks to decrement active
    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(stats().active, 0);
  });

  it('queue is idle after all tasks complete', async () => {
    await enqueue(() => Promise.resolve('done'));
    await tick();
    assert.equal(stats().active, 0);
    assert.equal(stats().queued, 0);
  });
});

describe('create-feat-branch input validation', () => {
  it('rejects missing project', async () => {
    const { createFeatBranch } = require('../src/github/create-feat-branch');
    await assert.rejects(
      () => createFeatBranch({ dir: '/tmp' }),
      /project is required/
    );
  });

  it('rejects missing dir', async () => {
    const { createFeatBranch } = require('../src/github/create-feat-branch');
    await assert.rejects(
      () => createFeatBranch({ project: 'proj-a' }),
      /dir is required/
    );
  });

  it('rejects invalid project name', async () => {
    const { ensureProject } = require('../src/github/ensure-project');
    await assert.rejects(
      () => ensureProject('proj a/bad!'),
      /Invalid project name/
    );
  });
});

describe('readDirFiles', () => {
  it('throws on non-existent directory', () => {
    const { readDirFiles } = require('../src/github/read-dir-files');
    assert.throws(
      () => readDirFiles('/tmp/does-not-exist-xyz'),
      /Directory not found/
    );
  });

  it('throws when path is a file not a directory', () => {
    const { readDirFiles } = require('../src/github/read-dir-files');
    assert.throws(
      () => readDirFiles('/etc/hostname'),
      /Path is not a directory/
    );
  });
});
