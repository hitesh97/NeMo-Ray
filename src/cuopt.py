"""cuOpt LP/MILP client: NVIDIA-hosted endpoint with a LOCAL self-hosted fallback.

The set-cover MILP that places new masts (`src/optimize.py`) is solved on cuOpt. Two backends,
tried in order so the optimiser keeps working when the cloud is unreachable or unkeyed:

  1. **Hosted** — https://optimize.api.nvidia.com/v1/nvidia/cuopt, the managed NVCF service,
     authenticated with an `nvapi-` Bearer key. Small problems return 200 synchronously; larger
     ones queue (202) and are polled via the NVCF status endpoint.
  2. **Local self-hosted** — a cuOpt server on the same GPU box (`python -m
     cuopt_server.cuopt_service`, see `brev/serve-cuopt.sh`), reached via the `cuopt-sh-client`
     library (Arzaan's stack) or, failing that, its REST API directly. Used as a fallback when
     the hosted call fails OR no API key is set — so an offline / air-gapped / cloud-outage demo
     still optimises on the local H200.

Both backends speak the **same** cuOpt LP/MILP data model and return the **same** response shape
(`response.solver_response.solution`), so `read_solution` is backend-agnostic.
"""
from __future__ import annotations

import os
import sys
import time
from urllib.parse import urlparse

import requests

DEFAULT_URL = "https://optimize.api.nvidia.com/v1/nvidia/cuopt"
NVCF_STATUS = "https://api.nvcf.nvidia.com/v2/nvcf/exec/status/"
DEFAULT_LOCAL_URL = "http://localhost:5000"

# Labels recorded in optimization.json so the HUD/agent can see which backend actually ran.
SOLVER_HOSTED = "NVIDIA cuOpt (hosted MILP)"
SOLVER_LOCAL = "NVIDIA cuOpt (local self-hosted MILP)"


def _warn(msg: str) -> None:
    print(f"[NeMo-Ray cuOpt] {msg}", file=sys.stderr, flush=True)


def solve_milp(
    data: dict,
    api_key: str,
    url: str = DEFAULT_URL,
    *,
    poll_seconds: int = 2,
    max_polls: int = 120,
    local_url: str | None = None,
    allow_local_fallback: bool = True,
) -> dict:
    """Solve the cuOpt LP/MILP `data` model and return the parsed JSON response.

    Tries the hosted endpoint first when an `api_key` is present; on any failure — or when no key
    is set — falls back to the local self-hosted cuOpt server (unless `allow_local_fallback` is
    False). The returned dict carries `_nemoray_solver` naming the backend that produced it.

    `data` follows the cuOpt schema: csr_constraint_matrix, constraint_bounds, objective_data,
    variable_bounds, variable_names, variable_types, maximize, solver_config.
    """
    local_url = local_url or os.environ.get("CUOPT_LOCAL_URL") or DEFAULT_LOCAL_URL
    hosted_exc: Exception | None = None

    if api_key:
        try:
            resp = _solve_hosted(data, api_key, url, poll_seconds, max_polls)
            resp["_nemoray_solver"] = SOLVER_HOSTED
            return resp
        except Exception as exc:  # network / HTTP / timeout — fall back if allowed
            hosted_exc = exc
            if not allow_local_fallback:
                raise
            _warn(f"hosted cuOpt failed ({exc!r}); falling back to local self-hosted cuOpt")
    elif not allow_local_fallback:
        raise RuntimeError(
            "No cuOpt API key (CUOPT_API_KEY) and local fallback is disabled "
            "(cuopt.fallback_local=false)."
        )
    else:
        _warn("no CUOPT_API_KEY set — using local self-hosted cuOpt")

    try:
        resp = _solve_self_hosted(data, local_url)
        resp["_nemoray_solver"] = SOLVER_LOCAL
        return resp
    except Exception as local_exc:
        if hosted_exc is not None:
            raise RuntimeError(
                f"cuOpt unavailable: hosted failed ({hosted_exc!r}) AND local fallback "
                f"failed ({local_exc!r}). Start the local server with brev/serve-cuopt.sh."
            ) from local_exc
        raise RuntimeError(
            f"cuOpt local solve failed ({local_exc!r}) and no API key was set for the hosted "
            f"service. Start the local server (brev/serve-cuopt.sh) or set CUOPT_API_KEY."
        ) from local_exc


# ── hosted backend (NVIDIA NVCF) ────────────────────────────────────────────────
def _solve_hosted(
    data: dict, api_key: str, url: str, poll_seconds: int, max_polls: int
) -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    resp = requests.post(url, json=data, headers=headers, timeout=120)

    # NVCF may queue the request and return 202 + a request id to poll.
    if resp.status_code == 202:
        req_id = resp.headers.get("NVCF-REQID")
        for _ in range(max_polls):
            time.sleep(poll_seconds)
            s = requests.get(NVCF_STATUS + req_id, headers=headers, timeout=120)
            if s.status_code == 200:
                return s.json()
            if s.status_code != 202:
                s.raise_for_status()
        raise TimeoutError("cuOpt request timed out while polling NVCF status")

    if resp.status_code != 200:
        raise RuntimeError(f"cuOpt HTTP {resp.status_code}: {resp.text[:500]}")
    return resp.json()


# ── local self-hosted backend (cuopt_server on the GPU box) ──────────────────────
def _solve_self_hosted(data: dict, base_url: str) -> dict:
    """Solve on a local cuOpt server. Prefers the official `cuopt-sh-client` (`get_LP_solve`),
    and falls back to the server's REST API (`POST /cuopt/request` → poll `/cuopt/solution`).
    Returns a response normalised to the hosted shape."""
    u = urlparse(base_url if "://" in base_url else f"http://{base_url}")
    ip = u.hostname or "localhost"
    port = u.port or 5000

    # Preferred: the self-hosted client library (Arzaan added cuopt-sh-client to modellingsim).
    try:
        from cuopt_sh_client import CuOptServiceSelfHostClient
    except ImportError:
        CuOptServiceSelfHostClient = None  # noqa: N806 — fall through to REST below

    if CuOptServiceSelfHostClient is not None:
        client = CuOptServiceSelfHostClient(ip=ip, port=port)
        raw = client.get_LP_solve(data)
        # Some client versions stream partial frames; take the last/terminal dict.
        if not isinstance(raw, dict) and hasattr(raw, "__iter__"):
            raw = [frame for frame in raw][-1]
        return _normalize_response(raw)

    # Fallback: the documented REST contract (same one the cuOpt server quick-start uses).
    return _solve_self_hosted_rest(f"http://{ip}:{port}", data)


def _solve_self_hosted_rest(
    base: str, data: dict, *, poll_seconds: float = 1.0, max_polls: int = 600
) -> dict:
    base = base.rstrip("/")
    headers = {"Content-Type": "application/json", "CLIENT-VERSION": "custom"}
    r = requests.post(f"{base}/cuopt/request", json=data, headers=headers, timeout=120)
    r.raise_for_status()
    body = r.json()
    if "response" in body:  # solved synchronously
        return _normalize_response(body)
    req_id = body.get("reqId")
    if not req_id:
        raise RuntimeError(f"local cuOpt returned no reqId/response: {str(body)[:200]}")
    for _ in range(max_polls):
        time.sleep(poll_seconds)
        s = requests.get(f"{base}/cuopt/solution/{req_id}", headers=headers, timeout=120)
        s.raise_for_status()
        sol = s.json()
        if "response" in sol:
            return _normalize_response(sol)
    raise TimeoutError("local cuOpt timed out while polling for a solution")


def _normalize_response(raw: dict) -> dict:
    """Coerce a backend response into the canonical {response: {solver_response: …}} shape that
    `read_solution` expects (hosted and self-hosted already match; this is defensive)."""
    if isinstance(raw, dict) and "response" in raw:
        return raw
    if isinstance(raw, dict) and "solver_response" in raw:
        return {"response": raw}
    raise RuntimeError(f"unrecognised cuOpt response: {str(raw)[:200]}")


def read_solution(response: dict) -> dict:
    """Pull (status, objective, vars dict, solve_time) out of a cuOpt response — backend-agnostic
    (hosted and self-hosted share this shape)."""
    sr = response["response"]["solver_response"]
    sol = sr["solution"]
    return {
        "status": sr.get("status"),
        "objective": sol.get("primal_objective"),
        "vars": sol.get("vars", {}),
        "solve_time": response["response"].get("total_solve_time"),
    }
