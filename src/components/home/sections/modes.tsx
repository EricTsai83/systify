import { LAYERS, type Mode } from "../types";
import { MODES } from "../data";
import { MODE_TONE_CLASSES } from "../mode-tones";
import { Reveal } from "../primitives/reveal";
import { CornerMarks } from "../primitives/corner-marks";

const HEADING_ID = "modes-heading";

/**
 * One terminal panel per top-level mode. Each panel owns its color via
 * the `tone` field on `<Mode>` — see `mode-tones.ts`. Sandbox grounding
 * stays out of this list because it is a per-message Discuss toggle, not
 * a third route or persisted mode literal.
 */
export function Modes() {
  return (
    <Reveal>
      <section id="modes" aria-labelledby={HEADING_ID} className="relative">
        <div className="flex flex-col gap-8 sm:gap-10">
          <div className="flex flex-col gap-3">
            <h2
              id={HEADING_ID}
              className="max-w-3xl text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-4xl"
            >
              Two work surfaces. <span className="text-muted-foreground">Add live source only when needed.</span>
            </h2>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-muted-foreground sm:text-[11px]">
              discuss → library · optional sandbox grounding
            </p>
          </div>

          <ul className="grid gap-4 sm:gap-5 lg:grid-cols-2">
            {MODES.map((mode, idx) => (
              <ModePanel key={mode.name} mode={mode} index={idx} />
            ))}
          </ul>
        </div>
      </section>
    </Reveal>
  );
}

function ModePanel({ mode, index }: { mode: Mode; index: number }) {
  const tone = MODE_TONE_CLASSES[mode.tone];

  return (
    <li className="animate-fade-up list-none" style={{ animationDelay: `${index * 90}ms` }}>
      <article className="relative isolate flex h-full flex-col overflow-hidden border border-border bg-card/70 backdrop-blur">
        <CornerMarks />

        {/* Title */}
        <div className="px-4 pt-6 sm:px-5 sm:pt-7">
          <h3 className={`text-2xl font-semibold tracking-tight sm:text-3xl ${tone.title}`}>{mode.name}</h3>
        </div>

        {/* Sources — what the mode reads from.
            Each row is a knowledge layer: lit row = consulted, dim row = not consulted. */}
        <div className="mt-5 flex flex-col gap-2 border-t border-border/60 px-4 pt-4 sm:px-5">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/80">
            sources{" "}
            <span className="text-muted-foreground/50">
              — {mode.depth} of {LAYERS.length}
            </span>
          </span>
          <ul className="flex flex-col gap-1.5">
            {LAYERS.map((layer, i) => {
              const lit = i < mode.depth;
              return (
                <li
                  key={layer}
                  className={`flex items-center gap-2.5 font-mono text-[12px] ${
                    lit ? "text-foreground/90" : "text-muted-foreground/45 line-through decoration-muted-foreground/40"
                  }`}
                >
                  <span aria-hidden className={`size-2 shrink-0 ${lit ? tone.fill : "bg-foreground/12"}`} />
                  <span className="min-w-0 wrap-break-word">{layer}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Use-when scenarios — professional copy that includes the cost-performance angle */}
        <div className="mt-5 flex flex-col gap-2 border-t border-border/60 px-4 pt-4 sm:px-5">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/80">use when</span>
          <ul className="flex flex-col gap-2">
            {mode.scenarios.map((scenario) => (
              <li key={scenario} className="flex items-start gap-2.5 text-[13.5px] text-foreground/90">
                <span aria-hidden className="mt-[7px] size-1 shrink-0 bg-muted-foreground/60" />
                <span className="min-w-0 text-pretty leading-relaxed">{scenario}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Pitch */}
        <div className="mt-auto flex items-center gap-2 border-t border-border/60 px-4 py-3.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground sm:px-5">
          <span aria-hidden className={`size-1.5 shrink-0 ${tone.fill}`} />
          <span className="min-w-0 truncate">{mode.pitch}</span>
        </div>
      </article>
    </li>
  );
}
