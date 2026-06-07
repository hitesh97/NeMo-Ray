import { Cpu } from "lucide-react";

import { cn } from "@/lib/cn";

/** The technologies this twin is built on — credited in spec order. */
const TECHNOLOGIES = [
  "NVIDIA Sionna-RT",
  "NVIDIA cuOpt",
  "NVIDIA Nemotron 3 Super",
  "NVIDIA NIM",
  "ElevenLabs",
  "Starlink",
  "deck.gl",
  "OSM",
] as const;

/**
 * A compact credits strip for the bottom bar: the tech stack as dot-separated
 * labels, capped by the "Powered by NVIDIA DGX Spark" badge.
 */
export function TechStrip({ className }: { className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="nm-eyebrow shrink-0 text-ink-faint">Built with</span>
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {TECHNOLOGIES.map((tech, i) => (
          <span key={tech} className="flex shrink-0 items-center gap-1.5">
            {i > 0 && <span className="text-ink-faint/40">·</span>}
            <span className="whitespace-nowrap text-[10px] font-medium tracking-wide text-ink-dim">
              {tech}
            </span>
          </span>
        ))}
      </div>
      <span
        title="Running entirely local on NVIDIA DGX Spark (GB10)"
        className="flex shrink-0 items-center gap-1.5 border border-hairline bg-nv/[0.06] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-nv"
      >
        <Cpu size={11} className="shrink-0" />
        Powered by NVIDIA DGX Spark
      </span>
    </div>
  );
}
