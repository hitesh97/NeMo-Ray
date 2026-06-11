"""NeMo-Ray Nemotron resilience agent.

A tool-calling ReAct agent that drives the coverage twin over HTTP (`TWIN_URL`) and
reasons with a local Nemotron Super NVFP4 (`NEMOTRON_BASE_URL`). Capabilities: simulate
mast outages (+ which emergency-service buildings lose service), relocate masts, optimise
new-mast placement (cuOpt + EA-LiDAR validation), deploy a Cell-on-Wheels from the
nearest fire station, and pick its live Starlink backhaul.
"""

from .agent import LlamaCppPlanner, run_agent
from .tools import ToolRegistry

__all__ = ["run_agent", "LlamaCppPlanner", "ToolRegistry"]
