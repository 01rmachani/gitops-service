const { v4: uuidv4 } = require('uuid');
const { githubApi, repoPath } = require('./api');
const { ensureBranch } = require('./ensure-branch');

/**
 * Create a feat/<uuid> branch, push files, open a PR to base_branch.
 *
 * @param {object} opts
 * @param {string}   opts.description              - PR title / description
 * @param {Array<{path:string, content:string}>} opts.files - Files to push (UTF-8 content)
 * @param {string}   [opts.base_branch='dev']      - Integration branch to PR into
 * @param {string[]} [opts.labels=[]]              - Extra labels beyond 'automated'
 * @param {string}   [opts.source]                 - Identifier of calling service
 * @returns {Promise<{feat_id, branch, pr_number, pr_url}>}
 */
async function createFeatBranch({ description, files = [], base_branch = 'dev', labels = [], source }) {
  if (!files.length) throw new Error('No files provided');

  const repo = repoPath();
  const featId = uuidv4();
  const branch = `feat/${featId}`;

  // Ensure integration branch exists (idempotent, forks from main if absent)
  await ensureBranch(base_branch, 'main');

  // Get base branch SHA
  const baseRef = await githubApi(`${repo}/git/ref/heads/${base_branch}`);
  const baseSha = baseRef.object.sha;

  // Create feat branch
  await githubApi(`${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    }),
  });

  // Push files sequentially — GitHub Contents API requires sequential writes per branch
  for (const file of files) {
    let existingSha;
    try {
      const existing = await githubApi(`${repo}/contents/${file.path}?ref=${branch}`);
      existingSha = existing.sha;
    } catch (_) {
      // New file — no existing SHA needed
    }

    const body = {
      message: `feat(${featId.slice(0, 8)}): add ${file.path}`,
      content: Buffer.from(file.content).toString('base64'),
      branch,
    };
    if (existingSha) body.sha = existingSha;

    await githubApi(`${repo}/contents/${file.path}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  // Build PR body
  const prBody = [
    description || 'Automated push from external service',
    source ? `\n**Source:** ${source}` : '',
    `\n**Feat ID:** \`${featId}\``,
    `\n**Files changed:** ${files.map(f => `\`${f.path}\``).join(', ')}`,
  ].filter(Boolean).join('');

  // Open PR
  const pr = await githubApi(`${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: description || `feat: automated push ${featId.slice(0, 8)}`,
      head: branch,
      base: base_branch,
      body: prBody,
    }),
  });

  // Add labels — always include 'automated'; non-fatal on failure
  const allLabels = ['automated', ...labels].filter(Boolean);
  await githubApi(`${repo}/issues/${pr.number}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: allLabels }),
  }).catch(err => console.warn(`[create-feat-branch] label error PR#${pr.number}: ${err.message}`));

  return {
    feat_id: featId,
    branch,
    pr_number: pr.number,
    pr_url: pr.html_url,
  };
}

module.exports = { createFeatBranch };
