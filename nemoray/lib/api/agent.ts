import type { AgentRole, AgentStreamEvent, ScenarioId } from "@/lib/types";

export interface AgentRequest {
  /** Either a free-text operator prompt… */
  prompt?: string;
  /** …or a structured trigger (e.g. site deactivation auto-narration). */
  trigger?: { kind: "site_down"; siteId: string; siteName: string };
  /**
   * Prior conversation turns so the backend Nemotron can track back. Assembled by
   * the store at send time; the `/api/agent` route translates roles to the agent's
   * user/assistant wire shape.
   */
  history?: { role: AgentRole; content: string }[];
  /** Mast ids the operator has selected on the map (outage / move targets). */
  selectedSiteIds?: string[];
  /** Active HUD scenario — selects the pre-rendered outage when no masts are selected. */
  scenario?: ScenarioId;
}

/**
 * Open the agent SSE stream and invoke `onEvent` for each parsed
 * {@link AgentStreamEvent}. Works for mock and real backends — the route
 * handler emits the same `text/event-stream` protocol either way.
 */
export async function openAgentStream(
  body: AgentRequest,
  onEvent: (e: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`/api/agent → ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as AgentStreamEvent);
      } catch {
        // ignore malformed frame
      }
    }
  }
}
