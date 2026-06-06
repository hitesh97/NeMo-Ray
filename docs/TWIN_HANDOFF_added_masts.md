# Twin handoff — land `/api/coverage` + the `added`-masts keystone

> For **Mehul** (owner of `ee-coverage-twin`). Written 2026-06-06.
> The new Nemotron resilience tools on `arzaan1` (`simulate_outage`, `move_mast`,
> `deploy_cow` — commit `553611b`) **depend on these twin changes**. They are currently
> **uncommitted in the `~/nemoray-twin` worktree** and need to land on `ee-coverage-twin`
> so a fresh twin checkout has them. Verified working end-to-end on the live GPU stack.

## What changed (two files in `src/`)

### 1. `src/coverage.py` — generalise `recompute` to also *add* masts (NEW signature)
`recompute(cfg, disabled_ids, added=None)`. `added` is a list of placements
`[{id?, lat, lng, height_m?, power_dbm?}, ...]`. This one primitive powers every
mutating scenario:
- **outage / breakdown** → `disabled` only (unchanged behaviour);
- **move a mast** → disable its old id + add it back at the new lat/lng;
- **deploy a COW** → add one mast at `height_m=20`.

A tile is re-simulated if a disabled **or** an added mast illuminates it (within
`tx_radius`), so a change still re-solves only the handful of affected tiles.
Added masts become `Site` transmitters via `lnglat_to_en` + the existing per-tx
`height_m`/`power_dbm` in `rt.solve_tile`; power is capped at the same 63 dBm ceiling
`load_sites()` uses (defaults to `optimisation.new_mast_power_dbm`). The summary gains
an `added` list and a `power_model` note (answers the "is Sionna at max power?" audit:
**no** — declared EIRP, capped 63 dBm).

### 2. `src/serve.py` — expose `POST /api/coverage` (was unlanded)
Adds `_run_coverage()` + the `/api/coverage` POST route. Body:
`{"disabled_site_ids": [...], "added": [...]}`. Note the committed branch had **only**
`/api/optimize`; this adds the whole coverage endpoint *with* `added` support.

The full `serve.py` diff is small (see below); `coverage.py` is a new 169-line file.

## How to land it
```bash
cd ~/nemoray-twin
git status            # M src/serve.py, ?? src/coverage.py  (out/ is reset to baseline)
git add src/serve.py src/coverage.py
git commit -m "feat(twin): POST /api/coverage with added-masts recompute (tower-down + relocate/COW)"
# rebase/merge onto current origin/ee-coverage-twin (worktree base is behind), then push.
```

## Verify after landing
```bash
cd ~/nemoray-twin && git checkout -- out/
PORT=8011 .venv/bin/python -m src.serve &
# tower-down + an added COW @20m — expect added echoed back, a few tiles re-simulated:
curl -s -X POST localhost:8011/api/coverage \
  -d '{"disabled_site_ids":["TQ3268080770"],"added":[{"id":"COW-1","lat":51.516,"lng":-0.090,"height_m":20}]}'
```
Expected (verified 2026-06-06): `disabled_matched:["TQ3268080770"]`, `added:[{... height_m:20, power_dbm:58}]`,
`tiles_resimulated: 5`, plus the `power_model` note.

Then the `arzaan1` agent tools work against it with `TWIN_URL=http://localhost:8011`.
See also [`NEXT_SESSION.md`](./NEXT_SESSION.md) and [`TWIN_INTEGRATION.md`](./TWIN_INTEGRATION.md).

---
### `src/serve.py` diff
```diff
+    def _run_coverage(self):
+        """Tower-down: re-run Sionna RT with the posted site ids disabled → new holes."""
+        try:
+            length = int(self.headers.get("Content-Length", 0) or 0)
+            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
+            disabled = body.get("disabled_site_ids") or body.get("disabled_cells") or []
+            # `added` masts (relocations / COWs): [{id?, lat, lng, height_m?, power_dbm?}, ...].
+            added = body.get("added") or body.get("added_sites") or []
+            from . import coverage as cov
+            self._json(200, cov.recompute(load_config(), disabled, added))
+        except Exception as e:
+            traceback.print_exc()
+            self._json(500, {"error": str(e)})

     def do_POST(self):
-        if self.path.split("?")[0] == "/api/optimize":
+        path = self.path.split("?")[0]
+        if path == "/api/optimize":
             self._run_optimize()
+        elif path == "/api/coverage":
+            self._run_coverage()
         else:
             self.send_error(404)
```
