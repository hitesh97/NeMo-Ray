"""NeMo-Ray Nemotron resilience agent.

A tool-calling ReAct agent that drives the coverage twin over HTTP (`TWIN_URL`) and
reasons with a local Nemotron (`NEMOTRON_BASE_URL`). Capabilities: simulate mast
outages (+ which emergency-service buildings lose service), relocate masts, optimise
new-mast placement, deploy a Cell-on-Wheels from the nearest fire station, and pick its
Starlink backhaul. Falls back to deterministic fixtures (tools) and a StubPlanner (LLM)
so it runs offline.
"""

from .agent import LlamaCppPlanner, StubPlanner, run_agent
from .tools import ToolRegistry

__all__ = ["run_agent", "LlamaCppPlanner", "StubPlanner", "ToolRegistry"]
