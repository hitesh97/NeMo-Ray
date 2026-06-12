import { API_BASE, USE_MOCK } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Full-state reset behind the console's Reset button: proxies the agent bridge's
 * POST /reset, which has the twin restore its baseline snapshot (coverage, holes,
 * plan, proposed-mast rays). The store clears the client side and re-fetches the
 * artifacts when this resolves.
 */
export async function POST(): Promise<Response> {
  if (USE_MOCK || !API_BASE) {
    return Response.json({ reset: false, error: "backend not connected" });
  }
  try {
    const upstream = await fetch(`${API_BASE}/reset`, { method: "POST" });
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ reset: false, error: "agent service unreachable" });
  }
}
