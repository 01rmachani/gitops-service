const { v4: uuidv4 } = require('uuid');
const { githubApi, repoPath } = require('./api');
const { ensureProject } = require('./ensure-project');
const { readDirFiles } = require('./read-dir-files');

/**
 * Create a feat/<name|uuid> branch under a project's dev branch,
 * push files, and open a PR to {project}-dev.
 *
 * Branch hierarchy (all idempotently created):
 *   main → {project}-master → {project}-dev → feat/<feat_name|uuid>
 *
 * @param {object} opts
 * @param {string}   opts.project                  - Project identifier (e.g. 'proj-a')
 * @param {string}   opts.dir                      - Absolute path to directory; its contents are pushed
 * @param {string}   [opts.description]            - PR title / description
 * @param {string}   [opts.feat_name]              - Optional branch suffix; defaults to UUID
 * @param {string[]} [opts.labels=[]]              - Extra labels beyond 'automated'
 * @param {string}   [opts.source]                 - Identifier of calling service
 * @returns {Promise<{feat_id, branch, pr_number, pr_url, project, dev_branch}>}
 */
async function createFeatBranch({ project, dir, description, feat_name, labels = [], source }) {
  if (!project) throw new Error('project is required');
  if (!dir) throw new Error('dir is required');

  const files = readDirFiles(dir);
  if (!files.length) throw new Error(`No files found in directory: ${dir}`);

  const repo = repoPath();

  // Ensure project branch hierarchy exists (idempotent bootstrap)
  const { devBranch } = await ensureProject(project);

  const featId = feat_name
    ? feat_name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()
    : uuidv4();
  const branch = `feat/${featId}`;

  // Get dev branch SHA
  const baseRef = await githubApi(`${repo}/git/ref/heads/${devBranch}`);
  const baseSha = baseRef.object.sha;

  // Create feat branch off project-dev
  try {
    await githubApi(`${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      }),
    });
  } catch (err) {
    if (err.status !== 422) throw err;
    // Branch already exists (e.g. re-push with same feat_name) — continue
    console.warn(`[create-feat-branch] Branch ${branch} already exists — pushing files onto it`);
  }

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

  // Check if a PR already exists for this branch
  const existingPRs = await githubApi(
    `${repo}/pulls?head=${encodeURIComponent(`${process.env.GH_OWNER}:${branch}`)}&base=${devBranch}&state=open`
  );

  let pr;
  if (existingPRs.length > 0) {
    pr = existingPRs[0];
    console.log(`[create-feat-branch] PR already exists: #${pr.number}`);
  } else {
    const prBody = [
      description || 'Automated push from external service',
      source ? `\n**Source:** ${source}` : '',
      `\n**Project:** \`${project}\``,
      `\n**Feat ID:** \`${featId}\``,
      `\n**Directory:** \`${dir}\``,
      `\n**Files pushed:** ${files.map(f => `\`${f.path}\``).join(', ')}`,
    ].filter(Boolean).join('');

    pr = await githubApi(`${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: description || `feat(${project}): ${featId.slice(0, 8)}`,
        head: branch,
        base: devBranch,
        body: prBody,
      }),
    });

    // Add labels — always include 'automated'; non-fatal on failure
    const allLabels = ['automated', project, ...labels].filter(Boolean);
    await githubApi(`${repo}/issues/${pr.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: allLabels }),
    }).catch(err => console.warn(`[create-feat-branch] label error PR#${pr.number}: ${err.message}`));
  }

  return {
    feat_id: featId,
    branch,
    project,
    dev_branch: devBranch,
    pr_number: pr.number,
    pr_url: pr.html_url,
  };
}

module.exports = { createFeatBranch };
