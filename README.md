# gitops-service

A standalone Express service that manages a **single GitHub repo with multiple projects**. Each project gets its own branch hierarchy. External services push code via HTTP; the service creates feature branches, opens PRs, and triggers per-project CI + AI code review + auto-merge.

## Branch model

```
main                        ← gitops-service code only (never touched by pushes)
├── proj-a-master           ← auto-bootstrapped on first push for proj-a
│   └── proj-a-dev          ← integration branch (PR target)
│       └── feat/<name|uuid>  ← created per push, PR → proj-a-dev
├── proj-b-master
│   └── proj-b-dev
│       └── feat/<name|uuid>
```

On first push for a project, the service automatically:
1. Creates `{project}-master` from `main`
2. Commits `.github/workflows/` + `.github/scripts/review.js` onto `{project}-master`
3. Creates `{project}-dev` from `{project}-master`

## Flow

```
POST /push/sync
  │
  ├─ ensureProject(project)
  │    ├─ create {project}-master (from main, if new)
  │    ├─ bootstrap .github/workflows/ + .github/scripts/ (idempotent)
  │    └─ create {project}-dev (from {project}-master, if new)
  │
  ├─ create feat/<name|uuid> from {project}-dev
  ├─ push files from dir/
  └─ open PR → {project}-dev
       │
       GitHub Actions on {project}-master:
       ├─ CI (ci.yml)
       ├─ Code Review Agent (code-review.yml → .github/scripts/review.js)
       └─ Auto-merge or human-review-required label (feat-auto-merge.yml)
```

## API

**Auth:** `x-api-key` header required on all routes except `GET /ping`.

---

### `GET /ping`
Health check. Returns service metadata and queue stats.

```json
{
  "ok": true,
  "version": "1.0.0",
  "node": "v20.x.x",
  "uptime_s": 3600,
  "queue": { "active": 0, "queued": 0, "concurrency": 5 }
}
```

---

### `POST /push` — async (202)
Fire-and-forget. Returns immediately; work happens in background.
Returns **503** if the queue is full (depth ≥ `PUSH_QUEUE_MAX_DEPTH`).

### `POST /push/sync` — synchronous
Waits for branch + PR creation and returns the full result.
Returns **503** if the queue is full (depth ≥ `PUSH_QUEUE_MAX_DEPTH`).

**Body:**
```json
{
  "project": "proj-a",
  "dir": "/mnt/incoming/proj-a/output",
  "description": "Add authentication module",
  "feat_name": "add-auth",
  "labels": ["backend"],
  "source": "my-external-service"
}
```

| Field | Required | Description |
|---|---|---|
| `project` | ✅ | Project identifier — letters, numbers, hyphens, underscores |
| `dir` | ✅ | Absolute path to directory **inside `INCOMING_DIR`** (path traversal protection enforced). Contents pushed recursively; `.git/` and `node_modules/` skipped |
| `description` | — | PR title and body description |
| `feat_name` | — | Branch suffix: `feat/<feat_name>`. Defaults to UUID if omitted. Re-pushing with the same name updates files on the existing branch |
| `labels` | — | Extra PR labels. `automated` and `{project}` are always added |
| `source` | — | Identifier of the calling service (shown in PR body) |

**Response (`/push/sync`):**
```json
{
  "feat_id": "add-auth",
  "branch": "feat/add-auth",
  "project": "proj-a",
  "dev_branch": "proj-a-dev",
  "pr_number": 5,
  "pr_url": "https://github.com/owner/repo/pull/5"
}
```

---

### `POST /projects/:project/bootstrap`
Explicitly (re-)bootstrap a project's branch hierarchy and workflow files. Use this to:
- Pre-create a project before the first push
- Re-apply updated workflow templates to an existing project
- Recover from a partial bootstrap

```bash
curl -X POST http://localhost:3000/projects/proj-a/bootstrap \
  -H "x-api-key: <API_KEY>"
```

**Response:**
```json
{
  "ok": true,
  "project": "proj-a",
  "master_branch": "proj-a-master",
  "dev_branch": "proj-a-dev"
}
```

---

## GitHub Actions Workflows

Workflows are bootstrapped onto `{project}-master` and trigger on PRs from `feat/*` branches.

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | PR opened/updated | Runs project tests |
| `code-review.yml` | After CI completes (`conclusion == 'success'`) | LLM reviews diff via `.github/scripts/review.js`, posts comment. LLM and GitHub API calls have configurable timeouts. |
| `feat-auto-merge.yml` | After code review completes (`conclusion == 'success'`) | Squash-merges if all gates pass, else labels PR |
| `issue-to-branch.yml` | Issue labeled with `gitops-push` | Parses issue form body, calls `POST /push/sync`, comments PR link back on the issue |

All workflows use **concurrency groups** to cancel duplicate runs for the same branch or issue. All jobs have `timeout-minutes` set to prevent silent runner-minute drain.

### Auto-merge gates (all must pass)
1. Code Review workflow concluded with `success` (not errored/cancelled)
2. All CI checks green (no `failure`, `cancelled`, or `timed_out` conclusions)
3. No `human-review-required` label on the PR
4. `AUTO_MERGE` repo variable is not `false`
5. PR is `MERGEABLE` (no conflicts)

### Issue-to-branch workflow

Add the `gitops-push` label to any issue whose body follows this form structure:

```
### Project
proj-a

### Feature Name
add-auth

### Source Directory
/mnt/incoming/proj-a/output

### Description
Add authentication module

### Extra Labels (optional)
backend, security
```

The workflow parses the body, calls `POST /push/sync` on your gitops-service instance, and comments the resulting PR link back on the issue.

**Required repo secrets/variables for this workflow:**

| Name | Type | Description |
|---|---|---|
| `GITOPS_URL` | Variable | Base URL of your gitops-service, e.g. `http://my-server:3000` |
| `GITOPS_API_KEY` | Secret | The `API_KEY` value from your gitops-service `.env` |

### Per-project workflow customisation

```
projects/
├── _default/
│   └── workflows/          ← used for all projects unless overridden
│       ├── ci.yml
│       ├── code-review.yml
│       └── feat-auto-merge.yml
└── example-project/
    └── workflows/          ← overrides _default for 'example-project' only
        └── ci.yml          ← e.g. Python/pytest instead of Node
```

To customise a project's CI: add `projects/<project>/workflows/ci.yml` to `main`, then call `POST /projects/<project>/bootstrap` to push the updated workflows.

## Setup

### 1. Clone and install
```bash
git clone https://github.com/01rmachani/gitops-service
cd gitops-service
npm install
cp .env.example .env
# Fill in .env
```

### 2. GitHub repo secrets and variables

**Secrets** (Settings → Secrets → Actions):
- `OPENROUTER_API_KEY` — OpenRouter API key for the code review agent
- `GITOPS_API_KEY` — API key for `issue-to-branch.yml` to call your gitops-service instance

**Variables** (Settings → Variables → Actions):
- `AUTO_MERGE` — set to `false` to disable auto-merge globally (default: enabled)
- `REVIEW_MODEL` — LLM model override (default: `anthropic/claude-3.5-haiku`)
- `GITOPS_URL` — base URL of your gitops-service instance (required for `issue-to-branch.yml`)

### 3. Create labels
```bash
gh label create "automated"              --color "0075ca" --repo owner/repo
gh label create "human-review-required" --color "e4e669" --repo owner/repo
gh label create "gitops-push"            --color "5319e7" --repo owner/repo
```

The `gitops-push` label is required to trigger the `issue-to-branch.yml` workflow.

### 4. Run with Docker (recommended)
```bash
cp .env.example .env  # fill in values
docker compose up -d --build
```

### 5. Run without Docker
```bash
npm start        # production
npm run dev      # development (nodemon)
```

## Dependabot

A `.github/dependabot.yml` is included and runs weekly PRs for:
- **npm** — keeps Node.js dependencies up to date
- **github-actions** — keeps action versions pinned to latest

No configuration required; it activates automatically once the file is present in the default branch.

## Observability

All HTTP requests are logged as structured JSON with a unique `x-request-id` correlation ID:

```json
{"reqId":"uuid","method":"POST","path":"/push/sync","ip":"...","event":"request"}
{"reqId":"uuid","method":"POST","path":"/push/sync","ip":"...","event":"response","status":200,"ms":312}
```

Callers can pass their own `x-request-id` header and it will be echoed back in the response for end-to-end tracing.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_KEY` | ✅ | — | Auth key for external callers (`x-api-key` header) |
| `GH_TOKEN` | ✅ | — | GitHub PAT — needs `Contents: read/write`, `Pull requests: read/write`, `Workflows: read/write` |
| `GH_OWNER` | ✅ | — | GitHub org or username |
| `GH_REPO` | ✅ | — | Target repository name |
| `PUSH_QUEUE_CONCURRENCY` | — | `5` | Max parallel push operations |
| `PUSH_QUEUE_MAX_DEPTH` | — | `50` | Max queued requests waiting for a slot — returns 503 if exceeded |
| `PORT` | — | `3000` | Server port |
| `INCOMING_DIR` | — | `/mnt/incoming` | Allowed root for `dir` values. Any `dir` outside this path is rejected (path traversal protection) |
| `GH_API_TIMEOUT_MS` | — | `30000` | Timeout in ms for GitHub API calls (service + code-review agent) |
| `LLM_TIMEOUT_MS` | — | `120000` | Timeout in ms for OpenRouter LLM calls in the code-review agent |
