"""
The Nemotron resilience agent — a real tool-calling ReAct loop (Workstream W1).

This replaces the one-shot translator in `nemotron.py` with an agent that
reasons over tools and *closes the loop*:

    run_sionna_coverage → run_cuopt → validate_site
                                          │ fail
                                          ▼
                              run_cuopt(exclude=…) → validate_site → accept

`run_agent()` is a generator that yields `AgentStreamEvent` frames (see
`events.py`) — the exact wire protocol the frontend's `/api/agent` SSE route
speaks. A `Planner` decides each step:

  • `LlamaCppPlanner` — drives the local Nemotron model via llama.cpp's
    OpenAI-compatible endpoint, using a strict JSON-action protocol (robust for
    reasoning GGUFs, where native `tools` support is patchy).

Swap to llama.cpp native tool-calling later by writing a Planner that sends
`registry.openai_tools()` and reads `message.tool_calls`; nothing else changes.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from typing import Any, Protocol

import httpx

from .events import error as error_event
from .events import (
    message_end,
    message_start,
    stream_reasoning,
    stream_text,
    tool_call,
    tool_update,
    uid,
)
from .tools import ToolRegistry, ToolSpec

# Host root of the OpenAI-compatible Nemotron endpoint (the planner appends
# "/v1/chat/completions"), so this must NOT end in /v1. Local NIM default :8080.
NEMOTRON_BASE_URL = os.getenv("NEMOTRON_BASE_URL", "http://localhost:8080").rstrip("/")
# Model id the endpoint serves (NIM exposes it at GET /v1/models).
NEMOTRON_MODEL = os.getenv("NEMOTRON_MODEL", "nemotron")
MAX_STEPS = 8

# Plain-English capabilities — the answer to "what is this / what can you do", and the
# safety-net reply if the model fumbles a conversational question under the JSON protocol.
HELP_TEXT = (
    "I'm the NeMo-Ray resilience agent for the EE 4G / UK Emergency Services Network over "
    "London, sitting on a GPU digital twin (Sionna RT ray tracing + cuOpt). I can: "
    "simulate a mast outage and show which police, fire and hospital buildings lose coverage; "
    "relocate a mast; optimise where to add new masts and verify it with ray tracing; and "
    "deploy a Cell-on-Wheels from the nearest fire station, then find the Starlink satellite it "
    "backhauls through. Try: “simulate the selected masts going offline”, "
    "“deploy a cell-on-wheels and check Starlink”, or “optimise new mast placement”."
)


# ── planner protocol ──────────────────────────────────────────────────────────
class Planner(Protocol):
    """Decides the next step given the running message history.

    Returns a decision dict, either:
        {"thought": str, "action": <tool name>, "args": {...}}
        {"thought": str, "final": <operator-facing message>}
    """

    def decide(self, messages: list[dict[str, str]]) -> dict[str, Any]: ...


def _system_prompt(tools: list[ToolSpec]) -> str:
    lines = [
        "You are the ESN (UK Emergency Services Network) resilience agent for NeMo-Ray.",
        "Given a network event, restore coverage by reasoning over tools.",
        "",
        "TOOLS:",
    ]
    for t in tools:
        props = ", ".join(t.parameters.get("properties", {}).keys())
        lines.append(f'  - {t.name}({props}): {t.description}')
    lines += [
        "",
        "PROTOCOL — each turn reply with ONLY a JSON object, no prose, no fences:",
        '  {"thought": "<one short sentence>", "action": "<tool>", "args": {...}}',
        '  {"thought": "<one short sentence>", "final": "<operator-facing summary>"}',
        "",
        "CONVERSATION: if the user asks what this is, what you can do, or any general question",
        "  that does NOT require a tool, reply IMMEDIATELY with a single",
        '  {"thought": "...", "final": "<your answer>"} — never call a tool, never repeat yourself.',
        "  You: simulate mast outages (showing which police/fire/hospital buildings lose service),",
        "  relocate masts, optimise new-mast placement (cuOpt + ray-trace verify), and deploy a",
        "  Cell-on-Wheels from the nearest fire station with a Starlink backhaul.",
        "",
        "POLICY (new-mast infill — when asked to fix coverage / add a mast):",
        "  1. run_sionna_coverage to find the dead zones the outage causes.",
        "  2. run_cuopt to get the best candidate mast for those dead zones.",
        "  3. validate_site on that candidate.",
        "  4. If validation FAILS, call run_cuopt again with the failed candidate_id",
        "     in `exclude`, then validate the new candidate.",
        "  5. Only once a site PASSES, reply with `final` recommending it and citing",
        "     the validation reason. Never call a tool twice with identical args.",
        "",
        "OTHER SCENARIOS — do the FEWEST steps, one tool per turn:",
        "  • Simulate an outage ('mast X down', 'what if X fails', 'simulate the selected masts'):",
        "    call simulate_outage(site_ids) with the named/selected ids, then STOP and reply `final`:",
        "    lead with which police/fire/hospital buildings lose coverage, then ASK the operator how",
        "    to restore it — exactly: 'How would you like to restore coverage — (1) optimise new",
        "    permanent masts with cuOpt, or (2) deploy a Cell-on-Wheels with Starlink backhaul?'.",
        "    Do NOT choose for them and do NOT call another tool this turn. Never call",
        "    simulate_outage with an empty site_ids list.",
        "  • If the operator then answers (1)/'optimise'/'new masts' → run the new-mast infill",
        "    policy above. If they answer (2)/'cow'/'cell-on-wheels' → deploy a CoW (next bullet).",
        "  • Deploy a Cell-on-Wheels / restore coverage: call deploy_cow DIRECTLY (no outage step",
        "    needed — it uses the current dead zones; one COW is garaged at every fire station,",
        "    towable ≤3 km, ~2 km coverage). Then call check_starlink(lat,lng) with the COW's",
        "    coordinates from deploy_cow's result. Then reply `final` naming the fire station, tow",
        "    distance, buildings protected, and the Starlink satellite.",
        "  • Relocate a mast to operator coords: move_mast(site_id,new_lat,new_lng).",
        "  • After a tool returns, either call the next required tool or reply `final` — never",
        "    repeat a tool with identical args, and never reply with prose outside `final`.",
    ]
    return "\n".join(lines)


def _recent_history(
    history: list[dict[str, str]] | None, max_turns: int
) -> list[dict[str, str]]:
    """Sanitise + cap prior turns to the last `max_turns` user/assistant messages.

    Drops anything that isn't a {role in {user,assistant}, content:str} pair so a
    malformed client payload can't break the prompt, and bounds the count so the
    context window stays small."""
    if not history:
        return []
    clean: list[dict[str, str]] = []
    for turn in history:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            clean.append({"role": role, "content": content})
    return clean[-max_turns:] if max_turns > 0 else []


# ── the loop ──────────────────────────────────────────────────────────────────
def run_agent(
    event: str,
    *,
    planner: Planner | None = None,
    base_url: str = NEMOTRON_BASE_URL,
    max_steps: int = MAX_STEPS,
    history: list[dict[str, str]] | None = None,
    max_history_turns: int = 8,
) -> Iterator[dict[str, Any]]:
    """Run the agent on a plain-English `event`, yielding AgentStreamEvent frames.

    `history` is prior conversation turns ([{role, content}, ...]) so Nemotron can
    "track back". It is capped to the last `max_history_turns` to keep the context
    window bounded (DGX memory) — the model never sees an unbounded transcript.
    """
    registry = ToolRegistry()
    planner = planner or LlamaCppPlanner(base_url=base_url, registry=registry)

    msg_id = uid("msg")
    yield message_start(msg_id)

    messages: list[dict[str, str]] = [
        {"role": "system", "content": _system_prompt(registry.specs())},
    ]
    for turn in _recent_history(history, max_history_turns):
        messages.append(turn)
    messages.append({"role": "user", "content": event})

    last_thought, stuck, tools_ran, last_result = None, 0, 0, None
    for _ in range(max_steps):
        try:
            decision = planner.decide(messages)
        except Exception as exc:  # network / parse failure — surface and stop
            yield error_event(f"planner failed: {exc}")
            yield message_end(msg_id)
            return

        thought = (decision.get("thought") or "").strip()
        if thought and thought != last_thought:   # don't echo a repeated thought
            yield from stream_reasoning(thought + " ")
        last_thought = thought

        # Terminal: the agent is done.
        if "final" in decision:
            yield from stream_text(decision["final"])
            yield message_end(msg_id)
            return

        name = decision.get("action")
        args = decision.get("args") or {}
        spec = registry.get(name) if name else None
        if spec is None:
            # No actionable tool and no final. Nudge once toward making progress; if it still
            # can't, close out: if tools already ran, summarise with the last result (the work
            # IS done — don't dump the capabilities blurb mid-flow); else it's a conversational
            # question, so answer helpfully. Never loop on prose.
            stuck += 1
            if stuck >= 2:
                yield from stream_text(last_result if (tools_ran and last_result) else HELP_TEXT)
                yield message_end(msg_id)
                return
            messages.append({"role": "assistant", "content": json.dumps(decision)})
            messages.append({"role": "user", "content":
                             ('Continue: call the next required tool, or if you are done reply '
                              'with ONLY {"thought":"...","final":"<answer>"}. '
                              "If this needs no tool, answer in `final` now.")})
            continue
        stuck = 0

        # Announce → run → report, as tool frames.
        call = tool_call(spec.name, spec.label, args=args)
        cid = call["call"]["id"]
        yield call
        yield tool_update(cid, status="running", progress=0.5)

        result = registry.run(spec.name, args)
        tools_ran += 1
        last_result = result.result
        # `data` carries the structured observation to the viewer so it can draw the
        # outcome (COW position, satellite, affected buildings, dead zones). The tools keep
        # observations LLM-context-lean, so they're small enough to stream.
        yield tool_update(cid, status="success", progress=1, result=result.result,
                          data=result.observation)

        # Feed the assistant's action + the tool observation back into the loop.
        messages.append({"role": "assistant", "content": json.dumps(decision)})
        messages.append(
            {
                "role": "user",
                "content": "OBSERVATION " + json.dumps(result.observation),
            }
        )

    # Ran out of steps without a `final` — close with the last useful result if we have one.
    yield from stream_text(
        last_result if last_result
        else "I've gathered the results above — tell me how you'd like to proceed."
    )
    yield message_end(msg_id)


# ── real planner (OpenAI-compatible Nemotron) ──────────────────────────────────
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def _strip_fences(text: str) -> str:
    """Strip a reasoning model's wrappers: <think>…</think> blocks and ```json fences."""
    s = _THINK.sub("", text).strip()
    if not s.startswith("```"):
        return s
    body = s.split("```", 2)
    inner = body[1] if len(body) > 1 else s
    if inner.lower().startswith("json"):
        inner = inner[4:]
    return inner.strip().rstrip("`").strip()


def _extract_json(text: str) -> dict[str, Any]:
    """Parse the model's reply into a decision dict, tolerating stray prose."""
    s = _strip_fences(text)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # Last resort: grab the outermost {...} span.
        start, end = s.find("{"), s.rfind("}")
        if start != -1 and end > start:
            return json.loads(s[start : end + 1])
        raise


class LlamaCppPlanner:
    """Drives Nemotron via an OpenAI-compatible /v1/chat/completions endpoint
    (local NIM, llama.cpp, vLLM — all the same wire format)."""

    def __init__(
        self,
        *,
        base_url: str = NEMOTRON_BASE_URL,
        model: str = NEMOTRON_MODEL,
        registry: ToolRegistry | None = None,
        temperature: float = 0.2,
        max_tokens: int = 2048,
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.registry = registry  # reserved for native tool-calling mode later
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout = timeout
        # Nemotron-3 is a reasoning model. For our strict JSON-action protocol we want a
        # short, direct decision, so disable the <think> phase by default (else the model
        # burns the token budget reasoning and may truncate before the JSON). Override with
        # NEMOTRON_THINKING=on. Honoured by vLLM/NIM via chat_template_kwargs.
        self.thinking = os.getenv("NEMOTRON_THINKING", "off").strip().lower() == "on"

    def decide(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        content = self._complete(messages)
        try:
            return _extract_json(content)
        except (json.JSONDecodeError, ValueError):
            # One repair attempt: show the model its own bad output and demand
            # strict JSON. Reasoning GGUFs occasionally wrap or trail prose.
            repair = messages + [
                {"role": "assistant", "content": content},
                {
                    "role": "user",
                    "content": "That was not valid JSON. Reply with ONLY the JSON "
                    "object for this turn — no prose, no markdown fences.",
                },
            ]
            return _extract_json(self._complete(repair))

    def _complete(self, messages: list[dict[str, str]]) -> str:
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if not self.thinking:
            # vLLM/NIM extension: turn off the reasoning phase for a fast, direct answer.
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        with httpx.Client(base_url=self.base_url, timeout=self.timeout) as client:
            r = client.post("/v1/chat/completions", json=payload)
            r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
        # With a reasoning parser the answer is in `content` and the think trace in
        # `reasoning_content`; fall back to reasoning_content if content is empty.
        return msg.get("content") or msg.get("reasoning_content") or ""


# ── offline planner (no LLM) ───────────────────────────────────────────────────
class StubPlanner:
    """A deterministic, keyword-routed planner for when no Nemotron endpoint is
    available — so the whole pipeline (tools + twin + frames) still runs end-to-end
    for CI, offline dev, and a safe demo fallback. It reads the running `messages`
    (counting prior OBSERVATIONs as the step index, and parsing the last one for a
    candidate/COW the next tool needs) and follows a fixed script per scenario.

    `selected_site_ids` are the masts the operator clicked on the map; the stub uses
    them as the outage targets (the real model reads them from the event text)."""

    def __init__(self, selected_site_ids: list[str] | None = None) -> None:
        self.selected = list(selected_site_ids or [])

    def decide(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        event, step, last_obs = self._inspect(messages)
        low = event.lower()

        if any(k in low for k in ("what can you", "what is this", "what does", "help", "capabilit",
                                  "who are you", "how do i", "what are you")):
            return {"thought": "Explaining the system.", "final": HELP_TEXT}
        # Operator answering the post-outage "(1) cuOpt or (2) CoW?" question with a bare choice.
        ev = low.strip().strip(".!()? ")
        if ev in ("1", "one", "option 1"):
            return self._optimise_script(step, last_obs)
        if ev in ("2", "two", "option 2"):
            return self._deploy_script(step, last_obs)
        if any(k in low for k in ("down", "offline", "outage", "fail", "break", "lost")):
            return self._outage_script(step, last_obs)
        if any(k in low for k in ("cell-on-wheels", "cell on wheels", "cow", "deploy")):
            return self._deploy_script(step, last_obs)
        if any(k in low for k in ("optimi", "add mast", "new mast", "fill", "coverage hole",
                                  "fix coverage", "infill")):
            return self._optimise_script(step, last_obs)
        if any(k in low for k in ("starlink", "satellite", "backhaul")):
            if step == 0:
                return {"thought": "Checking Starlink backhaul.", "action": "check_starlink",
                        "args": {}}
            return {"thought": "Reporting the backhaul.",
                    "final": self._starlink_final(last_obs)}
        # Default: a one-line status, no tools.
        return {"thought": "No specific action requested; giving a status read.",
                "final": "Network nominal. Ask me to simulate a mast outage, optimise new "
                         "mast placement, deploy a Cell-on-Wheels, or check Starlink backhaul."}

    # ── scenario scripts ────────────────────────────────────────────────────────
    def _outage_script(self, step: int, last_obs: dict[str, Any]) -> dict[str, Any]:
        if step == 0:
            return {"thought": "Simulating the outage to find the dead zones and who they hit.",
                    "action": "simulate_outage", "args": {"site_ids": self.selected}}
        # After the outage, report the impact and ASK how to restore — don't pick for them.
        counts = last_obs.get("affected_counts") or {}
        hit = ", ".join(f"{v} {k}" for k, v in counts.items() if v) or "no emergency-service buildings"
        dz = last_obs.get("dead_zone_count", "several")
        return {"thought": "Reporting impact and asking how to restore.",
                "final": f"The outage opens {dz} dead zone(s), knocking out coverage for {hit}. "
                         "How would you like to restore coverage — (1) optimise new permanent masts "
                         "with cuOpt, or (2) deploy a Cell-on-Wheels with Starlink backhaul?"}

    def _deploy_script(self, step: int, last_obs: dict[str, Any]) -> dict[str, Any]:
        if step == 0:
            return {"thought": "Finding the best Cell-on-Wheels deployment from the nearest fire station.",
                    "action": "deploy_cow", "args": {}}
        if step == 1:
            cow = last_obs.get("cow") or {}
            return {"thought": "Finding the Starlink satellite the COW backhauls through.",
                    "action": "check_starlink", "args": {"lat": cow.get("lat"), "lng": cow.get("lng")}}
        return {"thought": "Summarising the deployment.", "final": self._starlink_final(last_obs)}

    def _optimise_script(self, step: int, last_obs: dict[str, Any]) -> dict[str, Any]:
        if step == 0:
            return {"thought": "Finding the current dead zones.",
                    "action": "run_sionna_coverage", "args": {"disabled_cells": []}}
        if step == 1:
            return {"thought": "Asking cuOpt for the best new-mast placement.",
                    "action": "run_cuopt", "args": {"dead_zone_ids": []}}
        cand = last_obs.get("candidate") or {}
        cid = cand.get("candidate_id")
        if step == 2:
            return {"thought": "Validating the proposed site against line-of-sight.",
                    "action": "validate_site",
                    "args": {"candidate_id": cid, "lat": cand.get("lat"),
                             "lng": cand.get("lng")}}
        if step == 3 and last_obs.get("verdict") == "fail":
            return {"thought": "That site failed; asking cuOpt for an alternative.",
                    "action": "run_cuopt", "args": {"dead_zone_ids": [], "exclude": [cid]}}
        if last_obs.get("verdict") == "fail" or "candidate" in last_obs:
            return {"thought": "Validating the alternative site.",
                    "action": "validate_site",
                    "args": {"candidate_id": cid, "lat": cand.get("lat"),
                             "lng": cand.get("lng")}}
        return {"thought": "Recommending the validated site.",
                "final": f"Recommend new mast at the validated candidate "
                         f"({last_obs.get('reason', 'clear line-of-sight')})."}

    # ── helpers ──────────────────────────────────────────────────────────────────
    @staticmethod
    def _starlink_final(last_obs: dict[str, Any]) -> str:
        sat = last_obs.get("satellite")
        if sat:
            return (f"Restoration plan ready: deploy a Cell-on-Wheels and backhaul via "
                    f"{sat} ({last_obs.get('elevation_deg', '?')}° elevation, "
                    f"{last_obs.get('slant_range_km', '?')} km). Emergency buildings re-covered.")
        return "Restoration assessed. See the tool results for the deployment details."

    @staticmethod
    def _inspect(messages: list[dict[str, str]]):
        """Return (event_text, step_index, last_observation_dict).

        The event is the LAST user message before the tool loop begins — i.e. just
        before the first OBSERVATION. Scanning to the first OBSERVATION (not the first
        user message) is important once prior conversation turns are prepended as
        history, so we don't mistake an old history turn for the current request."""
        event = ""
        for m in messages:
            if m["role"] != "user":
                continue
            if m["content"].startswith("OBSERVATION"):
                break                       # tool loop reached → stop; `event` is set
            event = m["content"]            # keep the latest pre-loop user message
        step = 0
        last_obs: dict[str, Any] = {}
        for m in messages:
            if m["role"] == "user" and m["content"].startswith("OBSERVATION"):
                step += 1
                try:
                    last_obs = json.loads(m["content"][len("OBSERVATION "):])
                except (json.JSONDecodeError, ValueError):
                    last_obs = {}
        return event, step, last_obs
