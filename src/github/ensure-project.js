const fs = require('fs');
const path = require('path');
const { githubApi, repoPath } = require('./api');
const { ensureBranch } = require('./ensure-branch');

const PROJECTS_DIR = path.resolve(__dirname, '../../projects');
const DEFAULT_WORKFLOWS_DIR = path.join(PROJECTS_DIR, '_default', 'workflows');
const AGENTS_DIR = path.resolve(__dirname, '../../agents/code-review');

/**
 * Return all files to bootstrap onto {project}-master:
 *   - .github/workflows/*.yml  (project-specific or _default)
 *   - .github/scripts/review.js  (code review agent — bundled, no external dep)
 *   - .github/scripts/prompt.md  (review prompt)
 *
 * @param {string} project
 * @returns {Array<{path: string, content: string}>}
 */
function getBootstrapFiles(project) {
  const projectWorkflowsDir = path.join(PROJECTS_DIR, project, 'workflows');
  const workflowsDir = fs.existsSync(projectWorkflowsDir)
    ? projectWorkflowsDir
    : DEFAULT_WORKFLOWS_DIR;

  const workflowFiles = fs.readdirSync(workflowsDir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(f => ({
      path: `.github/workflows/${f}`,
      content: fs.readFileSync(path.join(workflowsDir, f), 'utf8'),
    }));

  const agentFiles = ['review.js', 'prompt.md']
    .filter(f => fs.existsSync(path.join(AGENTS_DIR, f)))
    .map(f => ({
      path: `.github/scripts/${f}`,
      content: fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'),
    }));

  return [...workflowFiles, ...agentFiles];
}

/**
 * Ensure a project's branch hierarchy exists and is bootstrapped.
 *
 * Creates (idempotently):
 *   1. {project}-master  — forked from main
 *   2. .github/workflows/ committed onto {project}-master (first time only)
 *   3. {project}-dev     — forked from {project}-master
 *
 * @param {string} project  - Project identifier (e.g. 'proj-a')
 * @returns {Promise<{masterBranch: string, devBranch: string}>}
 */
async function ensureProject(project) {
  if (!project || !/^[a-zA-Z0-9_-]+$/.test(project)) {
    throw new Error(`Invalid project name: "${project}". Use only letters, numbers, hyphens, underscores.`);
  }

  const repo = repoPath();
  const masterBranch = `${project}-master`;
  const devBranch = `${project}-dev`;

  // 1. Ensure {project}-master exists (fork from main)
  await ensureBranchTracked(masterBranch, 'main');

  // 2. Bootstrap workflows + review agent onto {project}-master (idempotent upsert).
  //    Runs every time so partial bootstraps are always completed.
  console.log(`[ensure-project] Bootstrapping files onto ${masterBranch}`);
  const bootstrapFiles = getBootstrapFiles(project);

  for (const file of bootstrapFiles) {
    let existingSha;
    try {
      const existing = await githubApi(`${repo}/contents/${file.path}?ref=${masterBranch}`);
      existingSha = existing.sha;
    } catch (_) { /* new file */ }

    const newContent = Buffer.from(file.content).toString('base64');

    // Skip if content is identical (avoid noisy commits)
    if (existingSha) {
      const existingContent = (await githubApi(`${repo}/contents/${file.path}?ref=${masterBranch}`)).content
        .replace(/\n/g, '');
      if (existingContent === newContent.replace(/\n/g, '')) {
        continue;
      }
    }

    const body = {
      message: `chore(gitops): bootstrap ${file.path} for project ${project}`,
      content: newContent,
      branch: masterBranch,
    };
    if (existingSha) body.sha = existingSha;

    await githubApi(`${repo}/contents/${file.path}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }
  console.log(`[ensure-project] Bootstrap complete for ${masterBranch}`);

  // 3. Ensure {project}-dev exists (fork from {project}-master)
  await ensureBranch(devBranch, masterBranch);

  return { masterBranch, devBranch };
}

/**
 * Like ensureBranch but returns true if the branch was newly created,
 * false if it already existed.
 *
 * @param {string} branch
 * @param {string} sourceBranch
 * @returns {Promise<boolean>} true = newly created
 */
async function ensureBranchTracked(branch, sourceBranch) {
  const repo = repoPath();

  try {
    await githubApi(`${repo}/git/ref/heads/${branch}`);
    return false; // already exists
  } catch (err) {
    if (err.status !== 404) throw err;

    const sourceRef = await githubApi(`${repo}/git/ref/heads/${sourceBranch}`);
    const sha = sourceRef.object.sha;

    try {
      await githubApi(`${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      });
      return true; // newly created
    } catch (createErr) {
      if (createErr.status !== 422) throw createErr;
      return false; // concurrent creation — already exists
    }
  }
}

module.exports = { ensureProject };
