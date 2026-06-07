"""
AgentStreamEvent frame builders.

These are the *exact* SSE frames the NeMo-Ray frontend consumes — the wire
protocol declared in `nemoray/lib/types.ts` (`AgentStreamEvent`). The Python
agent yields dicts shaped like these so the stream is drop-in compatible with
`/api/agent` (mock or real). Keep this in lock-step with `types.ts`:

    | { type: "message_start"; id; role }
    | { type: "token"; text }
    | { type: "reasoning"; text }
    | { type: "tool_call"; call: ToolCall }
    | { type: "tool_update"; id; patch: Partial<ToolCall> }
    | { type: "message_end"; id }
    | { type: "error"; message }

A `ToolCall` is { id, name, label, status, args?, result?, progress?,
startedAt?, finishedAt? } with status in queued|running|success|error.
"""

from __future__ import annotations

import itertools
import re
from collections.abc import Iterator
from typing import Any

# Monotonic id source. The frontend only needs ids to be stable *within* a
# stream (to correlate tool_call ↔ tool_update), not globally unique.
_counter = itertools.count(1)


def uid(prefix: str) -> str:
    return f"{prefix}-{next(_counter)}"


# ── message + token frames ────────────────────────────────────────────────────
def message_start(message_id: str, role: str = "agent") -> dict[str, Any]:
    return {"type": "message_start", "id": message_id, "role": role}


def message_end(message_id: str) -> dict[str, Any]:
    return {"type": "message_end", "id": message_id}


def token(text: str) -> dict[str, Any]:
    return {"type": "token", "text": text}


def reasoning(text: str) -> dict[str, Any]:
    return {"type": "reasoning", "text": text}


def error(message: str) -> dict[str, Any]:
    return {"type": "error", "message": message}


def _tokenize(text: str) -> list[str]:
    """Split into word-ish chunks so streaming looks natural (mirrors the FE mock)."""
    return re.findall(r"\S+\s*", text) or [text]


def stream_text(text: str) -> Iterator[dict[str, Any]]:
    """Yield `token` frames for each word-ish chunk of `text`."""
    for chunk in _tokenize(text):
        yield token(chunk)


def stream_reasoning(text: str) -> Iterator[dict[str, Any]]:
    """Yield `reasoning` frames (the collapsed thought trace) chunk by chunk."""
    for chunk in _tokenize(text):
        yield reasoning(chunk)


# ── tool frames ───────────────────────────────────────────────────────────────
def tool_call(
    name: str,
    label: str,
    *,
    call_id: str | None = None,
    args: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A `tool_call` frame announcing a queued tool. Returns the frame; read the
    call id back via `frame["call"]["id"]` to correlate later updates."""
    cid = call_id or uid(f"tc-{name}")
    call: dict[str, Any] = {
        "id": cid,
        "name": name,
        "label": label,
        "status": "queued",
        "progress": 0,
    }
    if args is not None:
        call["args"] = args
    return {"type": "tool_call", "call": call}


def tool_update(call_id: str, **patch: Any) -> dict[str, Any]:
    """A `tool_update` frame patching an in-flight tool (status/progress/result)."""
    return {"type": "tool_update", "id": call_id, "patch": patch}


# ── map directives ──────────────────────────────────────────────────────────────
def map_action(action: dict[str, Any]) -> dict[str, Any]:
    """A `map_action` frame: a UI directive that mutates the operator's map — highlight
    dead-zone ground, highlight buildings, place a COW + its source station, or fly the
    camera. `action` is the discriminated `{op: ...}` dict the HUD reduces into AgentMapState
    (see `nemoray/lib/types.ts` `MapAction`). Tools attach these as `ToolResult.ui_actions`;
    `run_agent` yields one frame per action after the tool succeeds. All geometry is WGS84,
    coordinates as [lng, lat]."""
    return {"type": "map_action", "action": action}
