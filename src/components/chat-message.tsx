import { Fragment, memo, useMemo, type ReactNode } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { MODE_LABELS } from "@/components/chat-modes";
import { ToolCallTrace } from "@/components/tool-call-trace";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ActiveMessageStream, ArtifactId } from "@/lib/types";

/**
 * Token regex for the citation rewriter: matches `[A#]` (1+ digits) anywhere
 * in the assistant's body. Captures the index so the replacement walker can
 * resolve it against `messages.citationMap`.
 */
const CITATION_TOKEN_REGEX = /\[A(\d+)\]/g;

/**
 * One assistant- or user-message bubble. Pure presentational: every
 * piece of content (mode badge, status label, cost ticker, citation
 * buttons, unverified-claim highlights) is derived from the persisted
 * `Doc<"messages">` plus an optional in-flight `activeMessageStream`,
 * so the bubble re-renders correctly whether the message is mid-stream
 * or terminal.
 *
 * Lives in its own module so the panel shell does not have to import
 * the full citation / cost-ticker rendering pipeline; the panel only
 * cares about the bubble's identity and click handlers.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  activeMessageStream,
  onSelectArtifact,
}: {
  message: Doc<"messages">;
  activeMessageStream: ActiveMessageStream | null;
  onSelectArtifact?: (artifactId: ArtifactId) => void;
}) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const statusLabel = getMessageStatusLabel(message.status);
  const displayContent =
    isAssistant && activeMessageStream?.assistantMessageId === message._id
      ? activeMessageStream.content || message.content
      : message.content;
  // Plan 02: assistant messages show a small mode chip so the user can tell
  // which mode produced the answer (and trace surprising replies back to a
  // mode mismatch). User messages still carry `mode` in the schema, but the
  // sender already knows what mode they were in — the chip would just be
  // visual noise on their own bubble.
  const modeLabel = isAssistant ? MODE_LABELS[message.mode] : null;
  // `[A#]` rewrite: only assistant content is rewritten because user input
  // never contains real citation tokens (and rewriting it would let a user
  // accidentally render a "fake" citation by typing `[A1]`).
  //
  // Plan 11 — `unverifiedClaims` is only rendered for terminal assistant
  // states. While the message is still streaming `displayContent` is the
  // live `activeMessageStream.content`, which the lint hasn't seen yet —
  // applying ranges from a previous (or future) snapshot would flag
  // arbitrary character positions in the live content. Gating on
  // `status !== "streaming" / "pending"` matches the cost-ticker gating
  // below for the same reason: `displayContent === message.content`
  // (the lint's input) is only guaranteed in terminal states.
  const unverifiedClaims =
    isAssistant && message.status !== "streaming" && message.status !== "pending"
      ? message.unverifiedClaims
      : undefined;
  const renderedContent = useMemo(
    () =>
      isAssistant
        ? renderAssistantContent(displayContent, message.citationMap, unverifiedClaims, onSelectArtifact)
        : displayContent || "…",
    [displayContent, isAssistant, message.citationMap, onSelectArtifact, unverifiedClaims],
  );
  // Plan 10 — cost ticker for assistant messages: shows estimated cost
  // and tokens / tool-call count so the user can correlate spend to a
  // specific reply. Rendered only for *terminal* assistant states
  // (`completed` / `failed` / `cancelled`) — streaming messages have
  // partial usage that would tick visibly and distract from the
  // streaming content. Built from the persisted message fields rather
  // than re-derived from the model so unsupported models (`undefined`
  // costUsd) gracefully render the token-only variant instead of a
  // fake "$0.00".
  const costTicker =
    isAssistant && message.status !== "streaming" && message.status !== "pending"
      ? buildCostTickerLabel(message)
      : null;
  const tickerAriaLabel =
    costTicker === null
      ? "Cost information"
      : message.estimatedCostUsd !== undefined
        ? `Reply cost ${costTicker}`
        : `Usage ${costTicker}`;
  return (
    <Card className={cn("p-4", isUser ? "bg-muted border-transparent" : "border-transparent bg-transparent px-0")}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{message.role}</p>
          {modeLabel ? (
            <Badge
              variant="muted"
              className="border-transparent px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider"
              data-testid="message-mode-badge"
            >
              {modeLabel}
            </Badge>
          ) : null}
        </div>
        <p className="text-[10px] text-muted-foreground">{statusLabel}</p>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6">{renderedContent}</p>
      {message.errorMessage ? <p className="mt-2 text-xs text-destructive">{message.errorMessage}</p> : null}
      {isAssistant ? (
        <ToolCallTrace
          messageId={message._id}
          persistedToolCalls={message.toolCalls}
          isStreaming={message.status === "streaming"}
        />
      ) : null}
      {costTicker ? (
        <p
          className="mt-1 text-[11px] text-muted-foreground/80 tabular-nums"
          data-testid="message-cost-ticker"
          aria-label={tickerAriaLabel}
        >
          {costTicker}
        </p>
      ) : null}
    </Card>
  );
});

/**
 * Plan 10 — render the chat-bubble cost ticker.
 *
 * Tries to surface as much information as is available, in this order:
 *
 *   1. `~$0.03 · 1.2k tokens · 5 tools` — full info (priced model,
 *      tokens reported, tool-call trace persisted).
 *   2. `~$0.03 · 1.2k tokens` — full info minus tool calls (discuss /
 *      docs replies have no tools by design).
 *   3. `1.2k tokens · 5 tools` — pricing miss (model not in
 *      `openaiPricing.ts`); we still show what we know.
 *   4. `1.2k tokens` — discuss/docs reply for a model we don't price.
 *   5. `null` — heuristic reply (no cost, no tokens). Skips the ticker
 *      entirely so the user isn't shown an empty "—" line.
 *
 * Sub-cent costs get rendered as `<$0.01` rather than `$0.00` so the
 * user can distinguish "cheap reply" from "free reply".
 */
function buildCostTickerLabel(message: Doc<"messages">): string | null {
  const inputTokens = message.estimatedInputTokens;
  const outputTokens = message.estimatedOutputTokens;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : null;
  const cost = message.estimatedCostUsd;
  const toolCallCount = message.toolCalls?.length ?? 0;

  // Heuristic / no-token replies don't get a ticker — there's nothing
  // useful to show beyond what the bubble already says.
  if (totalTokens === null && cost === undefined && toolCallCount === 0) {
    return null;
  }

  const parts: string[] = [];
  if (cost !== undefined) {
    parts.push(formatCostUsd(cost));
  }
  if (totalTokens !== null) {
    parts.push(`${formatTokenCount(totalTokens)} tokens`);
  }
  if (toolCallCount > 0) {
    parts.push(`${toolCallCount} ${toolCallCount === 1 ? "tool" : "tools"}`);
  }
  return parts.join(" · ");
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) {
    return "<$0.01";
  }
  if (usd < 1) {
    return `~$${usd.toFixed(2)}`;
  }
  return `~$${usd.toFixed(2)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  // 1.2k granularity — sufficient for the ticker and avoids noisy
  // single-token differences across re-renders.
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * One contiguous sub-region of an assistant reply. The renderer splits
 * the message content into a sequence of these so the docs-mode `[A#]`
 * citation rewriter and the sandbox-mode unverified-claim highlighter
 * can compose without either pass needing to know about the other:
 *
 *   - Each run carries the substring it covers and the absolute offset
 *     into the original content (only used for stable React keys).
 *   - `flagged` is true for runs that fall inside an `unverifiedClaims`
 *     range. The renderer wraps those runs in `<mark>`; the citation
 *     rewriter operates on the run's text either way.
 *
 * Splitting into runs *before* the citation pass means a `[A#]` token
 * that lives inside a flagged sentence still becomes a clickable
 * button — the click target sits inside the `<mark>` wrapper rather
 * than competing with it.
 */
type ContentRun = {
  readonly text: string;
  readonly offset: number;
  readonly flagged: boolean;
};

/**
 * Plan 11 — split the assistant's content into alternating "flagged"
 * (inside an `unverifiedClaims` range) and "normal" runs.
 *
 * Pure function over the content and the persisted ranges; safe to
 * call on every render of an assistant bubble (the lint output is
 * already capped at `MAX_UNVERIFIED_CLAIMS_PER_MESSAGE = 50` so the
 * loop body runs at most ~100 times per render). Defensive about
 * out-of-bounds or out-of-order ranges so a future schema migration
 * with relaxed invariants cannot crash the renderer:
 *
 *   - Sorts a defensive copy of the ranges by `start` (the lint emits
 *     them sorted, but the renderer can't trust that across schema
 *     versions).
 *   - Clamps each range to `[cursor, content.length]` so an overlapping
 *     range from a hypothetical future edit cannot produce a negative
 *     slice. Overlaps degrade to "the second range starts where the
 *     first one ended" — visually identical to a single longer
 *     highlight, which is the right failure mode.
 *   - Skips empty ranges (`end <= start`) silently rather than
 *     emitting zero-width runs that React would still allocate keys
 *     for.
 */
function buildContentRuns(
  content: string,
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
): ContentRun[] {
  if (!ranges || ranges.length === 0) {
    return [{ text: content, offset: 0, flagged: false }];
  }
  // Defensive copy + sort so the caller can hand us the persisted array
  // without us mutating it. The lint module already sorts, so the
  // sort cost on the hot path is `O(n)` for an already-sorted input.
  const sortedRanges = [...ranges].sort((a, b) => a.start - b.start);
  const runs: ContentRun[] = [];
  let cursor = 0;
  for (const range of sortedRanges) {
    const start = Math.max(cursor, Math.min(range.start, content.length));
    const end = Math.max(start, Math.min(range.end, content.length));
    if (end <= start) {
      continue;
    }
    if (start > cursor) {
      runs.push({ text: content.slice(cursor, start), offset: cursor, flagged: false });
    }
    runs.push({ text: content.slice(start, end), offset: start, flagged: true });
    cursor = end;
  }
  if (cursor < content.length) {
    runs.push({ text: content.slice(cursor), offset: cursor, flagged: false });
  }
  return runs;
}

/**
 * Walk one content run and turn `[A#]` tokens into clickable citation
 * buttons (when the index resolves) or pass them through as plain text
 * (when it doesn't). Returns the React nodes for that run.
 *
 * Uses a *local* regex (`new RegExp(CITATION_TOKEN_REGEX.source, "g")`)
 * rather than the module-level instance: each run's walk is independent,
 * and a local regex avoids the (small but real) risk of `lastIndex`
 * leaking across runs in concurrent-mode renders.
 *
 * `keys` is a generator that the caller threads across runs so React
 * keys stay unique within the entire bubble's render pass — without
 * that, two runs each starting their key counter at zero would
 * collide.
 */
function renderCitationsInRun(
  text: string,
  indexToArtifactId: ReadonlyMap<number, ArtifactId>,
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined,
  keys: { next: () => number },
): ReactNode[] {
  const segments: ReactNode[] = [];
  const re = new RegExp(CITATION_TOKEN_REGEX.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push(<Fragment key={`text-${keys.next()}`}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    const tokenIndex = Number.parseInt(match[1], 10);
    const artifactId = indexToArtifactId.get(tokenIndex);
    if (artifactId && onSelectArtifact) {
      segments.push(
        <button
          key={`cite-${keys.next()}`}
          type="button"
          onClick={() => onSelectArtifact(artifactId)}
          className="mx-0.5 inline-flex items-center rounded-sm border border-primary/30 bg-primary/5 px-1 py-0 text-[11px] font-semibold leading-5 text-primary hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          data-testid={`citation-link-${tokenIndex}`}
          aria-label={`Open referenced artifact A${tokenIndex}`}
        >
          {match[0]}
        </button>,
      );
    } else {
      // Unresolved tokens render as plain text so the model's intent is
      // visible even when the citation map is missing or out of range.
      segments.push(<Fragment key={`text-${keys.next()}`}>{match[0]}</Fragment>);
    }
    lastIndex = match.index + match[0].length;
    match = re.exec(text);
  }
  if (lastIndex < text.length) {
    segments.push(<Fragment key={`text-${keys.next()}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return segments;
}

/**
 * Walks the assistant's content, applying two composable passes:
 *
 *   1. **Unverified-claim highlight (Plan 11).** Sentences flagged by
 *      the citation lint are wrapped in `<mark>` with a soft yellow
 *      background and a dotted underline so the user can read them
 *      with extra skepticism. Non-blocking by design — the lint never
 *      rejects model output, it just nudges the reader.
 *
 *   2. **`[A#]` citation rewrite (Plan 02).** Every artifact-citation
 *      token whose index resolves against `messages.citationMap`
 *      becomes a clickable button that forwards the artifact id to
 *      `onSelectArtifact`. Tokens that don't resolve render as plain
 *      text so the model's intent stays visible.
 *
 * The two passes compose naturally: (1) splits the content into runs,
 * then (2) rewrites `[A#]` tokens within each run regardless of
 * flagged/unflagged status. A `<mark>`ed sentence that contains a
 * `[A#]` token still has a working button — the click target lives
 * inside the highlight wrapper rather than competing with it.
 *
 * Returns a `ReactNode` array (interleaving plain-text segments with
 * `<button>` and `<mark>` elements) rather than a single string so
 * React can render the inline buttons; preserving the surrounding
 * whitespace keeps `whitespace-pre-wrap` formatting intact for prose
 * around the citations.
 */
function renderAssistantContent(
  content: string,
  citationMap: Doc<"messages">["citationMap"],
  unverifiedClaims: Doc<"messages">["unverifiedClaims"],
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined,
): ReactNode {
  if (!content) {
    return "…";
  }
  // Build an O(1) lookup keyed by the numeric `[A#]` index. Doing this once
  // per render is cheap (citationMap caps at MAX_CONTEXT_ARTIFACTS = 6) and
  // avoids re-scanning the array for every regex match.
  const indexToArtifactId = new Map<number, ArtifactId>();
  for (const entry of citationMap ?? []) {
    indexToArtifactId.set(entry.index, entry.artifactId);
  }

  const runs = buildContentRuns(content, unverifiedClaims);
  // Single key generator threaded across runs so React keys stay unique
  // bubble-wide. Inlined as an object so the closure shape doesn't drift
  // if more renderers grow up around this one.
  let keyCounter = 0;
  const keys = {
    next: () => keyCounter++,
  };

  const out: ReactNode[] = [];
  for (const run of runs) {
    const innerNodes = renderCitationsInRun(run.text, indexToArtifactId, onSelectArtifact, keys);
    if (run.flagged) {
      out.push(
        <mark
          key={`unv-${keys.next()}`}
          // Subtle yellow tint + dotted underline reads as "soft warning"
          // without crowding the prose. The browser default `<mark>`
          // background is the bright marker-yellow Wikipedia uses for
          // search hits, which would be too loud for a per-sentence
          // signal that fires on plausibly-half-the-reply for unprompted
          // model output. Theme-aware variants keep contrast acceptable
          // in dark mode without changing semantics.
          className="rounded-sm bg-highlight/20 px-0.5 underline decoration-highlight/70 decoration-dotted underline-offset-2 dark:bg-highlight/15"
          data-testid="unverified-claim"
          // The bubble already labels the role and mode; the title
          // here gives the user an inline tooltip explaining what the
          // highlight means without needing onboarding copy. `aria-label`
          // is omitted because the marked text itself is the content
          // — overriding it would mute the sentence for screen readers.
          title="The model did not cite a tool-verified source for this sentence. Read with skepticism."
        >
          {innerNodes}
        </mark>,
      );
    } else {
      out.push(<Fragment key={`run-${keys.next()}`}>{innerNodes}</Fragment>);
    }
  }
  return out;
}

function getMessageStatusLabel(status: Doc<"messages">["status"]) {
  switch (status) {
    case "pending":
      return "Queued";
    case "streaming":
      return "Generating";
    case "completed":
      return "Ready";
    case "failed":
      return "Failed";
    case "cancelled":
      // Plan 07 — distinct from "Failed" so the user can tell at a glance
      // that they themselves stopped the reply (vs. an upstream error).
      return "Cancelled";
    default:
      return status;
  }
}
