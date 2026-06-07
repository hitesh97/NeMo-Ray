"""Full-stack test: live local Nemotron (vLLM :8080) → agent → real Sionna twin.

Runs the twin's HTTP server in a daemon thread and drives the agent with the REAL
LlamaCppPlanner pointed at the local NIM, so the model itself chooses the tools and they
hit the live GPU twin. Run from repo root with the TWIN venv (PYTHONPATH=agent):

    NEMOTRON_BASE_URL=http://localhost:8080 NEMOTRON_MODEL=nemotron-3-nano \
    PYTHONPATH=agent .venv/bin/python -m tests.integration_nim
"""
from __future__ import annotations

import os
import threading
import time
from http.server import ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))
os.environ.setdefault("TWIN_URL", f"http://127.0.0.1:{PORT}")
os.environ.setdefault("NEMORAY_NO_WARMUP", "1")
os.environ.setdefault("NEMOTRON_THINKING", "off")

from src.serve import Handler  # noqa: E402


def main() -> int:
    threading.Thread(target=lambda: ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever(),
                     daemon=True).start()
    time.sleep(1.0)

    from nemoray_modelling.agent import LlamaCppPlanner, run_agent

    planner = LlamaCppPlanner(
        base_url=os.environ["NEMOTRON_BASE_URL"],
        model=os.environ.get("NEMOTRON_MODEL", "nemotron-3-nano"),
    )
    event = ("Two EE masts have gone offline. Assess the coverage lost, say which "
             "emergency-service buildings are affected, then deploy a Cell-on-Wheels and "
             "name its Starlink backhaul satellite.\n\n"
             "[Operator has selected these mast ids on the map: "
             "TQ3461880911, TQ3460081200]")

    print("=== running live agent (Nemotron-driven) against the real twin ===")
    t0 = time.time()
    tools, reasoning, final = [], [], []
    for f in run_agent(event, planner=planner, max_steps=8):
        t = f["type"]
        if t == "tool_call":
            tools.append(f["call"]["name"])
            print(f"  → tool: {f['call']['name']}  args={f['call'].get('args')}")
        elif t == "tool_update" and f["patch"].get("status") == "success":
            print(f"     result: {f['patch'].get('result')}")
        elif t == "reasoning":
            reasoning.append(f["text"])
        elif t == "token":
            final.append(f["text"])
        elif t == "error":
            print("  !! error:", f["message"])
    dt = time.time() - t0
    print(f"\ntools fired: {tools}")
    print("FINAL:", "".join(final)[:600])
    print(f"\n=== completed in {dt:.1f}s ===")
    return 0 if tools else 1


if __name__ == "__main__":
    raise SystemExit(main())
