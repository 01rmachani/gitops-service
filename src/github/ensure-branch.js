const { githubApi, repoPath } = require('./api');

/**
 * Ensure a branch exists. If missing, creates it from sourceBranch.
 * Safe to call concurrently — handles 422 (already exists) gracefully.
 *
 * @param {string} branch       - Branch to ensure exists (e.g. 'dev')
 * @param {string} sourceBranch - Branch to fork from if missing (e.g. 'main')
 */
async function ensureBranch(branch, sourceBranch = 'main') {
  const repo = repoPath();

  try {
    await githubApi(`${repo}/git/ref/heads/${branch}`);
    // Branch already exists — nothing to do
  } catch (err) {
    if (err.status !== 404) throw err;

    // Branch missing — get source SHA and create
    const sourceRef = await githubApi(`${repo}/git/ref/heads/${sourceBranch}`);
    const sha = sourceRef.object.sha;

    try {
      await githubApi(`${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      });
    } catch (createErr) {
      // 422 = branch was created by a concurrent request — that's fine
      if (createErr.status !== 422) throw createErr;
    }
  }
}

module.exports = { ensureBranch };
