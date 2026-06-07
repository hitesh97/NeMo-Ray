#!/usr/bin/env bash
# Serve a local, NVFP4-quantised Nemotron-3 on the DGX Spark (GB10) as an OpenAI-compatible
# endpoint the NeMo-Ray agent drives. Follows NVIDIA's DGX Spark cookbook for the NVFP4
# checkpoints (vllm/vllm-openai:v0.20.0 container + reasoning/tool parsers).
#
#   nano:  https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4
#   super: https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4
#
# MEMORY (important): the GB10 has ~121 GB of *unified* memory shared by CPU+GPU. vLLM's
# default --gpu-memory-utilization is 0.9, which on unified memory reserves ~90% of the WHOLE
# machine for weights+KV and starves everything else (incl. the Sionna twin). So we set a
# modest GPU_MEM_UTIL and a small MAX_LEN by default. Tune up only if you have headroom.
#
# Usage:
#   ./scripts/serve_nemotron.sh                         # nano (fits alongside the twin)
#   MODEL_PROFILE=super ./scripts/serve_nemotron.sh     # 120B — uses most of the box
#   GPU_MEM_UTIL=0.5 MAX_LEN=32768 ./scripts/serve_nemotron.sh
#   DETACH=1 ./scripts/serve_nemotron.sh                # daemonised (scripted start/stop)
#
# Then in .env:  NEMOTRON_BASE_URL=http://localhost:8080   NEMOTRON_MODEL=<served name below>
# Verify:        curl -s localhost:8080/v1/models
set -euo pipefail

# Container: vllm/vllm-openai:v0.20.0 is the HF cookbook's DGX-Spark container for the NVFP4
# checkpoints. NVIDIA's NGC build also works (needs `docker login nvcr.io` with NGC_API_KEY):
#   IMAGE=nvcr.io/nvidia/vllm:25.12.post1-py3 ./scripts/serve_nemotron.sh
PORT="${PORT:-8080}"
IMAGE="${IMAGE:-vllm/vllm-openai:v0.20.0}"
PROFILE="${MODEL_PROFILE:-nano}"
HF_CACHE="${HF_CACHE:-$HOME/.cache/huggingface}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Pull HF_TOKEN from .env if present (optional for these ungated nvidia/ repos).
if [[ -f "$HERE/../.env" ]]; then set -a; source "$HERE/../.env"; set +a; fi

case "$PROFILE" in
  nano)
    MODEL="${MODEL:-nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4}"
    SERVED_NAME="${SERVED_NAME:-nemotron-3-nano}"
    PARSER="nano_v3"; PARSER_FILE="$HERE/nano_v3_reasoning_parser.py"
    MAX_LEN="${MAX_LEN:-16384}"; MAX_SEQS="${MAX_SEQS:-4}"
    GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.35}"        # ~42 GB of 121 GB — leaves room for the twin
    QUANT="${QUANT:-}"                          # auto-detect (config says modelopt_fp4)
    EXTRA=()
    ;;
  super)
    MODEL="${MODEL:-nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4}"
    SERVED_NAME="${SERVED_NAME:-nemotron-3-super}"
    PARSER="super_v3"; PARSER_FILE="$HERE/super_v3_reasoning_parser.py"
    MAX_LEN="${MAX_LEN:-16384}"; MAX_SEQS="${MAX_SEQS:-2}"
    GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.85}"        # 120B needs most of the box — don't run heavy twin solves at the same time
    QUANT="${QUANT:-fp4}"                       # super config declares plain fp4
    # cookbook extras for the 120B MoE on Spark
    EXTRA=(--async-scheduling --dtype auto --enable-chunked-prefill
           --moe-backend marlin --mamba_ssm_cache_dtype float16
           --speculative_config '{"method":"mtp","num_speculative_tokens":3,"moe_backend":"triton"}')
    ;;
  *) echo "Unknown MODEL_PROFILE=$PROFILE (use 'nano' or 'super')" >&2; exit 1 ;;
esac

echo "Serving $MODEL  (served as '$SERVED_NAME')  on http://localhost:$PORT"
echo "  gpu-mem-util=$GPU_MEM_UTIL  max-model-len=$MAX_LEN  max-num-seqs=$MAX_SEQS  image=$IMAGE"
mkdir -p "$HF_CACHE"

# DGX Spark OOM mitigation (per NGC vLLM notes): free the page cache before vLLM grabs its
# slice of the unified pool. Needs root; enable with DROP_CACHES=1.
if [[ "${DROP_CACHES:-0}" == "1" ]]; then
  echo "Dropping page cache (frees unified memory; needs sudo)…"
  sync && sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || echo "  (skipped — needs root)"
fi
[[ -f "$PARSER_FILE" ]] || { echo "Missing $PARSER_FILE — download it from the model's HF repo." >&2; exit 1; }

NAME="${NAME:-nemoray-nemotron}"
if [[ "${DETACH:-0}" == "1" ]]; then RUN_FLAGS=(-d --name "$NAME"); else RUN_FLAGS=(--rm -it); fi

SERVE_ARGS=(--model "$MODEL" --served-model-name "$SERVED_NAME"
            --host 0.0.0.0 --port 8000 --trust-remote-code
            --gpu-memory-utilization "$GPU_MEM_UTIL"
            --max-model-len "$MAX_LEN" --max-num-seqs "$MAX_SEQS"
            --kv-cache-dtype fp8 --tensor-parallel-size 1
            --enable-auto-tool-choice --tool-call-parser qwen3_coder
            --reasoning-parser-plugin /app/reasoning_parser.py --reasoning-parser "$PARSER"
            "${EXTRA[@]}")
[[ -n "$QUANT" ]] && SERVE_ARGS+=(--quantization "$QUANT")

exec docker run "${RUN_FLAGS[@]}" --gpus all --ipc=host \
  -e VLLM_NVFP4_GEMM_BACKEND=marlin \
  -e VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 \
  -e VLLM_FLASHINFER_ALLREDUCE_BACKEND=trtllm \
  -e VLLM_USE_FLASHINFER_MOE_FP4=0 \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  -v "$HF_CACHE:/root/.cache/huggingface" \
  -v "$PARSER_FILE:/app/reasoning_parser.py:ro" \
  -p "$PORT:8000" \
  "$IMAGE" "${SERVE_ARGS[@]}"
