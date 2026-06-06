"""Tiny web server for the viewer.

Serves the static files (viewer/, out/) like `python -m http.server`, and additionally
exposes `POST /api/optimize`, which runs the cuOpt mast-placement optimisation on demand
(so the viewer's "Optimise" button can trigger it) and returns the summary JSON.

    python -m src.serve            # http://localhost:8000/viewer/
"""
from __future__ import annotations

import json
import os
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from . import optimize as optimizer
from .config import ROOT, load_config


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        # Quieter logging; keep API calls visible.
        if "/api/" in self.path:
            super().log_message(fmt, *args)

    def _run_optimize(self):
        try:
            cfg = load_config()
            result = optimizer.optimize(cfg)
            if result.get("new_masts", 0) > 0:
                # Lazy import: pulls in Sionna RT (GPU) only when actually verifying.
                from . import verify as verifier
                result.update(verifier.verify(cfg))
            self._json(200, result)
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] == "/api/optimize":
            self._run_optimize()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/optimize":
            self._run_optimize()
        else:
            super().do_GET()


def main():
    port = int(os.environ.get("PORT", "8000"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Serving {ROOT}")
    print(f"  viewer:   http://localhost:{port}/viewer/")
    print(f"  optimise: POST http://localhost:{port}/api/optimize  (runs cuOpt)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
