// Seed public/raytracing from the committed ../out artifacts (a real pipeline run,
// LFS-tracked) so a fresh clone renders the coverage map before the first local solve.
// The pipeline publishes straight into public/raytracing (config.yaml paths.out_dir) and
// overwrites the seed; this never copies the other way. Runs via predev/prebuild.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "..", "public", "raytracing");
const src = join(here, "..", "..", "out");

if (!existsSync(join(dest, "summary.json")) && existsSync(join(src, "summary.json"))) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log("[nemoray] seeded public/raytracing from ../out (committed pipeline artifacts)");
}
