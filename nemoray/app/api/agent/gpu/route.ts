import { API_BASE, USE_MOCK } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Nemotron GPU telemetry for the Stats board. Proxies the local DGX-Spark agent
 * service (`agent/nemoray_modelling/server.py` → `GET /gpu`, default :8001) when a real
 * backend is configured; otherwise reports `unavailable` so the panel degrades to
 * em-dashes (never a fabricated figure). The output-token rate is measured client-side
 * from the SSE stream and is not part of this payload.
 */
export async function GET(): Promise<Response> {
  if (USE_MOCK || !API_BASE) {
    return Response.json({ source: "unavailable" });
  }
  try {
    const upstream = await fetch(`${API_BASE}/gpu`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!upstream.ok) return Response.json({ source: "unavailable" });
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ source: "unavailable" });
  }
}
