"""Web server for the digital twin's HTTP API.

Serves the live artifacts under `/out/` like `python -m http.server`, and exposes the
API the Nemotron agent (and the Next.js HUD) drive:

  POST /api/coverage  {disabled_site_ids:[...], added:[{id,lat,lng,height_m?}]}
                      → re-simulate affected tiles (Sionna RT), re-export coverage +
                        holes + affected-tile rays; returns a summary.
  POST /api/optimize  → cuOpt mast placement + RT verification (writes new_masts.geojson).
  POST /api/rays      {disabled_site_ids?, added?} → trace rays for the current mast set
                        across the simulated area → out/paths.geojson (rays-on-demand).
  GET  /api/emergency → (re)write + return out/emergency.geojson (police/fire/hospital).

Heavy modules (Sionna RT via resimulate) are imported lazily so the static server
starts instantly and only touches the GPU on the first simulation call.

    python -m src.serve            # http://localhost:8000/  (twin API + /out/ artifacts)
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from . import history
from .config import ROOT, load_config
from .emergency import export_emergency


def _change_label(disabled, added, result) -> str:
    """Human label for a sim-state snapshot, derived from the change + its result."""
    bits = []
    if disabled:
        bits.append(f"−{len(disabled)} mast" + ("s" if len(disabled) != 1 else ""))
    if added:
        cow = any(str(a.get("id", "")).upper().startswith("COW") for a in added)
        bits.append("COW deployed" if cow else f"+{len(added)} mast")
    head = " · ".join(bits) or "re-sim"
    holes = result.get("coverage_holes")
    return f"{head} · {holes} holes" if holes is not None else head


# One optimisation at a time: the closed loop (cuOpt + RT verify) can run for many
# minutes and owns the GPU + artifacts while it does. Other GPU work (coverage re-sims)
# and artifact mutations (clear_proposals) report busy instead of stacking behind it —
# a stacked request used to keep running after the client timed out, fighting the GPU
# and rewriting artifacts long after the operator stopped waiting.
_OPTIMIZE_BUSY = threading.Lock()


def _busy() -> dict:
    return {"error": "the mast-placement optimiser is running — retry when it completes",
            "busy": True}


# Absolute artifacts dir (config paths.out_dir, already root-resolved by load_config).
# The agent + HUD fetch the live artifacts at the stable URL prefix /out/, but on this
# branch the pipeline publishes them to nemoray/public/raytracing (so a fresh run shows up
# in the HUD), not ./out — so static /out/ requests are aliased onto out_dir below.
_OUT_DIR = load_config()["paths"]["out_dir"]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        # Map /out/<file> → <out_dir>/<file> so the twin serves whatever the pipeline /
        # resimulate wrote (hotspots/new_masts/new_rays/emergency .geojson, coverage.png),
        # regardless of where out_dir points. Everything else is served from ROOT as usual.
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean == "/out" or clean.startswith("/out/"):
            rel = clean[len("/out/"):].lstrip("/")
            return os.path.join(_OUT_DIR, rel)
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        # Quieter logging; keep API calls visible.
        if "/api/" in self.path:
            super().log_message(fmt, *args)

    # ── helpers ────────────────────────────────────────────────────────────────
    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except (json.JSONDecodeError, ValueError):
            return {}

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _guard(self, fn):
        """Run an API handler, JSON-erroring (500) instead of crashing the connection."""
        try:
            self._json(200, fn())
        except Exception as e:  # noqa: BLE001 — surface any engine error to the client
            traceback.print_exc()
            self._json(500, {"error": str(e)})

    # ── API actions ──────────────────────────────────────────────────────────────
    def _run_coverage(self):
        from . import resimulate as R
        if _OPTIMIZE_BUSY.locked():
            return _busy()
        body = self._body()
        cfg = load_config()
        disabled = body.get("disabled_site_ids") or []
        added = body.get("added") or []
        result = R.resimulate(cfg, disabled_ids=disabled, added=added,
                              trace_rays=bool(body.get("trace_rays", False)))
        # Snapshot the new state so it can be reverted to.
        label = _change_label(disabled, added, result)
        meta = history.snapshot(cfg, label,
                                extra={"served_pct": result.get("served_pct"),
                                       "coverage_holes": result.get("coverage_holes")})
        result["state_id"] = meta["id"]
        return result

    def _run_rays(self):
        """Trace rays. affected_only=True (default): just the tiles a change touched
        (fast, → new_rays.geojson). affected_only=False: the whole area (→ paths.geojson)."""
        from . import resimulate as R
        body = self._body()
        cfg = load_config()
        disabled = body.get("disabled_site_ids") or []
        added = body.get("added") or []
        if body.get("affected_only", True):
            return R.trace_affected_rays(cfg, disabled_ids=disabled, added=added)
        return R.trace_all_rays(cfg, disabled_ids=disabled, added=added)

    def _run_optimize(self):
        # Closed loop: cuOpt proposes, Sionna RT verifies, residual holes re-optimise —
        # so the returned plan actually serves 100% of the outdoor holes under real
        # ray-traced propagation (optimize_to_target), not just the planner's circles.
        # From a clean baseline this runs for MINUTES (multiple GPU verify rounds) —
        # exactly one runs at a time, and the GPU lock keeps re-sims out while it does.
        if not _OPTIMIZE_BUSY.acquire(blocking=False):
            return _busy()
        try:
            from . import optimize as optimizer
            from . import resimulate as R
            cfg = load_config()
            with R._RESIM_LOCK:  # the de-facto GPU lock — no concurrent solves
                result = optimizer.optimize_to_target(cfg)
            meta = history.snapshot(cfg, f"cuOpt: +{result.get('new_masts', 0)} masts",
                                    extra={"served_pct": result.get("served_pct_after")})
            result["state_id"] = meta["id"]
            return result
        finally:
            _OPTIMIZE_BUSY.release()

    def _run_emergency(self):
        cfg = load_config()
        n = export_emergency(cfg)
        with open(os.path.join(cfg["paths"]["out_dir"], "emergency.geojson")) as f:
            fc = json.load(f)
        fc["count"] = n
        return fc

    def _run_route(self):
        """Driving route between two lng,lat points via the public OSRM demo, so the HUD
        can draw the actual ROAD path a Cell-on-Wheels tows along. Falls back to a straight
        line if OSRM is unreachable. Query: ?from=lng,lat&to=lng,lat"""
        import urllib.parse
        import urllib.request

        q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        frm = (q.get("from") or [""])[0]
        to = (q.get("to") or [""])[0]
        try:
            f_lng, f_lat = (float(x) for x in frm.split(","))
            t_lng, t_lat = (float(x) for x in to.split(","))
        except ValueError:
            return {"error": "need ?from=lng,lat&to=lng,lat"}
        url = (f"https://router.project-osrm.org/route/v1/driving/"
               f"{f_lng},{f_lat};{t_lng},{t_lat}?overview=full&geometries=geojson")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "NeMo-Ray/0.2"})
            with urllib.request.urlopen(req, timeout=8) as resp:  # noqa: S310
                data = json.loads(resp.read())
            route = data["routes"][0]
            return {"geometry": route["geometry"], "distance_m": route.get("distance"),
                    "duration_s": route.get("duration"), "source": "osrm"}
        except Exception:  # noqa: BLE001 — any failure → straight-line fallback
            return {"geometry": {"type": "LineString",
                                 "coordinates": [[f_lng, f_lat], [t_lng, t_lat]]},
                    "distance_m": None, "duration_s": None, "source": "straight"}

    def _run_clear_proposals(self):
        """Remove the cuOpt plan: restore the baseline artifacts (coverage, hotspots,
        new_masts, …) and strip the proposed masts' rays (operator EE-new) from the master
        paths.geojson — which history snapshots deliberately exclude. The cleared state is
        snapshotted so it can itself be reverted."""
        if _OPTIMIZE_BUSY.locked():
            return _busy()
        from . import export
        cfg = load_config()
        states = history.list_states(cfg)
        base = next((s for s in states if s.get("label") == "baseline"), None)
        restored = history.restore(cfg, base["id"]) if base else None
        if restored is None:
            # No labelled baseline snapshot — never restore an arbitrary state (it may
            # itself contain proposals); just empty the plan artifacts honestly.
            out_dir = cfg["paths"]["out_dir"]
            with open(os.path.join(out_dir, "new_masts.geojson"), "w") as f:
                json.dump({"type": "FeatureCollection", "features": []}, f)
        rays_now = export.update_master_rays(cfg, [], drop_operator="EE-new")
        meta = history.snapshot(cfg, "proposals cleared",
                                extra={"served_pct": (restored or {}).get("served_pct")})
        return {
            "cleared": True,
            "restored_state": restored,
            "rays_in_master": rays_now,
            "state_id": meta["id"],
        }

    def _run_history(self):
        return {"states": history.list_states(load_config())}

    def _run_restore(self):
        cfg = load_config()
        sid = self._body().get("id")
        return {"restored": history.restore(cfg, sid)}

    _POST_ROUTES = {
        "/api/coverage": "_run_coverage",
        "/api/optimize": "_run_optimize",
        "/api/rays": "_run_rays",
        "/api/restore": "_run_restore",
        "/api/clear_proposals": "_run_clear_proposals",
    }

    def do_POST(self):
        route = self.path.split("?")[0]
        name = self._POST_ROUTES.get(route)
        if name:
            self._guard(getattr(self, name))
        else:
            self.send_error(404)

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/emergency":
            self._guard(self._run_emergency)
        elif route == "/api/route":
            self._guard(self._run_route)
        elif route == "/api/history":
            self._guard(self._run_history)
        elif route in self._POST_ROUTES:        # allow GET to trigger long jobs too
            self._guard(getattr(self, self._POST_ROUTES[route]))
        else:
            super().do_GET()


def _warmup():
    """Compile the Mitsuba/Dr.Jit CUDA kernels up front (the FIRST radio-map solve in a
    process JITs kernels, ~30-60s) so the first user /api/coverage call is fast. Runs in a
    daemon thread; skip with NEMORAY_NO_WARMUP=1."""
    if os.environ.get("NEMORAY_NO_WARMUP"):
        return
    try:
        from . import rt as RT
        from .masts import load_sites
        from .osm import load_buildings
        from .scene_builder import build_tile_scene
        from .verify import _reconstruct_tiles
        t0 = time.time()
        cfg = load_config()
        tiles = _reconstruct_tiles(cfg)
        if not tiles:
            return
        tile, _ = tiles[0]
        xml, _b = build_tile_scene(cfg, tile, load_buildings(cfg))
        RT.solve_tile(cfg, tile, xml, load_sites(cfg))
        print(f"  GPU warmup done in {time.time() - t0:.0f}s — /api/coverage is now hot")
    except Exception as e:  # noqa: BLE001
        print(f"  (GPU warmup skipped: {e})")


def main():
    port = int(os.environ.get("PORT", "8000"))
    # Pre-generate the emergency overlay (cheap; no GPU) so /out/emergency.geojson is ready.
    try:
        cfg = load_config()
        from .emergency import export_emergency_buildings
        n = export_emergency(cfg)
        nb = export_emergency_buildings(cfg)
        print(f"  emergency overlay: {n} points, {nb} whole-building footprints")
        history.ensure_baseline(cfg)            # always have an origin to revert to
    except Exception as e:  # noqa: BLE001
        print(f"  (startup prep issue: {e})")
    threading.Thread(target=_warmup, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Serving {ROOT}")
    print(f"  artifacts: http://localhost:{port}/out/")
    print(f"  coverage:  POST http://localhost:{port}/api/coverage  (Sionna RT re-sim)")
    print(f"  optimise:  POST http://localhost:{port}/api/optimize  (cuOpt + verify)")
    print(f"  rays:      POST http://localhost:{port}/api/rays      (trace on demand)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
