#!/usr/bin/env bash
# Bring the whole NeMo-Ray stack up on a Brev instance with one command — the cloud
# mirror of spark/up.sh. Nemotron is served BF16/FP8 (brev/serve-nemotron.sh); the
# twin, agent bridge and HUD reuse the shared launchers in spark/.
#
#   bash brev/up.sh            # nemotron (BF16, TP=all GPUs) + twin + agent
#   bash brev/up.sh --hud      # …also start the Next.js HUD on :3000
#   QUANT=fp8 bash brev/up.sh  # FP8 serving (fits 1x H200 / 2x H100)
#
# Stop everything with:  bash brev/down.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }

HUD=0
for a in "$@"; do case "$a" in
  --hud)   HUD=1 ;;
  *) echo "unknown arg: $a (use --hud)" >&2; exit 1 ;;
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

echo "==> Nemotron (vLLM, BF16/FP8) (:8080)"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx nemoray-nemotron; then
  echo "  container nemoray-nemotron already running — skipping"
else
  DETACH=1 bash brev/serve-nemotron.sh
fi

echo "==> Twin + agent"
launch 8000 twin  spark/serve-twin.sh
launch "${AGENT_PORT:-8001}" agent spark/serve-agent.sh
[ "$HUD" = 1 ] && { echo "==> HUD"; launch 3000 hud spark/serve-hud.sh; }

cat <<EOF

==> Stack launching. First run downloads the BF16 weights (~240 GB) — chat errors
    until vLLM is ready. Check readiness:
      curl -s localhost:8080/v1/models
      docker logs -f nemoray-nemotron
      tail -f $LOG_DIR/twin.log $LOG_DIR/agent.log$([ "$HUD" = 1 ] && echo " $LOG_DIR/hud.log")

    Stop everything:  bash brev/down.sh
EOF
