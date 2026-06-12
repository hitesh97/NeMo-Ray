#!/usr/bin/env bash
# One-time provisioning for a Brev (x86 cloud GPU) instance — the cloud mirror of
# spark/setup.sh. Clean CUDA wheels from PyPI; no --system-site-packages (that is a
# GB10/aarch64 workaround — do not copy it here).
#
#   bash brev/setup.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "==> Base tooling (git-lfs for the seed artifacts)"
have git-lfs || { $SUDO apt-get update -qq && $SUDO apt-get install -y git-lfs; }
git lfs install --skip-repo >/dev/null
git lfs pull

echo "==> uv (python package manager)"
have uv || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

echo "==> Sionna/twin venv (.venv) — clean x86 CUDA wheels"
[ -d .venv ] || uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r requirements.txt

echo "==> Agent venv (agent/.venv)"
(cd agent && uv sync)

echo "==> Docker GPU runtime check (vLLM serves Nemotron in a container)"
if have docker && docker info 2>/dev/null | grep -q nvidia; then
  docker pull "${IMAGE:-vllm/vllm-openai:v0.20.0}" || echo "  (pull deferred to first serve)"
else
  echo "  WARN: docker with the NVIDIA runtime not detected — Nemotron serving needs it." >&2
fi

cat <<'EOF'

Setup complete. Next:
  1. cp .env.example .env && nano .env      # CUOPT_API_KEY etc.
  2. bash spark/run-pipeline.sh             # coverage solve (artifacts -> HUD)
  3. bash brev/up.sh --hud                  # nemotron (BF16/FP8) + twin + agent + HUD
EOF
