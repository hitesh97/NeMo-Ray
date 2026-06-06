# NeMo-Ray UI — Invariants

A short, deliberately small list of decisions that are **load-bearing**: each one already
cost a bug or breaks the demo when "cleaned up" by someone who didn't know why it was there.
This file exists so a collaborator (human or AI) can edit the UI confidently **without**
deleting core methodology by accident.

> **Map migration in progress.** The CesiumJS map surface and its layers were removed
> (commits "remove Cesium 3D map viewer…", "migrate to OSM building twin…"). The intended
> replacement is a **deck.gl** surface behind the same seam (Invariant 2), but it is **not
> built yet** — deck.gl is not installed and the centre stage is currently a plain backdrop
> (`AppShell.tsx`). Invariants below describe the contract the rebuild must honour, not
> code that exists today. Verify against the tree.

## How to read the tiers

- **🔒 LOCKED INVARIANT** — Change only with **explicit human intent and a stated reason.**
  If your task genuinely _requires_ changing one, say so out loud, explain the trade-off,
  and confirm before editing. These are protected, **not frozen** — they have an escape
  hatch, but the escape hatch is "be deliberate," not "silently refactor."
- **CONVENTION** — The house style. Follow it for consistency; deviate only with a reason.
- **FREE TO IMPROVE** — Everything else. `../../CONTRIBUTING.md` applies: a named tool is a
  starting point — swap in something better.

`CONTRIBUTING.md`'s "docs are a direction, not a contract" stance governs **product and
tooling** choices. **This file governs the narrow set of code-level locks** — don't cite
CONTRIBUTING.md to justify flipping one of these.

---

## 🔒 LOCKED INVARIANTS

### 1. `next.config.ts` — `reactStrictMode: false`
**Why:** A WebGL map surface creates a GL context the browser can't release fast enough for
React StrictMode's mount→unmount→remount cycle, causing "initialization failed" and a dead
map. This bit the old Cesium surface and will bite the deck.gl one the same way. Don't "fix"
a lint/warning by flipping it on. (The reason is also commented inline in the file — update
that comment when the deck.gl surface lands.)

### 2. The map seam — only `MapMount` reads the store, surfaces take props only
**Why:** Exactly one component (`components/map/MapMount.tsx`) touches the Zustand store for
the map; it assembles `MapSurfaceProps` (defined in `lib/types.ts`) and passes **props only**
to a swappable surface chosen by `NEXT_PUBLIC_MAP_IMPL` (`placeholder` | `deck`, see
`lib/config.ts`). A surface that imports the store directly breaks the placeholder↔deck swap
and the ability to dev/test without WebGL. **Status:** `MapSurfaceProps` and the `MapImpl`
flag survive in the code; `MapMount` and both surfaces were removed with Cesium and must be
**rebuilt against this contract** — do not let the rebuilt deck surface read the store.

### 3. State backbone is Zustand (`store/index.ts`) with selector hooks
**Why:** The app is built on a single Zustand store with selector hooks (`useSites`,
`useSelectedSite`, `usePanels`, …) — **not** React context, **not** Redux. Persisted panel
state hydrates in `app/providers.tsx` after mount (so SSR markup matches the default). New
shared UI state belongs in the store with a selector hook. Re-introducing React context for
shared state, or moving the hydration, causes panel flicker and re-render storms.

---

## CONVENTIONS (house style)

- **Compose from `components/primitives/`** — don't hand-roll panels/buttons/readouts.
- **Use design tokens / `.nm-*` classes** (`bg-panel`, `text-nv`, `var(--nv-green)`,
  `.nm-eyebrow`, `.nm-readout`) — never hardcode HUD hex in DOM chrome (lint-enforced;
  see `DESIGN-SYSTEM.md` §6). Raw token values live in `app/styles/tokens/`. (The rebuilt
  WebGL map surface may use raw colours for GL materials and is exempt, as Cesium was.)
- **Merge classes through `lib/cn.ts`** (`cn()`).
- **Keep the `prefers-reduced-motion` guard** when adding animations.
- **Conventional Commits**, single human author (no AI co-author trailers).

## FREE TO IMPROVE

Component internals, new panels/workspaces, scenario data, copy, the choice of map surface
to ship (`placeholder`/`deck`), and almost everything not listed above. Make it better.

## Cleanup owed (migration debt)

- The inline Cesium rationale in `next.config.ts` (the `reactStrictMode: false` comment, and
  the webpack `fs/path/...` fallbacks that existed for Cesium) should be reviewed/reworded for
  deck.gl (Invariant 1) — deck.gl may not need the same Node-polyfill fallbacks.
- `lib/config.ts` keeps `USE_MOCK`, but the mock data layer (`lib/mock/*`) was deleted — the
  agent route is real-backend-only now. Decide whether to restore a mock or drop the flag.
</content>
