"""End-to-end integration test: twin HTTP API + agent tools, in one process.

Runs the twin's ThreadingHTTPServer in a daemon thread and drives it with the real
agent ToolRegistry over TWIN_URL — exercising simulate_outage / move_mast / deploy_cow /
check_starlink against the live Sionna-RT twin. No subprocess, no shell backgrounding.

Run from the repo root with the TWIN venv (which has Sionna):
    PYTHONPATH=agent .venv/bin/python -m tests.integration_twin_agent
"""
from __future__ import annotations

import os
import sys
import threading
import time
from http.server import ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))
os.environ.setdefault("TWIN_URL", f"http://127.0.0.1:{PORT}")
os.environ.setdefault("NEMORAY_NO_WARMUP", "1")   # we warm explicitly below

from src.serve import Handler  # noqa: E402


def _serve():
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


def main() -> int:
    threading.Thread(target=_serve, daemon=True).start()
    time.sleep(1.0)

    # Agent tools (added to path via PYTHONPATH=agent).
    from nemoray_modelling.tools import ToolRegistry

    reg = ToolRegistry()
    ok = True

    print("\n[1] simulate_outage (5 central masts) — expect Sionna RT source + buildings")
    t0 = time.time()
    r = reg.run("simulate_outage", {"site_ids": [
        "TQ3461880911", "TQ3460081200", "TQ3460081260", "TQ3474081380", "TQ3493081510"]})
    print(f"    {time.time()-t0:.1f}s  {r.result}")
    src = r.observation.get("source")
    print(f"    source={src}  dead_zones={r.observation.get('dead_zone_count')} "
          f"buildings={r.observation.get('affected_counts')}")
    ok &= src == "Sionna RT coverage twin"

    print("\n[2] deploy_cow — expect a fire-station depot + tow distance")
    t0 = time.time()
    r = reg.run("deploy_cow", {"disabled_site_ids": []})
    print(f"    {time.time()-t0:.1f}s  {r.result}")
    station = (r.observation.get("source_station") or {}).get("name")
    print(f"    depot={station}  cow={r.observation.get('cow')}")
    ok &= "Fire Station" in (station or "")

    print("\n[3] check_starlink at the COW position — expect a live Skyfield answer")
    r = reg.run("check_starlink", {})
    print(f"    {r.result}")
    ok &= r.observation.get("source") == "Skyfield (Starlink TLEs)"

    print("\n[4] move_mast — expect twin re-sim of the relocated mast")
    t0 = time.time()
    r = reg.run("move_mast", {"site_id": "TQ3461880911", "new_lat": 51.515, "new_lng": -0.075})
    print(f"    {time.time()-t0:.1f}s  {r.result}")
    ok &= r.observation.get("source") == "Sionna RT coverage twin"

    print(f"\n=== integration {'PASS' if ok else 'FAIL'} ===")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
