# NeMo-Ray HUD

This is the **NeMo-Ray mission-control HUD** — a Next.js 16 / React 19 / Tailwind v4 / Zustand
dashboard that visualises UK ESN 4G/LTE coverage as an interactive digital twin, pairing a
streaming Nemotron agent with a deck.gl map.

## Run it

```bash
pnpm install
pnpm dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Data

The HUD reads coverage artifacts published by the Python pipeline into
`nemoray/public/raytracing/` (GeoJSON, PNG, and a run `summary.json`). Regenerate them by
running the pipeline from the repo root; the map and KPI panels pick up fresh runs automatically.

See the [root README](../README.md) for the full project — the Sionna RT coverage pipeline,
the cuOpt mast optimiser, and the Nemotron resilience agent.
