import type { ComponentType, SVGProps } from "react";

export type StackItem = {
  name: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  role: string;
};

export type NarrativeEntry = {
  num: string;
  lead: string;
  trail: string;
};

/**
 * The top-level mode knowledge layers, in order of depth (shallow → deep).
 * Sandbox is intentionally not listed here because it is a per-message
 * Discuss grounding toggle, not a separate top-level mode.
 */
export const LAYERS = ["model", "design artifacts"] as const;

export type Layer = (typeof LAYERS)[number];

/**
 * Each mode owns a {@link ModeTone}. The tone shows up in two
 * load-bearing places — title color and the "lit" sources fill. Panel
 * border and scenario bullets stay neutral so the tone reads as
 * content, not chrome.
 *
 * Concrete Tailwind classes for each tone live in `mode-tones.ts` so
 * the data stays presentation-free.
 */
export type ModeTone = "emerald" | "sky";

export type Mode = {
  name: string;
  pitch: string;
  /** 1..2 — number of layers from {@link LAYERS} (in order) that this mode reads. */
  depth: 1 | 2;
  /** Concrete situations where this mode is the right pick — the user's "when do I use this?" answer. */
  scenarios: ReadonlyArray<string>;
  tone: ModeTone;
};

export type FaqEntry = {
  q: string;
  a: string;
};

export type CommandStep = string;

/**
 * Anchor entry for the sticky `<SiteHeader />` nav. The `href` is always a
 * fragment (`#…`) — external links don't belong in the in-page nav.
 */
export type HeaderNavLink = {
  href: `#${string}`;
  label: string;
};

/**
 * One bullet under the `<SelfHost />` headline. Modeled as an object (not
 * a bare string) so the data layer can grow new fields — e.g. an icon or
 * a tooltip — without breaking call sites.
 */
export type SelfHostFeature = {
  label: string;
};
