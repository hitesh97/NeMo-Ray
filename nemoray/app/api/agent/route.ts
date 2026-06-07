import { API_BASE, USE_MOCK } from "@/lib/config";
import type { AgentRole, AgentStreamEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

interface AgentBody {
  prompt?: string;
  trigger?: { kind: "site_down"; siteId: string; siteName: string };
  history?: { role: AgentRole; content: string }[];
  selectedSiteIds?: string[];
}

/**
 * Translate the HUD request into the Python agent's wire shape: conversation roles
 * map operator→user / agent→assistant (system turns are dropped), and the map
 * selection becomes `selected_site_ids`. `prompt`/`trigger` pass straight through
 * (the trigger's siteId/siteName already match the backend's pydantic model).
 */
function toAgentPayload(body: AgentBody): Record<string, unknown> {
  const history = (body.history ?? [])
    .filter((t) => t.role === "operator" || t.role === "agent")
    .map((t) => ({ role: t.role === "operator" ? "user" : "assistant", content: t.content }));
  return {
    prompt: body.prompt,
    trigger: body.trigger,
    history: history.length > 0 ? history : undefined,
    selected_site_ids: body.selectedSiteIds,
  };
}

/**
 * Streaming Nemotron endpoint (SSE). Real mode proxies the local Nemotron agent
 * service (agent/nemoray_modelling/server.py, default :8001); the scripted mock
 * runs were removed with the rest of the demo data. Without a backend the endpoint
 * streams a single notice over the same `AgentStreamEvent` wire protocol so the
 * console renders cleanly.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as AgentBody;

  // Real backend: translate to the agent's wire shape and pass the SSE through.
  if (!USE_MOCK && API_BASE) {
    const upstream = await fetch(`${API_BASE}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toAgentPayload(body)),
    });
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  const id = "sys-no-backend";
  const notice: AgentStreamEvent[] = [
    { type: "message_start", id, role: "system" },
    {
      type: "token",
      text:
        "Nemotron backend not connected. Set NEXT_PUBLIC_USE_MOCK=false and " +
        "NEXT_PUBLIC_API_BASE to reach the DGX-Spark agent service.",
    },
    { type: "message_end", id },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of notice) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
