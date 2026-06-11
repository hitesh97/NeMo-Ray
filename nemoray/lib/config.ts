/**
 * Runtime configuration + feature flags.
 *
 * The UI never branches on raw env vars directly — it reads these typed
 * constants so backend wiring lives in one place.
 */

/**
 * Opt-in UI-only mode: when NEXT_PUBLIC_USE_MOCK=true the API routes skip the
 * backend entirely (the agent console explains how to connect). Default is the
 * real local stack.
 */
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

/** Base URL of the local agent SSE bridge (agent/nemoray_modelling/server.py). */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8001";

/** App identity shown in the chrome. */
export const APP = {
  org: "NeMo-Ray",
  product: "NeMo-Ray",
  subtitle: "DIGITAL TWIN // REAL-TIME",
  region: "London",
  network: "Emergency Services Network (ESN)",
  operator: "GPU Goblins",
} as const;
