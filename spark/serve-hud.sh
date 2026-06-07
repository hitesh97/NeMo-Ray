#!/usr/bin/env bash
# Run the Next.js HUD on the DGX Spark, wired to the agent SSE bridge. Reads the coverage
# artifacts already in nemoray/public/raytracing/ (from the solve) and proxies the agent to
# serve-agent.sh on :8001. It's all local — just open http://localhost:3000.
#
#   bash spark/serve-hud.sh        # installs node/pnpm if needed, then `pnpm dev`
#
# Viewing from another machine on the LAN (it binds 0.0.0.0):
#   ssh -L 3000:localhost:3000 <spark-host>     # then open localhost:3000 on the laptop
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }

have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Next.js 16 + pnpm 11 (node:sqlite) need Node 22+. DGX OS is Ubuntu (aarch64); NodeSource
# ships arm64 builds. Install if missing/too old.
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/' || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "==> Installing Node 22 (current: ${NODE_MAJOR:-none})"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi
# corepack ships with node but needs sudo to write the pnpm shim into the global prefix;
# fall back to a global npm install if corepack can't reach the registry.
have pnpm || { $SUDO corepack enable 2>/dev/null && $SUDO corepack prepare pnpm@latest --activate 2>/dev/null; } || $SUDO npm i -g pnpm

cd "$REPO_ROOT/nemoray"
echo "==> pnpm install"
pnpm install

# The HUD proxies its /api/agent to the agent SSE bridge (:8001).
export NEXT_PUBLIC_USE_MOCK="${NEXT_PUBLIC_USE_MOCK:-false}"
export NEXT_PUBLIC_API_BASE="${NEXT_PUBLIC_API_BASE:-http://localhost:${AGENT_PORT:-8001}}"
echo "==> Next.js HUD on 0.0.0.0:3000 (API_BASE=$NEXT_PUBLIC_API_BASE) — open http://localhost:3000"
exec pnpm dev -- -H 0.0.0.0 -p 3000
