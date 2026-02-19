const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { enqueue, stats } = require('../src/queue/push-queue');

// ---------------------------------------------------------------------------
// validateDir — inline the pure function so we can test it without booting
// the full server (which calls process.exit on missing env vars).
// ---------------------------------------------------------------------------
function makeValidateDir(incomingDir) {
  const base = path.resolve(incomingDir);
  return function validateDir(dir) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw Object.assign(
        new Error(`dir must be inside ${base}`),
        { status: 400 }
      );
    }
    return resolved;
  };
}

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

describe('validateDir (path traversal protection)', () => {
  const validateDir = makeValidateDir('/mnt/incoming');

  it('accepts a valid subdirectory', () => {
    const result = validateDir('/mnt/incoming/proj-a/output');
    assert.equal(result, '/mnt/incoming/proj-a/output');
  });

  it('accepts the base INCOMING_DIR itself', () => {
    const result = validateDir('/mnt/incoming');
    assert.equal(result, '/mnt/incoming');
  });

  it('rejects a path outside INCOMING_DIR (root)', () => {
    assert.throws(
      () => validateDir('/'),
      /dir must be inside/
    );
  });

  it('rejects a sibling directory attack', () => {
    assert.throws(
      () => validateDir('/mnt/other'),
      /dir must be inside/
    );
  });

  it('rejects traversal via .. segments', () => {
    assert.throws(
      () => validateDir('/mnt/incoming/../../../etc/passwd'),
      /dir must be inside/
    );
  });

  it('rejects a path that is a prefix but not a child (e.g. /mnt/incoming-evil)', () => {
    assert.throws(
      () => validateDir('/mnt/incoming-evil/proj'),
      /dir must be inside/
    );
  });
});
