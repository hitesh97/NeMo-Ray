#!/usr/bin/env bash
# Stop the whole NeMo-Ray stack started by spark/up.sh. Removes the NIM container and
# kills the twin / agent / HUD processes. Safe to run when some are already stopped.
#
#   bash spark/down.sh
set -euo pipefail

echo "==> Stopping Nemotron NIM container"
docker rm -f nemoray-nemotron 2>/dev/null && echo "  removed nemoray-nemotron" || echo "  (no container)"

kill_match() { # <label> <pgrep-pattern>
  local label="$1" pat="$2" pids
  pids="$(pgrep -f "$pat" 2>/dev/null || true)"
  if [ -n "$pids" ]; then echo "  killing $label ($pids)"; kill $pids 2>/dev/null || true; else echo "  (no $label)"; fi
}

echo "==> Stopping twin / agent / HUD"
kill_match "twin"  "src\.serve"
kill_match "agent" "uvicorn nemoray_modelling.server"
kill_match "HUD"   "next(-server)? dev|pnpm.*dev"

echo "==> Done. (Verify: docker ps ; ss -ltnp | grep -E ':(8000|8001|8080|3000)')"
