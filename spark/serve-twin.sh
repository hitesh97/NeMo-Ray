#!/usr/bin/env bash
# The coverage twin backend the agent drives: `python -m src.serve` on :8000 (TWIN_URL).
# Serves the /api/{coverage,optimize,rays,restore,emergency,route,history}
# contract. Re-simulates affected tiles on demand (lazy Sionna import), so it reuses the
# Sionna .venv. Leave running in its own terminal (or use spark/up.sh).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }

PY="$REPO_ROOT/.venv/bin/python"
[ -x "$PY" ] || { echo "No .venv — run spark/setup.sh first." >&2; exit 1; }

exec "$PY" -m src.serve
