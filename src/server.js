require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const { auth } = require('./middleware/auth');
const { createFeatBranch } = require('./github/create-feat-branch');
const { enqueue, stats } = require('./queue/push-queue');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// GET /ping - health check
app.get('/ping', (req, res) => {
  res.json({ ok: true, queue: stats() });
});

// All routes below require x-api-key auth
app.use(auth);

/**
 * POST /push
 *
 * Accepts code files from an external service, creates a feat/<uuid> branch
 * in the target GitHub repo, pushes the files, and opens a PR to dev.
 *
 * Body:
 *   {
 *     description: string,           // PR title / description
 *     dir: string,                   // absolute path to directory accessible by this service
 *     base_branch?: string,          // default: process.env.BASE_BRANCH || 'dev'
 *     labels?: string[],             // extra PR labels (always includes 'automated')
 *     source?: string                // identifier of the calling service
 *   }
 *
 * Response:
 *   { feat_id, branch, pr_number, pr_url }
 */
app.post('/push', async (req, res) => {
  const { description, dir, base_branch, labels, source } = req.body;

  if (!dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'dir is required and must be a string (absolute path to directory)' });
  }

  // Respond with 202 immediately so the caller isn't blocked waiting for
  // branch creation + file pushes + PR open (can take several seconds)
  res.status(202).json({ ok: true, message: 'Push queued' });

  // Enqueue the actual work — concurrency-capped, non-blocking to HTTP layer
  enqueue(async () => {
    const result = await createFeatBranch({
      description,
      dir,
      base_branch: base_branch || process.env.BASE_BRANCH || 'dev',
      labels: labels || [],
      source,
    });
    console.log(`[push] PR #${result.pr_number} created: ${result.pr_url}`);
    return result;
  }).catch(err => {
    console.error(`[push] Failed to create feat branch: ${err.message}`);
  });
});

/**
 * POST /push/sync
 *
 * Same as POST /push but waits for branch creation and returns the full result.
 * Use when the caller needs the PR URL immediately.
 */
app.post('/push/sync', async (req, res) => {
  const { description, dir, base_branch, labels, source } = req.body;

  if (!dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'dir is required and must be a string (absolute path to directory)' });
  }

  try {
    const result = await enqueue(() =>
      createFeatBranch({
        description,
        dir,
        base_branch: base_branch || process.env.BASE_BRANCH || 'dev',
        labels: labels || [],
        source,
      })
    );
    res.json(result);
  } catch (err) {
    console.error(`[push/sync] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
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
