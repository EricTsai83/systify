import { useCallback, useRef } from "react";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/icons";
import { REPO_URL } from "../data";
import { replayAnimationsIn } from "../primitives/replay-animations";
import { HeroChat } from "./hero-chat";

/**
 * Stagger schedule for the headline → tagline → buttons → stats column.
 * Pulled to module scope so the entry beat is at-a-glance editable in one
 * place rather than scattered across `style={{ animationDelay }}` literals.
 *
 * Numbers are in milliseconds.
 */
const HERO_STAGGER = {
  headlineLine1: 0,
  headlineLine2: 120,
  tagline: 220,
  ctas: 320,
  stat: 420,
} as const;

export function Hero() {
  const chatRef = useRef<HTMLDivElement>(null);

  const handleReplay = useCallback(() => {
    if (chatRef.current) replayAnimationsIn(chatRef.current);
  }, []);

  return (
    <section id="top" className="grid items-center gap-14 pt-6 lg:grid-cols-[1.25fr_1fr] lg:gap-12">
      <div className="flex min-w-0 flex-col gap-7">
        <StatusPill />
        <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl sm:leading-[1.02] lg:text-[clamp(3rem,5vw,3.75rem)]">
          <span
            className="block animate-fade-up sm:whitespace-nowrap"
            style={{ animationDelay: `${HERO_STAGGER.headlineLine1}ms` }}
          >
            Your codebase,
          </span>
          <span
            className="block animate-fade-up text-primary sm:whitespace-nowrap"
            style={{ animationDelay: `${HERO_STAGGER.headlineLine2}ms` }}
          >
            explained in place.
          </span>
        </h1>
        <p
          className="max-w-xl animate-fade-up text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg"
          style={{ animationDelay: `${HERO_STAGGER.tagline}ms` }}
        >
          An open-source Q&amp;A and system-design analysis surface for any GitHub repo. Every answer cites a file you
          can open.
        </p>
        <div
          className="flex animate-fade-up flex-col gap-3 sm:flex-row sm:items-center"
          style={{ animationDelay: `${HERO_STAGGER.ctas}ms` }}
        >
          <Button asChild size="lg" className="w-full sm:w-auto">
            <a href={REPO_URL} rel="noreferrer" target="_blank" aria-label="View Systify on GitHub">
              <GitHubIcon />
              <span>View on GitHub</span>
            </a>
          </Button>
          <Button asChild size="lg" variant="ghost" className="w-full text-[14.5px] sm:w-auto">
            <a href="#self-host">
              Run it locally <span aria-hidden>→</span>
            </a>
          </Button>
        </div>
        <Stat />
      </div>

      <div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleReplay}
            className="inline-flex cursor-pointer items-center gap-1.5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-[color,transform] duration-100 hover:text-foreground active:scale-[0.95] motion-reduce:active:scale-100"
            aria-label="Replay hero animation"
          >
            <ArrowCounterClockwise weight="bold" className="size-3" />
            Replay
          </button>
        </div>
        <HeroChat ref={chatRef} />
      </div>
    </section>
  );
}

function StatusPill() {
  return (
    <div className="inline-flex max-w-full animate-fade-up items-center gap-2 self-start border border-border bg-card/60 px-2.5 py-1 font-mono text-[10.5px] tracking-[0.18em] text-muted-foreground backdrop-blur">
      <span className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping bg-primary opacity-60" />
        <span className="relative inline-flex size-1.5 bg-primary" />
      </span>
      <span className="truncate uppercase">open source · mit · self-hostable</span>
    </div>
  );
}

/**
 * Single source of truth for the bottom-of-hero stats row. Editing a row
 * (label or value) only requires changing this array — the markup loop
 * stays untouched. Vertical dividers between rows are inserted by the
 * renderer.
 */
const HERO_STATS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Answers", value: "file-cited" },
  { label: "License", value: "MIT" },
  { label: "Run", value: "your machine" },
];

function Stat() {
  return (
    <dl
      className="mt-2 flex animate-fade-up items-center justify-between gap-3 border-t border-border/60 pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:justify-start sm:gap-10 sm:text-[12px]"
      style={{ animationDelay: `${HERO_STAGGER.stat}ms` }}
    >
      {HERO_STATS.map(({ label, value }, idx) => (
        <StatRow key={label} label={label} value={value} withDividerBefore={idx > 0} />
      ))}
    </dl>
  );
}

function StatRow({ label, value, withDividerBefore }: { label: string; value: string; withDividerBefore: boolean }) {
  return (
    <>
      {withDividerBefore && <div className="h-8 w-px shrink-0 bg-border" aria-hidden />}
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="opacity-70">{label}</dt>
        <dd className="truncate text-[13px] tracking-tight text-foreground sm:text-[14px]">{value}</dd>
      </div>
    </>
  );
}
