"""cuOpt hosted→local fallback logic (no GPU / no real cuOpt needed).

Verifies `src.cuopt.solve_milp` selects the right backend (hosted when keyed, local otherwise /
on failure) and that `read_solution` parses the response shape both backends share. The hosted
and self-hosted transports are monkeypatched, so this runs anywhere — a stub `requests` is
injected so the module imports without the dependency.
"""
import sys
import types

import pytest

# src.cuopt imports `requests` at load; the tooling venv may not have it and we never touch the
# network here (transports are patched), so stub it before importing.
sys.modules.setdefault("requests", types.ModuleType("requests"))

from src import cuopt  # noqa: E402


def _resp(obj: float = -2.0, vars_: dict | None = None) -> dict:
    """A minimal optimal cuOpt LP/MILP response (the shape hosted AND self-hosted return)."""
    return {
        "response": {
            "solver_response": {
                "status": "Optimal",
                "solution": {
                    "primal_objective": obj,
                    "vars": vars_ if vars_ is not None else {"y0": 1.0, "y1": 0.0},
                },
            },
            "total_solve_time": 0.31,
        },
        "reqId": "test-1",
    }


def test_read_solution_parses_shared_shape():
    sol = cuopt.read_solution(_resp(obj=-3.0, vars_={"y0": 1.0}))
    assert sol["status"] == "Optimal"
    assert sol["objective"] == -3.0
    assert sol["vars"] == {"y0": 1.0}
    assert sol["solve_time"] == 0.31


def test_hosted_used_when_key_present(monkeypatch):
    monkeypatch.setattr(cuopt, "_solve_hosted", lambda *a, **k: _resp())
    monkeypatch.setattr(
        cuopt, "_solve_self_hosted",
        lambda *a, **k: pytest.fail("must not fall back when hosted succeeds"),
    )
    out = cuopt.solve_milp({"d": 1}, api_key="nvapi-x")
    assert out["_nemoray_solver"] == cuopt.SOLVER_HOSTED


def test_falls_back_to_local_on_hosted_failure(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("503 service unavailable")

    monkeypatch.setattr(cuopt, "_solve_hosted", boom)
    monkeypatch.setattr(cuopt, "_solve_self_hosted", lambda data, url: _resp())
    out = cuopt.solve_milp({"d": 1}, api_key="nvapi-x")
    assert out["_nemoray_solver"] == cuopt.SOLVER_LOCAL


def test_no_key_uses_local(monkeypatch):
    monkeypatch.setattr(cuopt, "_solve_self_hosted", lambda data, url: _resp())
    out = cuopt.solve_milp({"d": 1}, api_key="")
    assert out["_nemoray_solver"] == cuopt.SOLVER_LOCAL


def test_no_key_no_fallback_raises():
    with pytest.raises(RuntimeError, match="local fallback is disabled"):
        cuopt.solve_milp({"d": 1}, api_key="", allow_local_fallback=False)


def test_both_backends_fail_raises_combined(monkeypatch):
    def hosted_boom(*a, **k):
        raise RuntimeError("hosted down")

    def local_boom(*a, **k):
        raise RuntimeError("no local server")

    monkeypatch.setattr(cuopt, "_solve_hosted", hosted_boom)
    monkeypatch.setattr(cuopt, "_solve_self_hosted", local_boom)
    with pytest.raises(RuntimeError, match="hosted failed.*local fallback failed"):
        cuopt.solve_milp({"d": 1}, api_key="nvapi-x")


def test_normalize_wraps_bare_solver_response():
    raw = {
        "solver_response": {"status": "Optimal", "solution": {"primal_objective": 1.0, "vars": {}}},
    }
    norm = cuopt._normalize_response(raw)
    assert norm["response"] == raw
