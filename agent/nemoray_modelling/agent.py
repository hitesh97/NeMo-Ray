"""
The Nemotron resilience agent — a tool-calling ReAct loop that *closes the loop*:

    run_sionna_coverage → run_cuopt → validate_site
                                          │ fail
                                          ▼
                              run_cuopt(exclude=…) → validate_site → accept

`run_agent()` is a generator that yields `AgentStreamEvent` frames (see
`events.py`) — the exact wire protocol the frontend's `/api/agent` SSE route
speaks. A `Planner` decides each step:

  • `LlamaCppPlanner` — drives the local Nemotron Super NVFP4 via vLLM's
    OpenAI-compatible endpoint, using a strict JSON-action protocol.

Swap to native tool-calling later by writing a Planner that sends
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
    map_action,
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
NEMOTRON_MODEL = os.getenv("NEMOTRON_MODEL", "nemotron-3-super")
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
        "  5. Only once a site PASSES, reply with `final` recommending it THOROUGHLY — name the",
        "     candidate, its coverage gain % and estimated cost, and the validation reason.",
        "     Never call a tool twice with identical args.",
        "",
        "OTHER SCENARIOS — do the FEWEST steps, one tool per turn:",
        "  • Simulate an outage ('simulate these masts going down', 'mast X down', 'what if X",
        "    fails', 'simulate the selected masts', 'simulate this scenario's outage'): call",
        "    simulate_outage — pass the named/selected ids if the operator gave any, otherwise",
        "    call it with NO site_ids and it simulates the active scenario's pre-rendered outage",
        "    (you do NOT need the operator to pick masts first). Then STOP and reply `final`:",
        "    lead with which police/fire/hospital buildings lose coverage, then ASK the operator",
        "    how to restore it — exactly: 'How would you like to restore coverage — (1) optimise",
        "    new permanent masts with cuOpt, or (2) deploy a Cell-on-Wheels with Starlink",
        "    backhaul?'. Do NOT choose for them and do NOT call another tool this turn.",
        "    THIS RULE WINS whenever the operator says 'simulate' or 'what if' — even when masts",
        "    are selected on the map. simulate_outage is the ONLY tool you call that turn.",
        "  • OPERATOR TAKES CLICKED MASTS DOWN — ONLY when the operator has SELECTED masts on",
        "    the map (selected_site_ids present) AND orders them down WITHOUT the word",
        "    'simulate' ('take it down', 'take these offline', 'knock these out'): do the WHOLE",
        "    response in one shot, no asking —",
        "    simulate_outage (the selected ids), then run_cuopt for the permanent new-mast plan,",
        "    then deploy_cow with keep_overlay=true so the Cell-on-Wheels and its coverage circle",
        "    layer over the dead zone. THEN reply `final`: which buildings lost coverage, cuOpt's",
        "    recommended mast (gain % + cost, gold on the map), and the COW's source fire station +",
        "    tow + restoration ETA with its coverage radius now covering the gap.",
        "  • RUN / PLAY a scenario end-to-end ('run this scenario', 'play the outage', 'respond to",
        "    the outage', 'full incident response'): do the WHOLE resilience flow without asking —",
        "    simulate_outage, then deploy_cow with keep_overlay=true (so the affected-building",
        "    markers stay on the map under the COW), then check_starlink(lat,lng) with the COW's",
        "    coordinates from deploy_cow. THEN reply `final` with a THOROUGH operator summary:",
        "    which police/fire/hospital buildings lost coverage, the COW's source fire station +",
        "    tow distance + restoration ETA (minutes, incl. the traffic factor), and the Starlink",
        "    satellite — then offer a permanent cuOpt fix.",
        "  • If the operator then answers (1)/'optimise'/'new masts' → run the new-mast infill",
        "    policy above. If they answer (2)/'cow'/'cell-on-wheels' → deploy a CoW (next bullet).",
        "  • Deploy a Cell-on-Wheels / restore coverage: call deploy_cow DIRECTLY (no outage step",
        "    needed — it uses the current dead zones; one COW is garaged at every fire station,",
        "    towable ≤3 km, ~0.8 km coverage). Then call check_starlink(lat,lng) with the COW's",
        "    coordinates from deploy_cow's result. Then reply `final` naming the fire station, tow",
        "    distance, buildings protected, and the Starlink satellite.",
        "  • Relocate a mast to operator coords: move_mast(site_id,new_lat,new_lng).",
        "  • 'Where is the nearest hospital / police station / fire station?' (or 'show me the",
        "    closest X'): call find_nearest(kind) — kind ∈ hospital|police|fire. It highlights",
        "    the building on the map and flies to it; then reply `final` naming it and the distance.",
        "  • 'Show me / fly to / where is <a NAMED place>' — a landmark, area, transport hub,",
        "    stadium, park, or a named station/hospital (e.g. 'Tower Bridge', \"Guy's Hospital\"):",
        "    call locate_place(query=<the name>); it flies the camera there. Then reply `final`.",
        "  • 'What's near / around <place>' (or 'what hospitals/fire stations are around X'):",
        "    call nearby_places(query=<place>[, categories]) — it lists nearby landmarks and",
        "    emergency services and frames the camera on them. Then reply `final`.",
        "  • PRONOUN FOLLOW-UPS — 'what's around IT', 'show me THAT area', 'zoom in THERE':",
        "    the pronoun means the place/mast the conversation just located. Either pass its",
        "    resolved name as `query`, or simply call the tool with NO args — nearby_places /",
        "    find_masts / check_starlink automatically use the operator's most recent reference",
        "    (the place just located, the COW just deployed). NEVER ask the operator to repeat",
        "    a place they just named, and never answer a spatial follow-up with prose.",
        "  • 'How big is the network / what's the coverage / give me a network overview':",
        "    call describe_network() — masts, buildings, % served, dead zones — then `final`.",
        "  • 'How many masts / what towers are around <place>' or 'tell me about mast <id>':",
        "    call find_masts(query=<place>) or find_masts(mast_id=<id>) — counts/heights/bands,",
        "    framed on the map. Then reply `final`.",
        "  • 'Remove/clear the proposed masts', 'reject the plan', 'reset', 'start over':",
        "    call clear_proposals() — it removes the whole cuOpt plan + its rays from the map",
        "    and restores the baseline network. Then reply `final` confirming what was removed.",
        "  • After a tool returns, either call the next required tool or reply `final` — never",
        "    repeat a tool with identical args, and never reply with prose outside `final`.",
        "",
        "ANSWERS: your `final` is the operator's briefing — WRITE IT YOURSELF from the tool",
        "  OBSERVATIONs, never from memory and never invent numbers. Quote the real figures the",
        "  tools returned: the affected police/fire/hospital counts, the COW's source fire station",
        "  + tow distance + restoration ETA in minutes (and the traffic factor), the Starlink",
        "  satellite (name, elevation), and cuOpt's coverage-gain % + estimated cost. Be specific,",
        "  thorough and plain-spoken (2–4 sentences) — not a template; describe THIS incident.",
        "",
        "MAP: every tool automatically highlights its result on the operator's map (the affected",
        "  buildings, the COW + the fire station to retrieve it from, the proposed mast site, or a",
        "  located building) and flies the camera there. So just call the right tool — do NOT",
        "  recite coordinates; refer to what is now shown ('highlighted on the map').",
    ]
    return "\n".join(lines)


def _slim_observation(obs: dict[str, Any], max_chars: int = 4000) -> dict[str, Any]:
    """A context-budget copy of a tool observation for the LLM. Long candidate/result
    lists carry full detail to the HUD via the tool_update frame; the model only needs
    the head of the list to decide its next step."""
    text = json.dumps(obs)
    if len(text) <= max_chars:
        return obs
    slim = dict(obs)
    for key in ("candidates", "results", "masts", "dead_zones", "affected_buildings",
                "alternatives"):
        v = slim.get(key)
        if isinstance(v, list) and len(v) > 10:
            slim[key] = v[:10] + [{"note": f"... {len(v) - 10} more omitted for brevity"}]
    text = json.dumps(slim)
    if len(text) > max_chars * 2:  # pathological payload — hard cap, keep valid JSON out
        return {"summary": text[: max_chars * 2] + "…(truncated)"}
    return slim


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
        # The tool may also drive the operator's map (highlight dead zones, place the COW +
        # its source station, focus a building). These ride a separate map_action frame so
        # the geometry never bloats the LLM-facing observation above.
        for action in getattr(result, "ui_actions", None) or []:
            yield map_action(action)

        # Feed the assistant's action + the tool observation back into the loop. The HUD
        # gets the FULL observation (tool_update data above); the model's copy is slimmed —
        # a 45-candidate cuOpt dump across several steps can blow the 16k context window
        # and 400 the NIM mid-run.
        messages.append({"role": "assistant", "content": json.dumps(decision)})
        messages.append(
            {
                "role": "user",
                "content": "OBSERVATION " + json.dumps(_slim_observation(result.observation)),
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
