import type { ModeTone } from "./types";

/**
 * Tone → Tailwind class lookup.
 *
 * Tones are kept abstract in the data layer (`data.ts`) and resolved to
 * concrete classes here. Every value is a full class literal so Tailwind's
 * JIT picks them up — never template these strings.
 */
export const MODE_TONE_CLASSES: Record<ModeTone, { title: string; fill: string }> = {
  emerald: {
    title: "text-emerald-500",
    fill: "bg-emerald-500",
  },
  sky: {
    title: "text-sky-500",
    fill: "bg-sky-500",
  },
};
