#!/usr/bin/env bash
# Nemotron NIM via vLLM NVFP4 (Docker) on :8080 — thin wrapper over the repo's canonical
# scripts/serve_nemotron.sh, which is ALREADY tuned for the DGX Spark (GB10, unified memory).
#
# Default profile is 'super' (120B-A12B NVFP4, ~78 GB): the strongest reasoning model, it
# owns most of the 128 GB unified pool — so bring it up AFTER the pipeline has written its
# artifacts and don't run heavy Sionna solves alongside it.
# 'nano' (30B-A3B NVFP4, ~42 GB at gpu-mem-util 0.35) is the lighter alternative that
# co-exists with the Sionna twin + a live solve in the unified pool.
#
#   bash spark/serve-nemotron.sh                       # super (120B) on :8080 — uses most of the box
#   MODEL_PROFILE=nano bash spark/serve-nemotron.sh    # 30B — co-resident with a live solve
#   DROP_CACHES=1 bash spark/serve-nemotron.sh         # free the page cache first (needs sudo)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# Source the root .env so HF_CACHE / NEMOTRON_MODEL reach scripts/serve_nemotron.sh.
[ -f .env ] && { set -a; . .env; set +a; }
# DETACH=1 → `docker run -d` (no `-it`), so it works headless / over SSH without a TTY.
# Container logs: `docker logs -f nemoray-nemotron`.
exec env DETACH="${DETACH:-1}" MODEL_PROFILE="${MODEL_PROFILE:-super}" PORT="${PORT:-8080}" \
  DROP_CACHES="${DROP_CACHES:-0}" \
  bash scripts/serve_nemotron.sh
