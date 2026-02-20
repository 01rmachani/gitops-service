#!/usr/bin/env bash
# install.sh — one-command setup for gitops-service
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/01rmachani/gitops-service/main/install.sh)

set -euo pipefail

REPO_URL="https://github.com/01rmachani/gitops-service.git"
INSTALL_DIR="${GITOPS_DIR:-gitops-service}"

echo ""
echo "  ██████╗ ██╗████████╗ ██████╗ ██████╗ ███████╗"
echo "  ██╔════╝ ██║╚══██╔══╝██╔═══██╗██╔══██╗██╔════╝"
echo "  ██║  ███╗██║   ██║   ██║   ██║██████╔╝███████╗"
echo "  ██║   ██║██║   ██║   ██║   ██║██╔═══╝ ╚════██║"
echo "  ╚██████╔╝██║   ██║   ╚██████╔╝██║     ███████║"
echo "   ╚═════╝ ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚══════╝"
echo "  gitops-service installer"
echo ""

# ── Dependency checks ────────────────────────────────────────────────────────
need() { command -v "$1" &>/dev/null || { echo "ERROR: '$1' is required but not found."; exit 1; }; }
need git
need docker

# ── Clone ────────────────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Directory '$INSTALL_DIR' already exists — pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "→ Cloning into '$INSTALL_DIR'..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── .env setup ───────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  ✔ Created .env from .env.example"
  echo ""
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  Edit .env and fill in the required values:         │"
  echo "  │                                                     │"
  echo "  │    API_KEY      — shared secret for HTTP auth       │"
  echo "  │    GH_TOKEN     — GitHub PAT (repo + workflow)      │"
  echo "  │    GH_OWNER     — GitHub org or username            │"
  echo "  │    GH_REPO      — target repository name            │"
  echo "  │    INCOMING_DIR — host path to mount read-only      │"
  echo "  └─────────────────────────────────────────────────────┘"
  echo ""
  read -rp "  Open .env in your editor now? [Y/n] " OPEN_ENV
  if [[ "${OPEN_ENV:-Y}" =~ ^[Yy]$ ]]; then
    "${EDITOR:-vi}" .env
  fi
else
  echo "  ✔ .env already exists — skipping"
fi

# ── Docker Compose up ────────────────────────────────────────────────────────
echo ""
echo "→ Building and starting gitops-service..."
docker compose up -d --build

# ── Health check ─────────────────────────────────────────────────────────────
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "3000")
PORT="${PORT:-3000}"

echo ""
echo "→ Waiting for service to be healthy..."
for i in $(seq 1 15); do
  if curl -sf "http://localhost:${PORT}/ping" >/dev/null 2>&1; then
    echo ""
    echo "  ✔ gitops-service is up!"
    echo ""
    curl -s "http://localhost:${PORT}/ping" | python3 -m json.tool 2>/dev/null || \
      curl -s "http://localhost:${PORT}/ping"
    echo ""
    break
  fi
  sleep 1
  if [ "$i" -eq 15 ]; then
    echo "  ✘ Service did not respond after 15s — check: docker compose logs"
  fi
done

echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  Next steps:                                        │"
echo "  │                                                     │"
echo "  │  1. Add GitHub repo secrets (Actions → Secrets):   │"
echo "  │       OPENROUTER_API_KEY  — for AI code review      │"
echo "  │       GITOPS_API_KEY      — for issue-to-branch     │"
echo "  │                                                     │"
echo "  │  2. Add GitHub repo variables (Actions → Variables):│"
echo "  │       GITOPS_URL          — http://your-host:PORT   │"
echo "  │                                                     │"
echo "  │  3. Create labels in your target repo:              │"
echo "  │       gh label create \"automated\"       --color 0075ca │"
echo "  │       gh label create \"human-review-required\" --color e4e669 │"
echo "  │       gh label create \"gitops-push\"     --color 5319e7 │"
echo "  │                                                     │"
echo "  │  4. Push your first branch:                         │"
echo "  │       curl -X POST http://localhost:${PORT}/push/sync \\"
echo "  │         -H \"x-api-key: YOUR_API_KEY\" \\"
echo "  │         -H \"Content-Type: application/json\" \\"
echo "  │         -d '{\"project\":\"demo\",\"dir\":\"/mnt/incoming/demo\"}' │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
