import { API_BASE, USE_MOCK } from "@/lib/config";
import type { AgentRole, AgentStreamEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

interface AgentBody {
  prompt?: string;
  trigger?: { kind: "site_down"; siteId: string; siteName: string };
  history?: { role: AgentRole; content: string }[];
  selectedSiteIds?: string[];
  scenario?: string;
}

/**
 * Translate the HUD request into the Python agent's wire shape: conversation roles
 * map operator→user / agent→assistant (system turns are dropped), the map selection
 * becomes `selected_site_ids`, and the active scenario becomes `scenario` (the
 * backend's pre-rendered-outage selector). `prompt`/`trigger` pass straight through
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
    scenario: body.scenario,
  };
}

/**
 * Streaming Nemotron endpoint (SSE). Proxies the local Nemotron agent service
 * (agent/nemoray_modelling/server.py, default :8001) and passes its
 * `AgentStreamEvent` SSE frames straight through. If the agent service is
 * unreachable (or NEXT_PUBLIC_USE_MOCK=true forces UI-only mode), the endpoint
 * streams a single system notice over the same wire protocol so the console
 * renders cleanly instead of erroring.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as AgentBody;

  // Real backend: translate to the agent's wire shape and pass the SSE through.
  if (!USE_MOCK && API_BASE) {
    try {
      const upstream = await fetch(`${API_BASE}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toAgentPayload(body)),
      });
      if (upstream.ok && upstream.body) {
        return new Response(upstream.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      }
    } catch {
      // fall through to the notice below
    }
  }

  const id = "sys-no-backend";
  const notice: AgentStreamEvent[] = [
    { type: "message_start", id, role: "system" },
    {
      type: "token",
      text:
        `Nemotron agent service unreachable at ${API_BASE}. Start the stack ` +
        "(bash spark/up.sh, or `uvicorn nemoray_modelling.server:app --port 8001` " +
        "from agent/) and try again.",
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
