#!/usr/bin/env bash
# Run the Sionna RT coverage solve for the westminster_canary subset (25 tiles,
# 10 km square: Euston/Kings Cross → Greenwich) locally on the DGX Spark. Writes
# artifacts straight into nemoray/public/raytracing/ (what the HUD serves).
#
#   bash spark/run-pipeline.sh            # coverage solve only
#   bash spark/run-pipeline.sh --opt      # + cuOpt mast placement + RT verify
#
# Memory note: a solve uses ~2 GB of the unified pool. Run the solve BEFORE bringing the
# 120B NIM up (it claims most of the unified memory).
# If the 120B 'super' NIM is loaded it owns most of the box — run the solve first, then serve.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
[ -f .env ] && { set -a; . .env; set +a; }

PY="$REPO_ROOT/.venv/bin/python"
[ -x "$PY" ] || { echo "No .venv — run spark/setup.sh first." >&2; exit 1; }

echo "==> Coverage solve: --subset westminster_canary"
"$PY" -m src.pipeline --subset westminster_canary

if [ "${1:-}" = "--opt" ]; then
  # cuOpt needs an API key (hosted MILP service). optimize.py reads CUOPT_API_KEY.
  [ -n "${CUOPT_API_KEY:-}" ] || echo "WARN: CUOPT_API_KEY unset — optimise will fail." >&2
  # Closed loop: cuOpt proposes -> Sionna RT verifies -> residual holes re-optimise,
  # until the plan serves 100% of the outdoor holes (src.optimize runs verify itself).
  echo "==> cuOpt mast placement + RT verification (closed loop)"
  "$PY" -m src.optimize
fi

echo "==> Artifacts written to nemoray/public/raytracing/ — see summary.json:"
"$PY" - <<'PYEOF'
import json, pathlib
p = pathlib.Path("nemoray/public/raytracing/summary.json")
if p.exists():
    d = json.loads(p.read_text())
    for k in ("served_pct", "ray_paths", "masts_emitting_rays", "low_coverage_polys"):
        print(f"  {k}: {d.get(k)}")
    print(f"  wall_time_s: {d.get('performance', {}).get('wall_time_s', d.get('wall_time_s'))}")
PYEOF
