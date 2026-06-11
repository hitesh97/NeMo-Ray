#!/usr/bin/env bash
# Nemotron agent SSE bridge (agent/) on :8001 — the HUD POSTs /agent here.
# It drives the twin over TWIN_URL (:8000) and reasons with Nemotron over
# NEMOTRON_BASE_URL (:8080). Needs serve-twin.sh and serve-nemotron.sh running.
#
#   bash spark/serve-agent.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }

export TWIN_URL="${TWIN_URL:-http://localhost:8000}"
export NEMOTRON_BASE_URL="${NEMOTRON_BASE_URL:-http://localhost:8080}"
export NEMOTRON_MODEL="${NEMOTRON_MODEL:-nemotron-3-super}"

# uv is installed to ~/.local/bin, which isn't on a non-login SSH PATH.
export PATH="$HOME/.local/bin:$PATH"

cd "$REPO_ROOT/agent"
exec uv run uvicorn nemoray_modelling.server:app \
  --host 0.0.0.0 --port "${AGENT_PORT:-8001}"
