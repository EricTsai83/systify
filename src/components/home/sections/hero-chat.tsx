import { forwardRef, useId, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  DotsThreeVerticalIcon,
  FileTextIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
} from "@phosphor-icons/react";

import { GitHubIcon } from "@/components/icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CornerMarks } from "../primitives/corner-marks";
import { REPLAY_ON_MOUNT_ATTR } from "../primitives/replay-animations";

/**
 * HeroChat — a faithful preview of the real `<ChatPanel />` the user
 * lands on after signing in. Marketing surfaces should not lie about
 * what the product looks like, so this hero reproduces, in miniature,
 * the actual chrome the authed app renders:
 *
 *   - top bar  → src/components/top-bar.tsx     (sidebar trigger glyph,
 *                                                 repo title, status pill,
 *                                                 sync)
 *   - body     → src/components/chat-panel.tsx  (user `bg-muted` Card,
 *                                                 transparent assistant
 *                                                 bubble with role+status
 *                                                 header and file
 *                                                 citations)
 *   - composer → chat-panel.tsx form            (textarea, mode pill, Send)
 *
 * Streaming choreography stands in for the real Convex stream: the user
 * types a question in the composer, presses Send, the user message slides
 * in, the assistant header appears in `Generating` state, a tool-call
 * card enters, and body chunks stream in word-by-word as if tokens were
 * arriving. Every keyframe respects `prefers-reduced-motion` via the
 * existing utility classes — see `src/index.css` for the override block.
 */

/* ── timing (ms from mount) ─────────────────────────────────────── */
/**
 * Single source of truth for the streaming choreography. Read top-to-bottom
 * to follow the visitor's eye through the scene; keys derive from earlier
 * keys so adjusting an upstream beat shifts everything downstream by the
 * same amount.
 *
 * `wordStep` is the per-word delay used to fake LLM token streaming —
 * shorter feels jittery, longer feels artificially slow.
 */
const TYPING_START = 800;
const TYPING_DURATION = 1500;
const TIMELINE = {
  typingStart: TYPING_START,
  typingDuration: TYPING_DURATION,
  // SEND_PRESS happens shortly after typing finishes (200 ms breath) — it
  // is the visual "click" of the Send button.
  sendPress: TYPING_START + TYPING_DURATION + 200,
  // 300 ms after Send so the press animation reads before the field clears.
  composeClear: TYPING_START + TYPING_DURATION + 200 + 300,
  // 200 ms after clear so the message appears to slot in *because of* the send.
  userMessage: TYPING_START + TYPING_DURATION + 200 + 300 + 200,
  // 1 s gap mimics network latency before the assistant starts responding.
  assistantHeader: TYPING_START + TYPING_DURATION + 200 + 300 + 200 + 1000,
  // Tool-call card enters 400 ms after the header so they read as a unit.
  toolCall: TYPING_START + TYPING_DURATION + 200 + 300 + 200 + 1000 + 400,
  // Body streaming starts 1.2 s after tool-call so the retrieval phase has
  // time to be perceived as "thinking", not just decoration.
  streamStart: TYPING_START + TYPING_DURATION + 200 + 300 + 200 + 1000 + 400 + 1200,
  /** ms between each streamed word — fake LLM token cadence. */
  wordStep: 60,
} as const;

const TYPED_TEXT = "How does the App Router resolve nested layouts?";

const BODY_TEXT =
  "Nested layouts are resolved across three phases — build-time discovery, runtime rendering, and component tree assembly:";
const BODY_WORDS = BODY_TEXT.split(/\s+/);

/** Wall-clock time (ms from mount) when the streamed body finishes. */
const STREAM_END = TIMELINE.streamStart + BODY_WORDS.length * TIMELINE.wordStep + 300;

/**
 * Citations rendered after the streamed body. Hoisted to module scope so
 * the array (and its identity) is stable across renders — `<AssistantMessage />`
 * does not need to recreate it every time.
 */
const CITATIONS: ReadonlyArray<string> = [
  "packages/next/src/server/app-render/app-render.tsx",
  "packages/next/src/server/app-render/create-component-tree.tsx",
];

/** Marks any element whose entry animation should be replayed by the hero "Replay" button. */
const replayAttr = { [REPLAY_ON_MOUNT_ATTR]: "" } as const;

export const HeroChat = forwardRef<HTMLDivElement>(function HeroChat(_props, ref) {
  return (
    <div className="relative min-w-0 animate-fade-in" style={{ animationDelay: "600ms" }} {...replayAttr}>
      <div
        ref={ref}
        className="group/term relative overflow-hidden border border-border bg-card/85 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.25)] backdrop-blur"
      >
        <CornerMarks />

        <ChatTopBar />

        {/* Chat body — same layout vocabulary as <ChatPanel />.
            Uses a *fixed* `h` (not `max-h`) at each breakpoint so
            toggling the citations list open/closed never reflows the
            page around the chat — the panel stays the same size, the
            list itself overflows into the scroll area. The chosen
            heights track the viewport's vertical room:
              • mobile (`<sm`)  → just enough for collapsed content;
                                   expanding citations triggers scroll.
              • tablet (`sm-lg`) → mid-size; minor scroll on expand.
              • desktop (`lg+`)  → tall enough that even expanded
                                   citations fit without scrolling. */}
        {/* Wrapped in shadcn `<ScrollArea type="hover">` (Radix primitive)
            so the scrollbar (a) only reveals on hover or while actively
            scrolling — keeping the panel chrome quiet at rest — and (b)
            paints the thumb in `bg-border`, which is wired to the theme
            token (`--border`) and therefore re-colors automatically when
            the user toggles light/dark. This replaces the previous
            `scrollbar-themed` class which was referenced but had no CSS
            backing it (so the browser default scrollbar leaked through
            and never matched the theme).

            We rely on Radix's native `type="hover"` instead of toggling
            `<ScrollBar>` opacity by hand — the manual approach hides the
            bar even *while* the user is scrolling without a hover (e.g.
            wheel/trackpad with cursor outside the panel), which defeats
            the affordance.

            `contain: content` + `will-change: transform` are kept on the
            ScrollArea root (the compositing parent of Radix's Viewport)
            so it still becomes its own permanent GPU compositor layer.
            This creates a compositing boundary that isolates child
            animation layer promotions/demotions (especially the 17
            rapid-fire word-streaming fade-ins) from the parent card's
            `backdrop-blur` + `bg-card/85` compositing context — without
            this, every child layer change forces a re-composite of the
            entire backdrop-blur region, and the sub-pixel rounding
            differences between GPU and CPU alpha blending on the
            semi-transparent card background reads as flicker. */}
        <ScrollArea
          type="hover"
          className="h-[340px] sm:h-[400px] lg:h-[460px]"
          style={{ contain: "content", willChange: "transform" }}
        >
          <div className="flex flex-col gap-2.5 px-3 py-3 sm:gap-3 sm:px-5 sm:py-5">
            <UserMessage delay={TIMELINE.userMessage}>{TYPED_TEXT}</UserMessage>
            <AssistantMessage delay={TIMELINE.assistantHeader} />
          </div>
        </ScrollArea>

        <ChatComposer />
      </div>
    </div>
  );
});

/**
 * Top-bar mock. The real `<TopBar />` renders the sidebar trigger, repo
 * title with the `<RepoStatusIndicator />` dot, an attach-repo chip and
 * a right-side cluster (jobs, sync, more). We reproduce only the
 * read-only shape — clickable affordances would mislead a signed-out
 * visitor.
 */
function ChatTopBar() {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background/60 px-3 sm:h-12">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center text-muted-foreground/70">
        <ListIcon weight="bold" className="size-4" />
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <GitHubIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[12.5px] font-semibold tracking-tight">vercel/next.js</span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse-soft" />
          ready
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span className="hidden items-center gap-1 sm:inline-flex">
          <ArrowsClockwiseIcon weight="bold" className="size-3" />
          synced 14s ago
        </span>
        <DotsThreeVerticalIcon weight="bold" className="size-3.5 text-muted-foreground/60" />
      </div>
    </div>
  );
}

/**
 * User bubble. Mirrors `MessageBubble` for role=user: muted Card with
 * the `[10px] uppercase` role label and a status label aligned to the
 * right.
 */
function UserMessage({ children, delay }: { children: ReactNode; delay: number }) {
  return (
    // `shrink-0` is load-bearing: the parent chat body is a flex column with a
    // fixed `h-[340px]` on mobile and `overflow-y-auto`. Flex children default
    // to `flex-shrink: 1`, so when this bubble + the assistant block (with
    // citations expanded by default) together exceed the body height, the
    // flex layout would shrink each child proportionally *instead of* letting
    // the parent scroll. Combined with this element's own `overflow-hidden`
    // (kept so the rail's scaleY animation can't escape the bubble), shrinking
    // would clip the user's question — exactly the "user message gets
    // compressed on mobile" bug. `shrink-0` forces children to keep their
    // natural height; the parent's `overflow-y-auto` handles the excess.
    <div
      className="relative shrink-0 overflow-hidden bg-muted px-4 py-3 animate-reveal-up"
      style={{ animationDelay: `${delay}ms` }}
      {...replayAttr}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-0.5 bg-primary shadow-[0_0_14px_var(--color-primary)] animate-message-rail"
        style={{ animationDelay: `${delay}ms` }}
        {...replayAttr}
      />
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">user</p>
        <p className="text-[10px] text-muted-foreground">Ready</p>
      </div>
      <p className="text-[13.5px] leading-6 text-foreground">{children}</p>
    </div>
  );
}

/**
 * Assistant message. The response sequence is:
 *   1. **Tool call** card — framed retrieval phase (guide accent).
 *   2. **Body text** — streams word-by-word to evoke LLM token
 *      streaming (guide accent on the paragraph).
 *   3. **Citations + footer** — fade in as a group once streaming
 *      completes.
 */
function AssistantMessage({ delay }: { delay: number }) {
  // Citations default to expanded so the marketing demo showcases the
  // file-cited value prop, but the toggle below lets visitors collapse
  // the list to keep the panel compact (especially on mobile).
  const [citationsExpanded, setCitationsExpanded] = useState(true);
  const citationsListId = useId();

  return (
    // No animation on the container — children control their own
    // visibility. If the container also faded in, its opacity would
    // *multiply* with each child's fade-in (e.g. the Tool Call bubble
    // below), and the moment the container's curve completes you'd
    // see a perceptible brightness pulse on the child's bg as the
    // multiplier snaps to 1.
    //
    // `shrink-0` matches `<UserMessage />` — see the comment there for why
    // both children of the fixed-height scroll container must opt out of
    // flex shrinking (the tool-call bubble inside this block also has
    // `overflow-hidden` and would clip the same way under shrink pressure).
    <div className="shrink-0 px-0 py-1">
      {/* Header — fades in on its own so it can ride the parent's
          original entry beat without dragging the rest of the block
          into a nested animation. */}
      <div
        className="animate-fade-up mb-1 flex items-center justify-between gap-3"
        style={{ animationDelay: `${delay}ms` }}
        {...replayAttr}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">assistant</p>
      </div>

      <div className="flex flex-col gap-2 text-[13.5px] leading-6 text-foreground/95 sm:gap-2.5">
        {/* ── Group 1: Tool call ────────────────────────────────── */}
        <div
          className="relative overflow-hidden bg-muted/40 px-3.5 py-2.5 animate-reveal-up sm:px-4 sm:py-3"
          style={{ animationDelay: `${TIMELINE.toolCall}ms` }}
          {...replayAttr}
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-0.5 bg-primary shadow-[0_0_14px_var(--color-primary)] animate-message-rail"
            style={{ animationDelay: `${TIMELINE.toolCall}ms` }}
            {...replayAttr}
          />
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <MagnifyingGlassIcon weight="bold" className="size-3 text-primary" />
            <span>Search Codebase</span>
          </div>
          <p className="mt-1.5 font-mono text-[11px] leading-5 text-muted-foreground/80">
            query: &quot;App Router nested layouts&quot;
          </p>
          <p className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
            <span className="size-1 rounded-full bg-emerald-500" />
            {CITATIONS.length} files found
          </p>
        </div>

        {/* ── Group 2: Streamed body text ───────────────────────── */}
        <div>
          <p>
            {BODY_WORDS.map((word, i) => (
              <span
                key={i}
                className="animate-fade-in"
                style={{
                  animationDelay: `${TIMELINE.streamStart + i * TIMELINE.wordStep}ms`,
                  animationDuration: "0.12s",
                }}
                {...replayAttr}
              >
                {word}
                {i < BODY_WORDS.length - 1 ? " " : ""}
              </span>
            ))}
          </p>
        </div>

        {/* ── Citations — appear after streaming ─────────────────
            The "N files cited" label doubles as a disclosure toggle:
            clicking collapses or expands the list, letting visitors
            on smaller viewports trim the panel down to just the
            answer. The list itself is wrapped in the grid-rows
            `1fr ↔ 0fr` trick so collapse animates smoothly without
            a measured height. */}
        <div
          className="animate-fade-in flex flex-col gap-1.5"
          style={{ animationDelay: `${STREAM_END}ms` }}
          {...replayAttr}
        >
          <button
            type="button"
            onClick={() => setCitationsExpanded((prev) => !prev)}
            aria-expanded={citationsExpanded}
            aria-controls={citationsListId}
            className="inline-flex items-center gap-1 self-end font-mono text-[10px] uppercase leading-none tracking-[0.16em] text-muted-foreground/80 transition-colors hover:text-foreground"
          >
            <span>{CITATIONS.length} files cited</span>
            <CaretDownIcon
              weight="bold"
              aria-hidden
              className={`size-3 transition-transform duration-200 motion-reduce:transition-none ${citationsExpanded ? "" : "-rotate-90"}`}
            />
          </button>
          <div
            id={citationsListId}
            aria-hidden={!citationsExpanded}
            hidden={!citationsExpanded}
            className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${citationsExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
          >
            <ul className="flex flex-col gap-1 overflow-hidden">
              {CITATIONS.map((path) => (
                <li key={path} className="relative flex min-w-0 items-center gap-2">
                  <span aria-hidden className="shrink-0 leading-6 text-primary">
                    →
                  </span>
                  <code
                    title={path}
                    className="min-w-0 truncate rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[11.5px] leading-5"
                  >
                    {path}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Composer mock with typing choreography. Before the chat messages
 * appear, the composer shows a typewriter animation of the user's
 * question, followed by a Send-button press, and finally the text
 * clears — as if the visitor just watched someone ask a question.
 */
function ChatComposer() {
  return (
    <div className="border-t border-border bg-background/60 px-3 py-2.5 sm:py-3">
      <div className="relative flex min-h-16 items-start rounded-sm border border-border bg-background/80 px-3 py-2.5 text-[12.5px] leading-6">
        {/* Placeholder — disappears quickly right before typing begins */}
        <span
          className="animate-fade-out text-muted-foreground/70"
          style={{ animationDelay: `${TIMELINE.typingStart - 50}ms`, animationDuration: "0.1s" }}
          {...replayAttr}
        >
          Ask about architecture, module boundaries, data flow, risks…
        </span>

        {/* Typed text — typewriter effect, wrapped in a container
            that fades out after Send so the composer "clears" */}
        <span
          className="absolute inset-x-3 top-2.5 animate-fade-out"
          style={{ animationDelay: `${TIMELINE.composeClear}ms`, animationDuration: "0s" }}
          {...replayAttr}
        >
          <span
            className="animate-hero-typing text-foreground"
            style={
              {
                "animationDelay": `${TIMELINE.typingStart}ms, ${TIMELINE.typingStart}ms`,
                "animationDuration": `${TIMELINE.typingDuration}ms, 1.05s`,
                "--type-width": "100%",
              } as CSSProperties
            }
            {...replayAttr}
          >
            {TYPED_TEXT}
          </span>
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 sm:mt-2">
        <span className="inline-flex items-center gap-1.5 rounded-sm bg-muted px-2 py-1 text-[11px] text-foreground">
          <FileTextIcon size={12} weight="bold" />
          <span className="font-medium">Docs</span>
          <span className="hidden text-muted-foreground/70 sm:inline">searches your design docs</span>
        </span>
        {/* Send button — press animation at TIMELINE.sendPress */}
        <span
          className="inline-flex animate-send-press items-center gap-1.5 rounded-sm bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
          style={{ animationDelay: `${TIMELINE.sendPress}ms` }}
          {...replayAttr}
        >
          <PaperPlaneTiltIcon size={12} weight="bold" />
          Send
        </span>
      </div>
    </div>
  );
}
