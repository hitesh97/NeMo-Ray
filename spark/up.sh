#!/usr/bin/env bash
# Bring the WHOLE NeMo-Ray stack up on the DGX Spark with one command. Starts each service
# detached, logging to $NEMORAY_LOG_DIR (default ~/nemoray-logs). Idempotent: skips a
# service whose port/container is already live.
#
#   bash spark/up.sh            # nemotron (nano) + twin + agent
#   bash spark/up.sh --hud      # …also start the Next.js HUD on :3000
#   bash spark/up.sh --super    # use the 120B 'super' profile instead of nano
#
# Stop everything with:  bash spark/down.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }

HUD=0
for a in "$@"; do case "$a" in
  --hud)   HUD=1 ;;
  --super) export MODEL_PROFILE=super; export NEMOTRON_MODEL="${NEMOTRON_MODEL:-nemotron-3-super}" ;;
  *) echo "unknown arg: $a (use --hud, --super)" >&2; exit 1 ;;
esac; done

LOG_DIR="${NEMORAY_LOG_DIR:-$HOME/nemoray-logs}"; mkdir -p "$LOG_DIR"
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&-; return 0; } || return 1; }
launch() { # <port> <name> <script...>
  local port="$1" name="$2"; shift 2
  if port_open "$port"; then echo "  $name already up on :$port — skipping"; return; fi
  echo "  starting $name (:$port) → $LOG_DIR/$name.log"
  nohup bash "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
}

echo "==> Sanity: coverage artifacts present?"
[ -f nemoray/public/raytracing/summary.json ] || \
  echo "  WARN: no nemoray/public/raytracing/summary.json — run 'bash spark/run-pipeline.sh' first." >&2

echo "==> Nemotron NIM (:8080)"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx nemoray-nemotron; then
  echo "  container nemoray-nemotron already running — skipping"
else
  bash spark/serve-nemotron.sh   # detached docker run -d; returns once the container starts
fi

echo "==> Twin + agent"
launch 8000 twin  spark/serve-twin.sh
launch "${AGENT_PORT:-8001}" agent spark/serve-agent.sh
[ "$HUD" = 1 ] && { echo "==> HUD"; launch 3000 hud spark/serve-hud.sh; }

cat <<EOF

==> Stack launching. The NIM downloads its NVFP4 weights on first run (minutes) — chat
    errors until it's ready. Check readiness:
      curl -s localhost:8080/v1/models           # NIM (weights loaded when the model lists)
      docker logs -f nemoray-nemotron            # NIM progress
      tail -f $LOG_DIR/twin.log $LOG_DIR/agent.log$([ "$HUD" = 1 ] && echo " $LOG_DIR/hud.log")

    Endpoints (all local):
      NIM    http://localhost:8080/v1/models
      twin   http://localhost:8000  (viewer at /viewer/)
      agent  http://localhost:${AGENT_PORT:-8001}
$([ "$HUD" = 1 ] && echo "      HUD    http://localhost:3000")

    Stop everything:  bash spark/down.sh
EOF
