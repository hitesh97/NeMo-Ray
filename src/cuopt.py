"""Thin client for the NVIDIA-hosted cuOpt LP/MILP service.

The hosted endpoint (https://optimize.api.nvidia.com/v1/nvidia/cuopt) takes the cuOpt
LP/MILP data model as the POST body and authenticates with an `nvapi-` Bearer key. Small
problems return synchronously (200); larger ones may queue (202) and are polled via the
NVCF status endpoint.
"""
from __future__ import annotations

import time

import requests

DEFAULT_URL = "https://optimize.api.nvidia.com/v1/nvidia/cuopt"
NVCF_STATUS = "https://api.nvcf.nvidia.com/v2/nvcf/exec/status/"


def solve_milp(data: dict, api_key: str, url: str = DEFAULT_URL,
               poll_seconds: int = 2, max_polls: int = 120) -> dict:
    """Submit a cuOpt LP/MILP `data` model and return the parsed JSON response.

    `data` follows the cuOpt schema: csr_constraint_matrix, constraint_bounds,
    objective_data, variable_bounds, variable_types, maximize, solver_config.
    """
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


def read_solution(response: dict) -> dict:
    """Pull (status, objective, vars dict, solve_time) out of a cuOpt response."""
    sol = response["response"]["solver_response"]["solution"]
    return {
        "status": response["response"]["solver_response"].get("status"),
        "objective": sol.get("primal_objective"),
        "vars": sol.get("vars", {}),
        "solve_time": response["response"].get("total_solve_time"),
    }
