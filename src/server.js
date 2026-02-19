require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { auth } = require('./middleware/auth');
const { createFeatBranch } = require('./github/create-feat-branch');
const { ensureProject } = require('./github/ensure-project');
const { enqueue, stats } = require('./queue/push-queue');

// Fail fast — catch misconfiguration before accepting any traffic
const REQUIRED_ENV = ['API_KEY', 'GH_TOKEN', 'GH_OWNER', 'GH_REPO'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Resolve the allowed incoming directory once at startup
const INCOMING_DIR = path.resolve(process.env.INCOMING_DIR || '/mnt/incoming');

/**
 * Validate that a caller-supplied directory is inside INCOMING_DIR.
 * Prevents path traversal attacks (e.g. dir="/").
 *
 * @param {string} dir
 * @returns {string} resolved absolute path
 * @throws if dir is outside INCOMING_DIR
 */
function validateDir(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(INCOMING_DIR + path.sep) && resolved !== INCOMING_DIR) {
    throw Object.assign(
      new Error(`dir must be inside ${INCOMING_DIR}`),
      { status: 400 }
    );
  }
  return resolved;
}

const app = express();

app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch { /* leave as-is */ }
  }
  next();
});

// GET /ping - health check
app.get('/ping', (req, res) => {
  res.json({ ok: true, queue: stats() });
});

// All routes below require x-api-key auth
app.use(auth);

/**
 * POST /push
 *
 * Accepts code files from an external service, bootstraps the project branch
 * hierarchy if needed, creates a feat/<feat_name|uuid> branch off {project}-dev,
 * pushes the files, and opens a PR.
 *
 * Body:
 *   {
 *     project: string,               // required — project identifier (e.g. 'proj-a')
 *     dir: string,                   // required — absolute path to directory accessible by this service
 *     description?: string,          // PR title / description
 *     feat_name?: string,            // optional branch suffix; defaults to UUID
 *     labels?: string[],             // extra PR labels (always includes 'automated', project name)
 *     source?: string                // identifier of the calling service
 *   }
 *
 * Response: 202 { ok, message }
 */
app.post('/push', async (req, res) => {
  const { project, dir, description, feat_name, labels, source } = req.body;

  if (!project || typeof project !== 'string') {
    return res.status(400).json({ error: 'project is required and must be a string' });
  }
  if (!dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'dir is required and must be a string (absolute path to directory)' });
  }

  let safeDir;
  try {
    safeDir = validateDir(dir);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.status(202).json({ ok: true, message: 'Push queued' });

  enqueue(async () => {
    const result = await createFeatBranch({ project, dir: safeDir, description, feat_name, labels: labels || [], source });
    console.log(`[push] ${result.project} PR #${result.pr_number} created: ${result.pr_url}`);
    return result;
  }).catch(err => {
    console.error(`[push] Failed: ${err.message}`);
  });
});

/**
 * POST /push/sync
 *
 * Same as POST /push but waits for branch creation and returns the full result.
 * Use when the caller needs the PR URL immediately.
 *
 * Response: { feat_id, branch, project, dev_branch, pr_number, pr_url }
 */
app.post('/push/sync', async (req, res) => {
  const { project, dir, description, feat_name, labels, source } = req.body;

  if (!project || typeof project !== 'string') {
    return res.status(400).json({ error: 'project is required and must be a string' });
  }
  if (!dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'dir is required and must be a string (absolute path to directory)' });
  }

  let safeDir;
  try {
    safeDir = validateDir(dir);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await enqueue(() =>
      createFeatBranch({ project, dir: safeDir, description, feat_name, labels: labels || [], source })
    );
    res.json(result);
  } catch (err) {
    console.error(`[push/sync] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /projects/:project/bootstrap
 *
 * Explicitly (re-)bootstrap a project's branch hierarchy and workflow files.
 * Useful when:
 *   - Adding a new project before the first /push
 *   - Updating workflow templates after changing projects/_default/workflows/
 *   - Recovering from a partial bootstrap
 *
 * Response: { project, master_branch, dev_branch, files_bootstrapped }
 */
app.post('/projects/:project/bootstrap', async (req, res) => {
  const { project } = req.params;
  try {
    const result = await ensureProject(project);
    console.log(`[bootstrap] ${project} → ${result.masterBranch}, ${result.devBranch}`);
    res.json({
      ok: true,
      project,
      master_branch: result.masterBranch,
      dev_branch: result.devBranch,
    });
  } catch (err) {
    console.error(`[bootstrap] ${project}: ${err.message}`);
    res.status(err.message.includes('Invalid project') ? 400 : 500)
      .json({ error: err.message });
  }
});

// Error handler — no stack traces in responses
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`gitops-service listening on port ${PORT}`);
});
