#!/usr/bin/env bash
# NeMo-Ray — one-shot provisioning for a local NVIDIA DGX Spark (GB10, aarch64, CUDA 13).
#
# Unlike Brev, the Spark is PERSISTENT local hardware: provision once, it stays. This is
# idempotent — safe to re-run; it skips finished work. The repo lives on the box (this is
# your dev machine), so git-lfs pull works here (real remote/auth), no rsync needed.
#
# Provisions BOTH GPU workloads on the one box (128 GB unified memory holds them at once):
#   1. Sionna RT coverage pipeline (src/)  — Python venv (.venv, --system-site-packages)
#   2. Nemotron agent stack:
#        - NIM:   scripts/serve_nemotron.sh  (vLLM NVFP4 in Docker, :8080)  — already GB10-tuned
#        - twin:  python -m src.serve        (:8000)  — reuses .venv
#        - agent: agent/ SSE bridge          (:8001)  — agent/.venv via uv
#
# Run from the repo root:   bash spark/setup.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }   # canonical root .env (cp .env.example .env)

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
say "GPU / driver check (expect GB10 / DGX Spark)"
have nvidia-smi || { echo "ERROR: no nvidia-smi — is this the DGX Spark? (DGX OS ships the driver)." >&2; exit 1; }
# On the GB10 the memory pool is UNIFIED, so nvidia-smi reports memory.total as N/A — that's
# expected, not a fault. Just print name + driver.
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
case "$(uname -m)" in aarch64|arm64) ;; *) echo "  NOTE: arch $(uname -m) — the Spark is aarch64; CUDA wheels differ." >&2 ;; esac

# ---------------------------------------------------------------------------
say "Docker + NVIDIA container runtime (needed for the vLLM NIM)"
have docker || { echo "ERROR: docker not found. DGX OS ships Docker — install it or check PATH." >&2; exit 1; }
if docker info 2>/dev/null | grep -qi "Runtimes:.*nvidia"; then
  echo "  nvidia container runtime present (preinstalled on DGX OS)."
else
  echo "  WARNING: nvidia runtime not detected — 'docker run --gpus all' may fail." >&2
  echo "           Install nvidia-container-toolkit and restart docker." >&2
fi

# ---------------------------------------------------------------------------
say "System packages (git-lfs, build basics)"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
if have apt-get; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends git git-lfs build-essential curl ca-certificates
fi

# ---------------------------------------------------------------------------
say "Git LFS data (OSM PBF 120 MB + buildings cache 164 MB)"
git lfs install
git lfs pull --include="data/greater-london-latest.osm.pbf,data/buildings.pkl" || \
  echo "NOTE: LFS pull partial — the PBF is required; buildings.pkl is a regenerable cache."

# ---------------------------------------------------------------------------
say "Python + Sionna pipeline venv (.venv, --system-site-packages)"
# CRITICAL Spark difference vs Brev: on the GB10 (aarch64, CUDA 13) Sionna/Mitsuba/Dr.Jit use
# the system NVIDIA stack that ships with DGX OS, so the venv must SEE system site-packages.
# (Brev installs clean CUDA wheels via `uv pip`; that path is x86-only and wrong here.)
if [ ! -x .venv/bin/python ]; then
  python3 -m venv --system-site-packages .venv
fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
echo "Sionna import smoke test:"
.venv/bin/python -c "import sionna.rt, mitsuba as mi; print(' sionna-rt OK; mitsuba variants:', mi.variants())"

# ---------------------------------------------------------------------------
say "Agent venv (agent/.venv via uv) — the SSE bridge on :8001"
have uv || { curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
( cd agent && uv sync )

# ---------------------------------------------------------------------------
say "Pre-pull the vLLM NIM image (so the first serve is fast)"
# The HF DGX-Spark cookbook container is multi-arch (has an arm64 build for GB10).
docker pull "${IMAGE:-vllm/vllm-openai:v0.20.0}" || echo "  (pull failed/skipped — serve_nemotron.sh will pull on first run)"

# ---------------------------------------------------------------------------
say "Done. Bring the whole stack up with one command:"
cat <<EOF
  All services (nemotron super + twin + agent):  bash spark/up.sh
  …add the HUD too:                              bash spark/up.sh --hud
  Stop everything:                               bash spark/down.sh

  Or run each in its own terminal / tmux pane:
  1. Coverage solve   : bash spark/run-pipeline.sh          # 25-tile westminster_canary (--opt for cuOpt+verify)
  2. Nemotron NIM     : bash spark/serve-nemotron.sh        # vLLM NVFP4 super (120B) on :8080
                        (first run pulls the NVFP4 weights into \${HF_CACHE:-~/.cache/huggingface})
  3. Twin backend     : bash spark/serve-twin.sh            # python -m src.serve on :8000
  4. Agent SSE bridge : bash spark/serve-agent.sh           # uvicorn on :8001
  5. HUD              : bash spark/serve-hud.sh              # Next.js on :3000

  It's all LOCAL — open the HUD straight at http://localhost:3000 (no port-forward).
  Viewing from another machine on the LAN: ssh -L 3000:localhost:3000 <spark-host>
EOF
