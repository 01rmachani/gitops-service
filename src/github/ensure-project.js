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
 *   1. {project}-master  — orphan branch (NO files from main, isolated root)
 *   2. .github/workflows/ + .github/scripts/ committed onto {project}-master
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

  // 1. Ensure {project}-master exists as an orphan branch with bootstrap files
  const masterIsNew = await ensureOrphanBranch(masterBranch, project);
  console.log(`[ensure-project] ${masterBranch} ${masterIsNew ? 'created (new orphan)' : 'already exists'}`);

  // 2. If branch already existed, apply any updated bootstrap files (idempotent upsert)
  if (!masterIsNew) {
    await upsertBootstrapFiles(masterBranch, project);
  }

  // 3. Ensure {project}-dev exists (fork from {project}-master)
  await ensureBranch(devBranch, masterBranch);

  return { masterBranch, devBranch };
}

/**
 * Create an orphan branch with all bootstrap files committed atomically.
 * Uses the low-level Git Data API:
 *   1. Create a blob for each file
 *   2. Build a tree from all blobs (no base_tree → clean root)
 *   3. Create a root commit (parents: [])
 *   4. Create the branch ref
 *
 * Returns true if newly created, false if branch already existed.
 *
 * @param {string} branch
 * @param {string} project
 * @returns {Promise<boolean>}
 */
async function ensureOrphanBranch(branch, project) {
  const repo = repoPath();

  // Check if branch already exists
  try {
    await githubApi(`${repo}/git/ref/heads/${branch}`);
    return false;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  const bootstrapFiles = getBootstrapFiles(project);

  // Create a blob for each file
  const treeEntries = await Promise.all(bootstrapFiles.map(async (file) => {
    const blob = await githubApi(`${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content: file.content,
        encoding: 'utf-8',
      }),
    });
    return {
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    };
  }));

  // Build tree from blobs (no base_tree = clean root with only these files)
  const tree = await githubApi(`${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: treeEntries }),
  });

  // Create root commit (no parents)
  const commit = await githubApi(`${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `chore(gitops): bootstrap ${branch}`,
      tree: tree.sha,
      parents: [],
    }),
  });

  // Create branch ref
  try {
    await githubApi(`${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
    console.log(`[ensure-project] Bootstrapped ${bootstrapFiles.length} file(s) onto ${branch}`);
    return true;
  } catch (createErr) {
    if (createErr.status !== 422) throw createErr;
    return false;
  }
}

/**
 * Upsert bootstrap files onto an existing branch using the Contents API.
 * Skips files whose content is already identical.
 *
 * @param {string} branch
 * @param {string} project
 */
async function upsertBootstrapFiles(branch, project) {
  const repo = repoPath();
  const bootstrapFiles = getBootstrapFiles(project);
  let updated = 0;

  for (const file of bootstrapFiles) {
    let existingSha;
    let existingContent;
    try {
      const existing = await githubApi(`${repo}/contents/${file.path}?ref=${branch}`);
      existingSha = existing.sha;
      existingContent = existing.content.replace(/\n/g, '');
    } catch (_) { /* new file */ }

    const newContent = Buffer.from(file.content).toString('base64');

    if (existingSha && existingContent === newContent.replace(/\n/g, '')) {
      continue; // identical — skip
    }

    const body = {
      message: `chore(gitops): update ${file.path} for project ${project}`,
      content: newContent,
      branch,
    };
    if (existingSha) body.sha = existingSha;

    await githubApi(`${repo}/contents/${file.path}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    updated++;
  }

  if (updated > 0) {
    console.log(`[ensure-project] Updated ${updated} file(s) on ${branch}`);
  } else {
    console.log(`[ensure-project] All bootstrap files up-to-date on ${branch}`);
  }
}

module.exports = { ensureProject };
