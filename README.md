# gitops-service

A standalone Express service that accepts code pushes from external services, creates `feat/` branches in a target GitHub repository, opens PRs to the `dev` integration branch, runs CI + AI code review, and auto-merges or flags for human review.

## Flow

```
External Service  →  POST /push  →  feat/<uuid> branch  →  PR to dev
                                                               │
                                          GitHub Actions: CI (pre-commit + tests)
                                                               │
                                          GitHub Actions: Code Review Agent (OpenRouter LLM)
                                                               │
                                          GitHub Actions: Auto-merge OR human-review-required label
```

## API

### `POST /push` (async, 202)
Fire-and-forget. Returns immediately; branch/PR creation happens in background.

### `POST /push/sync` (synchronous)
Waits for branch creation and returns the PR URL.

**Auth:** `x-api-key` header required on all routes except `GET /ping`.

**Body:**
```json
{
  "description": "Add user authentication module",
  "dir": "/mnt/shared/my-service/output",
  "base_branch": "dev",
  "labels": ["backend"],
  "source": "my-external-service"
}
```

`dir` must be an **absolute path** to a directory accessible by the gitops-service process.
All files and subdirectories inside `dir` are pushed recursively. The directory itself is not created in the repo — only its contents, preserving relative paths.

**Response (`/push/sync`):**
```json
{
  "feat_id": "uuid",
  "branch": "feat/uuid",
  "pr_number": 42,
  "pr_url": "https://github.com/owner/repo/pull/42"
}
```

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | PR opened/updated on `dev` from `feat/*` | Pre-commit hooks + placeholder tests |
| `code-review.yml` | After `CI` completes | LLM reviews diff, posts comment, sets label |
| `feat-auto-merge.yml` | After `Code Review Agent` completes | Squash-merges if all gates pass, else labels PR |

### Auto-merge gates (all must pass)
1. CI checks green
2. Code review outcome is `APPROVE` (no `human-review-required` label)
3. `AUTO_MERGE` repo var is not `false`
4. PR is `MERGEABLE` (no conflicts)

## Setup

### 1. Clone and install
```bash
git clone <this-repo>
cd gitops-service
npm install
cp .env.example .env
# Fill in .env
```

### 2. GitHub repo settings

**Secrets:**
- `OPENROUTER_API_KEY` — for the code review agent
- `GH_WEBHOOK_SECRET` — optional, for validating webhook calls

**Variables:**
- `AUTO_MERGE` — set to `false` to disable auto-merge (default: enabled)
- `REVIEW_MODEL` — optional LLM model override (default: `anthropic/claude-3.5-haiku`)

### 3. Create labels in target repo
```bash
gh label create "automated" --color "0075ca" --repo owner/repo
gh label create "human-review-required" --color "e4e669" --repo owner/repo
```

### 4. Run
```bash
npm start        # production
npm run dev      # development (nodemon)
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_KEY` | ✅ | — | Auth key for external callers |
| `GH_TOKEN` | ✅ | — | GitHub PAT (scopes: `repo`, `workflow`) |
| `GH_OWNER` | ✅ | — | GitHub org or user |
| `GH_REPO` | ✅ | — | Target repository name |
| `BASE_BRANCH` | — | `dev` | Integration branch for PRs |
| `PUSH_QUEUE_CONCURRENCY` | — | `5` | Max parallel push operations |
| `PORT` | — | `3000` | Server port |
