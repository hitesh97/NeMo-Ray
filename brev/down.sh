#!/usr/bin/env bash
# Stop the whole NeMo-Ray stack on a Brev instance (mirror of spark/down.sh).
set -uo pipefail

echo "==> Stopping Nemotron container"
docker rm -f nemoray-nemotron 2>/dev/null && echo "  removed nemoray-nemotron" || echo "  (no container)"

echo "==> Stopping twin / agent / HUD"
pkill -f "src[.]serve"                  && echo "  twin stopped"   || echo "  (no twin)"
pkill -f "nemoray_modelling[.]server"   && echo "  agent stopped"  || echo "  (no agent)"
pkill -f "next[-]server"                && echo "  HUD stopped"    || echo "  (no HUD)"
echo "Done."
