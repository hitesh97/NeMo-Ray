#!/usr/bin/env bash
# Serve Nemotron-3 Super on a Brev x86 GPU instance — BF16 across however many GPUs the
# box has (tensor parallel), or on-the-fly FP8 (QUANT=fp8) to halve the VRAM on Hopper.
# No NVFP4 here: that precision needs Blackwell silicon (the DGX Spark path,
# scripts/serve_nemotron.sh). The served name stays `nemotron-3-super`, so the agent
# bridge and HUD need no changes.
#
#   bash brev/serve-nemotron.sh                 # BF16, TP = number of GPUs
#   QUANT=fp8 bash brev/serve-nemotron.sh       # ~half the VRAM (1x H200 / 2x H100)
#   TP=2 bash brev/serve-nemotron.sh            # override the GPU count
#
# Sizing: BF16 weights ~240 GB -> 2x H200 or 4x H100. FP8 ~120 GB -> 1x H200 / 2x H100.
# Verify readiness:  curl -s localhost:8080/v1/models
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }

PORT="${PORT:-8080}"
IMAGE="${IMAGE:-vllm/vllm-openai:v0.20.0}"
HF_CACHE="${HF_CACHE:-$HOME/.cache/huggingface}"
# The BF16 base checkpoint (the NVFP4 repo is its Blackwell quantisation).
MODEL="${MODEL:-nvidia/NVIDIA-Nemotron-3-Super-120B-A12B}"
SERVED_NAME="${SERVED_NAME:-nemotron-3-super}"
PARSER="super_v3"; PARSER_FILE="$REPO_ROOT/scripts/super_v3_reasoning_parser.py"
MAX_LEN="${MAX_LEN:-16384}"; MAX_SEQS="${MAX_SEQS:-4}"
TP="${TP:-$(nvidia-smi -L | wc -l)}"
QUANT="${QUANT:-}"                  # empty = BF16; fp8 = on-the-fly weight quant (Hopper)

echo "Serving $MODEL (as '$SERVED_NAME') on :$PORT — TP=$TP quant=${QUANT:-bf16}"
[ -f "$PARSER_FILE" ] || { echo "Missing $PARSER_FILE" >&2; exit 1; }
mkdir -p "$HF_CACHE"

NAME="${NAME:-nemoray-nemotron}"
if [[ "${DETACH:-1}" == "1" ]]; then RUN_FLAGS=(-d --name "$NAME"); else RUN_FLAGS=(--rm -it); fi

SERVE_ARGS=(--model "$MODEL" --served-model-name "$SERVED_NAME"
            --host 0.0.0.0 --port 8000 --trust-remote-code
            --tensor-parallel-size "$TP"
            --max-model-len "$MAX_LEN" --max-num-seqs "$MAX_SEQS"
            --kv-cache-dtype fp8
            --enable-auto-tool-choice --tool-call-parser qwen3_coder
            --reasoning-parser-plugin /app/reasoning_parser.py --reasoning-parser "$PARSER")
[[ -n "$QUANT" ]] && SERVE_ARGS+=(--quantization "$QUANT")

exec docker run "${RUN_FLAGS[@]}" --gpus all --ipc=host \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  -v "$HF_CACHE:/root/.cache/huggingface" \
  -v "$PARSER_FILE:/app/reasoning_parser.py:ro" \
  -p "$PORT:8000" \
  "$IMAGE" "${SERVE_ARGS[@]}"
