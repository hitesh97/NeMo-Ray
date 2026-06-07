#!/usr/bin/env bash
# Nemotron NIM via vLLM NVFP4 (Docker) on :8080 — thin wrapper over the repo's canonical
# scripts/serve_nemotron.sh, which is ALREADY tuned for the DGX Spark (GB10, unified memory).
#
# Default profile is 'nano' (30B-A3B NVFP4, ~42 GB at gpu-mem-util 0.35): it co-exists with
# the Sionna twin + a live solve in the 128 GB unified pool — the right default for the demo.
# 'super' (120B-A12B NVFP4) loads in ~78 GB and owns most of the box, so don't run heavy
# solves alongside it; bring it up after the pipeline has written its artifacts.
#
#   bash spark/serve-nemotron.sh                       # nano on :8080 (co-resident, recommended)
#   MODEL_PROFILE=super bash spark/serve-nemotron.sh   # 120B — uses most of the box
#   DROP_CACHES=1 bash spark/serve-nemotron.sh         # free the page cache first (needs sudo)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# Source the root .env so HF_CACHE / NEMOTRON_MODEL reach scripts/serve_nemotron.sh.
[ -f .env ] && { set -a; . .env; set +a; }
# DETACH=1 → `docker run -d` (no `-it`), so it works headless / over SSH without a TTY.
# Container logs: `docker logs -f nemoray-nemotron`.
exec env DETACH="${DETACH:-1}" MODEL_PROFILE="${MODEL_PROFILE:-nano}" PORT="${PORT:-8080}" \
  DROP_CACHES="${DROP_CACHES:-0}" \
  bash scripts/serve_nemotron.sh
