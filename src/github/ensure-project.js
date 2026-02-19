const fs = require('fs');
const path = require('path');
const { githubApi, repoPath } = require('./api');
const { ensureBranch } = require('./ensure-branch');

const PROJECTS_DIR = path.resolve(__dirname, '../../projects');
const DEFAULT_WORKFLOWS_DIR = path.join(PROJECTS_DIR, '_default', 'workflows');

/**
 * Return the workflow files for a project.
 * Uses projects/<project>/workflows/ if it exists, otherwise falls back to
 * projects/_default/workflows/.
 *
 * @param {string} project
 * @returns {Array<{path: string, content: string}>}
 */
function getWorkflowFiles(project) {
  const projectWorkflowsDir = path.join(PROJECTS_DIR, project, 'workflows');
  const dir = fs.existsSync(projectWorkflowsDir)
    ? projectWorkflowsDir
    : DEFAULT_WORKFLOWS_DIR;

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(f => ({
      path: `.github/workflows/${f}`,
      content: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
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
  const masterIsNew = await ensureBranchTracked(masterBranch, 'main');

  // 2. Bootstrap workflows onto {project}-master (only if branch was just created)
  if (masterIsNew) {
    console.log(`[ensure-project] Bootstrapping workflows onto ${masterBranch}`);
    const workflowFiles = getWorkflowFiles(project);

    for (const file of workflowFiles) {
      await githubApi(`${repo}/contents/${file.path}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `chore(gitops): bootstrap ${file.path} for project ${project}`,
          content: Buffer.from(file.content).toString('base64'),
          branch: masterBranch,
        }),
      });
    }
    console.log(`[ensure-project] Bootstrapped ${workflowFiles.length} workflow(s) onto ${masterBranch}`);
  }

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
