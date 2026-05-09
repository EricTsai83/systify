import { useId, type ReactNode } from "react";

import { GitHubIcon, XIcon } from "@/components/icons";

import { FAQS, REPO_URL, X_URL } from "../data";
import { CornerMarks } from "../primitives/corner-marks";
import { InvitingCat } from "../primitives/inviting-cat";
import { Reveal } from "../primitives/reveal";
import { useShrinkToggle } from "../primitives/use-shrink-toggle";
import type { FaqEntry } from "../types";

/**
 * Half-duration of the toggle icon animation. The cross shrinks to a dot
 * in the first half, then expands into a minus (or back into a cross) in
 * the second half — so the full transition is `2 × ICON_SHRINK_MS`.
 */
const ICON_SHRINK_MS = 80;

const HEADING_ID = "faq-heading";

export function Faq() {
  return (
    <Reveal>
      <section
        id="faq"
        aria-labelledby={HEADING_ID}
        className="grid gap-8 lg:grid-cols-[auto_1fr] lg:items-start lg:gap-x-14 lg:gap-y-16"
      >
        <QuickAnswersPanel />
        <ul className="flex min-w-0 flex-col divide-y divide-border/60">
          {FAQS.map((item) => (
            <FaqItem key={item.q} item={item} />
          ))}
        </ul>
      </section>
    </Reveal>
  );
}

function FaqItem({ item }: { item: FaqEntry }) {
  const { isOpen, isShrinking, toggle } = useShrinkToggle(ICON_SHRINK_MS);
  const baseId = useId();
  const buttonId = `${baseId}-button`;
  const regionId = `${baseId}-region`;

  return (
    <li>
      <button
        type="button"
        id={buttonId}
        aria-expanded={isOpen}
        aria-controls={regionId}
        onClick={toggle}
        className={`group flex w-full cursor-pointer items-center justify-between gap-3 py-5 text-left transition-colors hover:text-foreground sm:gap-6 ${
          isOpen ? "text-foreground" : ""
        }`}
      >
        <span className="min-w-0 text-pretty text-[15.5px] font-semibold tracking-tight sm:text-lg">{item.q}</span>
        <ToggleIcon isOpen={isOpen} isShrinking={isShrinking} />
      </button>
      <div
        id={regionId}
        role="region"
        aria-labelledby={buttonId}
        aria-hidden={!isOpen}
        inert={!isOpen}
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div
            className={`pb-5 pr-2 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none sm:pr-12 ${
              isOpen ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
            }`}
          >
            <p className="text-pretty text-[14.5px] leading-relaxed text-muted-foreground sm:text-[15px]">{item.a}</p>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * The cross/minus glyph in the FAQ disclosure button.
 *
 * Built from two 1-px bars (horizontal + vertical) that animate independently:
 *   - `isShrinking` collapses the horizontal bar (and the vertical, when
 *     present) toward the center, hiding the glyph mid-toggle.
 *   - `isOpen` (after the shrink completes) hides the vertical bar so the
 *     remaining horizontal bar reads as a minus sign.
 *
 * Closed → cross visible. Open → only horizontal bar visible (minus).
 */
function ToggleIcon({ isOpen, isShrinking }: { isOpen: boolean; isShrinking: boolean }) {
  const horizontalHidden = isShrinking;
  const verticalHidden = isOpen || isShrinking;
  return (
    <span
      aria-hidden
      className="inline-flex size-9 shrink-0 items-center justify-center border border-border bg-card text-muted-foreground transition-colors duration-200 group-hover:border-foreground/30 group-hover:bg-muted group-hover:text-foreground"
    >
      <span className="relative size-3.5">
        <span
          className={`absolute left-0 top-1/2 h-px w-full origin-center -translate-y-1/2 bg-current transition-transform duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
            horizontalHidden ? "scale-x-0" : ""
          }`}
        />
        <span
          className={`absolute left-1/2 top-0 h-full w-px origin-center -translate-x-1/2 bg-current transition-transform duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
            verticalHidden ? "scale-y-0" : ""
          }`}
        />
      </span>
    </span>
  );
}

/**
 * Single bordered panel that frames the section heading, the inviting
 * cat, and the support CTAs as one cohesive unit.
 *
 * Stacked rows separated by hairline rules:
 *   1. heading    — `<h2>` (the section's accessible label)
 *   2. cat scene  — friendly SVG cat that blinks, tilts, twitches, and
 *                   emits gentle hearts. Reads as "come on in, I'm
 *                   friendly", which is the tone we want for a support
 *                   CTA — invitation, not just a greeting. See
 *                   `../primitives/inviting-cat.tsx`.
 *   3. CTA strip  — anchor to GitHub `issues/new`
 *   4. CTA strip  — anchor to the author's X profile
 *
 * Below `lg` the panel takes the full available width so the cat scene
 * has room to breathe; from `lg` upward it caps at `max-w-xs` so the
 * FAQ list to its right gets the bulk of the column. Only the CTA
 * strips are hyperlinks — wrapping the whole panel in `<a>` would
 * force screen readers to announce the heading as part of a link and
 * bury the `<h2>`'s landmark role.
 */
function QuickAnswersPanel() {
  return (
    <div className="relative w-full self-start overflow-hidden border border-border bg-card/70 backdrop-blur lg:max-w-xs">
      <CornerMarks />

      {/* Top strip — horizontal on mobile (heading left, cat right),
          stacked vertically on lg (sidebar mode). */}
      <div className="flex items-center lg:block">
        <div className="min-w-0 flex-1 px-4 py-3 sm:px-5 sm:py-4 lg:py-6">
          <p
            aria-hidden
            className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:mb-1.5 lg:mb-2"
          >
            Tech support
          </p>
          <h2
            id={HEADING_ID}
            className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-3xl lg:text-4xl"
          >
            Quick answers.
          </h2>
        </div>

        <InvitingCat />
      </div>

      {/* CTA strip — compact side-by-side buttons on mobile,
          full-width stacked rows on lg (sidebar). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2.5 sm:px-4 lg:flex-col lg:items-stretch lg:gap-0 lg:border-t-0 lg:p-0">
        <SupportLink
          href={`${REPO_URL}/issues/new`}
          ariaLabel="Open a new issue on GitHub"
          icon={
            <GitHubIcon className="size-3 text-muted-foreground transition-colors group-hover:text-foreground lg:size-3.5" />
          }
          shortLabel="open issue"
          fullLabel="open an issue"
        />
        <SupportLink
          href={X_URL}
          ariaLabel="Find the author on X"
          icon={
            <XIcon className="size-3 text-muted-foreground transition-colors group-hover:text-foreground lg:size-3.5" />
          }
          shortLabel="find on x"
          fullLabel="find me on x"
        />
      </div>
    </div>
  );
}

/**
 * One row in the support-CTA strip. The same anchor element renders two
 * different label strings — `shortLabel` on mobile and `fullLabel` on
 * `lg+` — using CSS `hidden`/`inline` swaps so a single DOM node serves
 * both layouts.
 *
 * The right-arrow glyph is desktop-only on purpose: on mobile the rows
 * are pill-shaped buttons sitting side by side, and the arrow would clip
 * awkwardly with the rounded edge.
 */
function SupportLink({
  href,
  ariaLabel,
  icon,
  shortLabel,
  fullLabel,
}: {
  href: string;
  ariaLabel: string;
  icon: ReactNode;
  shortLabel: string;
  fullLabel: string;
}) {
  return (
    <a
      href={href}
      rel="noreferrer"
      target="_blank"
      aria-label={ariaLabel}
      className="group flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 transition-colors hover:bg-muted/30 lg:justify-between lg:gap-2 lg:rounded-none lg:border-x-0 lg:border-b-0 lg:px-3.5 lg:py-2.5"
    >
      <span className="flex items-center gap-1.5 lg:gap-2">
        {icon}
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground transition-colors group-hover:text-foreground lg:text-[10px]">
          <span className="lg:hidden">{shortLabel}</span>
          <span className="hidden lg:inline">{fullLabel}</span>
        </span>
      </span>
      <span
        aria-hidden
        className="hidden text-base text-muted-foreground/70 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-foreground lg:inline"
      >
        →
      </span>
    </a>
  );
}
