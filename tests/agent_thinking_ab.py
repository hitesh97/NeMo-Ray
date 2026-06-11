"""A/B: does NEMOTRON_THINKING=on improve the agent's decisions enough to pay for
its latency?

Drives run_agent directly (same planner+tools the bridge uses) twice per case —
thinking off vs on — against the live NIM and twin, and compares: tools fired,
steps, errors, wall time, and the final answer. The thinking arm gets a larger
max_tokens budget so the think-trace can't truncate the JSON decision.

Run (NIM + twin up):
    TWIN_URL=http://localhost:8000 PYTHONPATH=agent agent/.venv/bin/python -m tests.agent_thinking_ab
"""
from __future__ import annotations

import os
import time

os.environ.setdefault("TWIN_URL", "http://localhost:8000")

from nemoray_modelling.agent import LlamaCppPlanner, run_agent  # noqa: E402

HIST = [
    {"role": "user", "content": "Fly to the Walkie-Talkie"},
    {"role": "assistant", "content": "The camera is now positioned at the Walkie-Talkie "
     "(20 Fenchurch Street), highlighted on the map."},
]
CASES = [
    ("nearest", "Where is the nearest fire station to the Shard?", None, None),
    ("masts", "How many masts are within a kilometre of Old Street?", None, None),
    ("pronoun", "What's around it?", None, HIST),
    ("outage", "Simulate masts TQ3461880911 and TQ3460081200 going offline",
     ["TQ3461880911", "TQ3460081200"], None),
    ("optimise", "Optimise new permanent mast placement to fix the coverage holes",
     None, None),
]


def run_case(prompt: str, thinking: bool, selected: list[str] | None,
             history: list[dict] | None = None) -> dict:
    os.environ["NEMOTRON_THINKING"] = "on" if thinking else "off"
    planner = LlamaCppPlanner(max_tokens=8192 if thinking else 2048)
    event = prompt
    if selected:
        event += ("\n\n[Operator has selected these mast ids on the map: "
                  + ", ".join(selected) + "]")
    tools, finals, errors = [], [], []
    t0 = time.time()
    for f in run_agent(event, planner=planner, history=history):
        t = f["type"]
        if t == "tool_call":
            tools.append(f["call"]["name"])
        elif t == "token":
            finals.append(f["text"])
        elif t == "error":
            errors.append(f["message"])
    return {"tools": tools, "final": "".join(finals).strip(),
            "errors": errors, "secs": round(time.time() - t0, 1)}


def main() -> None:
    for key, prompt, selected, history in CASES:
        print(f"\n━━━ {key}: {prompt!r}")
        for thinking in (False, True):
            arm = "think ON " if thinking else "think OFF"
            r = run_case(prompt, thinking, selected, history)
            print(f"  [{arm}] {r['secs']:>6.1f}s  tools={r['tools']}  "
                  f"errors={r['errors'] or 'none'}")
            print(f"            final: {r['final'][:140]}")


if __name__ == "__main__":
    main()
