import { memo, isValidElement, useCallback, useMemo, type ReactNode } from "react";
import type { AllowedTags, Components } from "streamdown";
import type { Doc } from "../../convex/_generated/dataModel";
import { Message, MessageContent, MessageActions, MessageAction } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolCallTrace } from "@/components/tool-call-trace";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { useClipboard } from "@/hooks/use-clipboard";
import { CITATION_TOKEN_REGEX, prepareAssistantMarkdown } from "@/lib/assistant-markdown";
import type { ActiveMessageStream, ArtifactId } from "@/lib/types";
import { CopyIcon, CheckIcon, WarningCircleIcon, GaugeIcon, ClockIcon, CpuIcon, HashIcon } from "@phosphor-icons/react";

/**
 * Derive the grounding chip label from a persisted assistant message.
 *
 * Returns one of:
 *   - `"Library + Sandbox"` — both grounding flags on
 *   - `"Library"` — only library grounding
 *   - `"Sandbox"` — only sandbox grounding
 *   - `null` — ungrounded Discuss replies and user messages
 *
 * Library-mode rows do not need a mode badge; the Library page already
 * provides that context. Discuss-mode grounding chips remain useful because
 * they explain which optional grounding axes produced the reply.
 */
function deriveGroundingChip(message: Doc<"messages">): string | null {
  if (message.role !== "assistant") {
    return null;
  }
  if (message.mode === "library") {
    return null;
  }
  const groundLibrary = message.groundLibrary === true;
  const groundSandbox = message.groundSandbox === true;
  if (groundLibrary && groundSandbox) {
    return "Library + Sandbox";
  }
  if (groundLibrary) {
    return "Library";
  }
  if (groundSandbox) {
    return "Sandbox";
  }
  return null;
}

/**
 * Custom tags the assistant markdown pass keeps through streamdown's
 * sanitizer. The empty arrays mean no attributes are allowed on either
 * tag — `CitationRef` / `UnverifiedMark` derive everything they need
 * from the tag's children, never from attributes. Module-level so the
 * reference stays stable across renders.
 */
const ASSISTANT_ALLOWED_TAGS: AllowedTags = { citation: [], unverified: [] };

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
  showStatsForNerds = false,
}: {
  message: Doc<"messages">;
  activeMessageStream: ActiveMessageStream | null;
  onSelectArtifact?: (artifactId: ArtifactId) => void;
  showStatsForNerds?: boolean;
}) {
  const isAssistant = message.role === "assistant";
  // `Message`'s `from` accepts `"system" | "user" | "assistant"`, but the
  // Convex schema also allows `"tool"` (tool-call traces folded into a
  // turn). Map `"tool"` → `"assistant"` so the bubble stays left-aligned
  // and the rest of the rendering branches unchanged (the original
  // `<Card>` rendered tool rows under the assistant-style fallback).
  const fromRole: "system" | "user" | "assistant" = message.role === "tool" ? "assistant" : message.role;
  const statusLabel = getMessageStatusLabel(message.status);
  // While the reply is still landing, the status label gets a subtle
  // text-shimmer so the user has an at-a-glance cue that something is
  // actively happening (in addition to streaming content / tool ticker).
  // Terminal states render the plain label so the eye isn't pulled to a
  // finished bubble.
  const isInFlight = message.status === "streaming" || message.status === "pending";
  const displayContent =
    isAssistant && activeMessageStream?.assistantMessageId === message._id
      ? activeMessageStream.content || message.content
      : message.content;
  const isTerminalSystemError =
    isAssistant &&
    (message.status === "failed" || message.status === "cancelled") &&
    message.errorMessage !== undefined &&
    message.errorMessage.trim().length > 0;
  const isSystemErrorOnly = isTerminalSystemError && message.errorMessage?.trim() === displayContent.trim();
  // Assistant messages show a small grounding chip so the user can tell
  // which grounding axes produced the answer (and trace surprising
  // replies back to a wrong toggle). User messages still carry the
  // grounding flags in the schema, but the sender already knows what
  // they asked for — the chip would just be visual noise on their own
  // bubble.
  const groundingChip = deriveGroundingChip(message);
  // `[A#]` rewrite: only assistant content is rewritten because user input
  // never contains real citation tokens (and rewriting it would let a user
  // accidentally render a "fake" citation by typing `[A1]`).
  //
  // `unverifiedClaims` is only rendered for terminal assistant states.
  // While the message is still streaming `displayContent` is the
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
  // Streamdown-ready string for assistant replies: `[A#]` tokens and any
  // flagged-claim ranges are rewritten into `<citation>` / `<unverified>`
  // tags before the markdown parse. User input is never rewritten — a
  // user typing `[A1]` must not be able to render a fake citation.
  const preparedMarkdown = useMemo(
    () => (isAssistant ? prepareAssistantMarkdown(displayContent, unverifiedClaims) : ""),
    [isAssistant, displayContent, unverifiedClaims],
  );
  // Custom-tag renderers for the markdown pass, bound to *this* message's
  // citation map and the artifact-select handler. Memoized so streamdown's
  // per-block memo isn't busted on every unrelated re-render of the bubble.
  const markdownComponents = useMemo<Components>(() => {
    const indexToArtifactId = new Map<number, ArtifactId>();
    for (const entry of message.citationMap ?? []) {
      indexToArtifactId.set(entry.index, entry.artifactId);
    }
    return {
      citation: ({ children }) => (
        <CitationRef indexToArtifactId={indexToArtifactId} onSelectArtifact={onSelectArtifact}>
          {children as ReactNode}
        </CitationRef>
      ),
      unverified: ({ children }) => <UnverifiedMark>{children as ReactNode}</UnverifiedMark>,
    };
  }, [message.citationMap, onSelectArtifact]);
  // Cost ticker for assistant messages: shows estimated cost
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
  const nerdStats =
    isAssistant && showStatsForNerds ? buildNerdStats(message, displayContent, activeMessageStream) : null;
  const tickerAriaLabel =
    costTicker === null
      ? "Cost information"
      : message.estimatedCostUsd !== undefined
        ? `Reply cost ${costTicker}`
        : `Usage ${costTicker}`;
  // Reasoning trace, when this is the in-flight assistant reply for a
  // reasoning-capable model. While streaming we read the live tail from
  // `activeMessageStream`; once the reply terminates the durable
  // `messages.reasoning` field takes over (the stream row has been
  // deleted by then). Both sources are optional — non-reasoning replies
  // leave everything `null/undefined` and the `<Reasoning>` block stays
  // unmounted.
  const isLiveStream = isAssistant && activeMessageStream?.assistantMessageId === message._id;
  const reasoningContent = isLiveStream ? (activeMessageStream.reasoning ?? null) : (message.reasoning ?? null);
  const isReasoningStreaming = Boolean(
    isLiveStream && activeMessageStream.reasoningStartedAt !== null && activeMessageStream.reasoningEndedAt === null,
  );
  const reasoningDurationSeconds = computeReasoningDurationSeconds(message, activeMessageStream, isLiveStream);
  // Header (grounding chip + non-terminal status) sits ABOVE
  // `MessageContent` so it stays outside the user-bubble background and
  // aligns with the bubble edge. The role itself is conveyed by
  // alignment + bubble styling — no explicit label needed. `Ready` is
  // suppressed because "completed" is the boring default; only states
  // that actually carry information (in-flight, failed, cancelled)
  // surface a label. When neither the chip nor a status applies the
  // header row collapses entirely so user messages don't leave an empty
  // strip above the bubble.
  const showStatus = statusLabel !== null;
  const showHeader = groundingChip !== null || showStatus;
  return (
    // `Message` (ai-elements) handles the role-based alignment (user →
    // right, assistant → left) and constrains bubble width to max-w-95%.
    // Cost ticker sits BELOW `MessageContent` for the same reason.
    <Message from={fromRole}>
      {showHeader ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-2">
            {groundingChip ? (
              <Badge
                variant="muted"
                className="border-transparent px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider"
                data-testid="message-grounding-badge"
              >
                {groundingChip}
              </Badge>
            ) : null}
          </div>
          {showStatus ? (
            isInFlight ? (
              <Shimmer as="p" className="text-[10px]" duration={1.6}>
                {statusLabel}
              </Shimmer>
            ) : (
              <p className="text-[10px] text-muted-foreground">{statusLabel}</p>
            )
          ) : null}
        </div>
      ) : null}
      {isAssistant && (reasoningContent || isReasoningStreaming) ? (
        <div data-testid="message-reasoning" className="px-1">
          <Reasoning isStreaming={isReasoningStreaming} duration={reasoningDurationSeconds} defaultOpen={false}>
            <ReasoningTrigger />
            <ReasoningContent>{reasoningContent ?? ""}</ReasoningContent>
          </Reasoning>
        </div>
      ) : null}
      <MessageContent>
        {isSystemErrorOnly ? (
          <SystemErrorNotice status={message.status} message={message.errorMessage ?? ""} />
        ) : isAssistant ? (
          displayContent ? (
            <Markdown
              className="text-sm leading-6"
              isAnimating={message.status === "streaming"}
              allowedTags={ASSISTANT_ALLOWED_TAGS}
              components={markdownComponents}
            >
              {preparedMarkdown}
            </Markdown>
          ) : (
            // Empty assistant content (queued / just-started reply): show a
            // placeholder rather than hand streamdown an empty string.
            <p className="text-sm leading-6">…</p>
          )
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-6">{displayContent || "…"}</p>
        )}
        {isTerminalSystemError && !isSystemErrorOnly ? (
          <SystemErrorNotice status={message.status} message={message.errorMessage ?? ""} />
        ) : null}
        {isAssistant ? (
          <ToolCallTrace
            messageId={message._id}
            persistedToolCalls={message.toolCalls}
            isStreaming={message.status === "streaming"}
          />
        ) : null}
      </MessageContent>
      {/*
       * Reserve a fixed-height slot under every assistant bubble so the
       * streaming → completed handoff (when the cost ticker becomes
       * available) doesn't push subsequent messages down by ~28px each
       * time a reply settles. The row hosts both the cost ticker (left)
       * and the copy action (right), reserving space for the action
       * even when streaming so no shift occurs when the action becomes
       * visible on completion.
       */}
      {isAssistant ? (
        <AssistantMessageFooler
          isInFlight={isInFlight}
          costTicker={costTicker}
          nerdStats={nerdStats}
          tickerAriaLabel={tickerAriaLabel}
          content={displayContent}
        />
      ) : null}
    </Message>
  );
});

function AssistantMessageFooler({
  isInFlight,
  costTicker,
  nerdStats,
  tickerAriaLabel,
  content,
}: {
  isInFlight: boolean;
  costTicker: string | null;
  nerdStats: {
    model: string;
    tokensPerSecond: string;
    messageTokens: string;
    generationTime: string;
  } | null;
  tickerAriaLabel: string;
  content: string;
}) {
  return (
    <div className="relative min-h-7">
      <div
        className="absolute left-0 -mt-1! -ml-0.5 flex w-full flex-row justify-start gap-1 opacity-100 transition-opacity select-none md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 md:group-focus:opacity-100 md:group-has-aria-[describedby]:opacity-100 md:group-has-data-[state='delayed-open']:opacity-100 md:group-has-data-[state='instant-open']:opacity-100 print:hidden"
      >
        <div className="flex min-h-8 w-full items-center justify-between gap-3 px-2 py-1">
          <div className="min-w-0 flex-1">
            {nerdStats ? (
              <div
                className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground/90 tabular-nums"
                data-testid="message-nerd-stats"
              >
                {costTicker ? (
                  <span
                    className="truncate text-[13px] font-medium"
                    data-testid="message-cost-ticker"
                    aria-label={tickerAriaLabel}
                  >
                    {costTicker}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <CpuIcon size={14} />
                  {nerdStats.model}
                </span>
                <span className="inline-flex items-center gap-1">
                  <GaugeIcon size={14} />
                  {nerdStats.tokensPerSecond}
                </span>
                <span className="inline-flex items-center gap-1">
                  <HashIcon size={14} />
                  {nerdStats.messageTokens}
                </span>
                <span className="inline-flex items-center gap-1">
                  <ClockIcon size={14} />
                  {nerdStats.generationTime}
                </span>
              </div>
            ) : costTicker ? (
              <p
                className="truncate text-[13px] font-medium text-muted-foreground/90 tabular-nums"
                data-testid="message-cost-ticker"
                aria-label={tickerAriaLabel}
              >
                {costTicker}
              </p>
            ) : null}
          </div>
          {!isInFlight ? (
            <MessageActions className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <CopyMessageAction content={content} />
            </MessageActions>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SystemErrorNotice({ status, message }: { status: Doc<"messages">["status"]; message: string }) {
  const title = status === "cancelled" ? "Reply cancelled" : "Reply could not finish";
  return (
    <Alert variant="destructive" className="max-w-xl bg-destructive/5">
      <WarningCircleIcon size={16} weight="fill" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/**
 * Resolve the "Thought for N seconds" duration the `<Reasoning>` trigger
 * renders. Three cases:
 *
 *   - **Terminal reply** with `reasoningDurationMs` persisted → derive
 *     seconds from the durable field (rounded up so a sub-second reply
 *     still reads as `1`, matching the Reasoning trigger's own
 *     `Math.ceil` convention).
 *   - **Live stream** with both a start and an end timestamp → compute
 *     from the active-stream timestamps so the trigger settles on the
 *     correct duration immediately at `reasoning-end` without waiting
 *     for finalize to copy the field across.
 *   - **Mid-stream** (no end timestamp yet) → return `undefined` and
 *     let `<Reasoning>` paint the "Thinking…" shimmer.
 */
function computeReasoningDurationSeconds(
  message: Doc<"messages">,
  activeMessageStream: ActiveMessageStream | null,
  isLiveStream: boolean,
): number | undefined {
  if (isLiveStream && activeMessageStream) {
    const start = activeMessageStream.reasoningStartedAt;
    const end = activeMessageStream.reasoningEndedAt;
    if (start !== null && end !== null) {
      return Math.max(1, Math.ceil((end - start) / 1000));
    }
    return undefined;
  }
  if (message.reasoningDurationMs !== undefined) {
    return Math.max(1, Math.ceil(message.reasoningDurationMs / 1000));
  }
  return undefined;
}

/**
 * Copy button for assistant messages. Shows a checkmark briefly after
 * clicking to confirm the copy succeeded.
 *
 * Delegates to {@link useClipboard} so the timer cleanup (auto-reset
 * after 1.5s), unmount guard, and `navigator.clipboard` availability
 * check all match the rest of the app's copy affordances rather than
 * being re-derived here. The hook swallows clipboard failures and
 * leaves `copied` false on rejection — the affordance stays idle when
 * the browser blocks the write (insecure context, permissions policy)
 * instead of falsely confirming a successful copy.
 */
function CopyMessageAction({ content }: { content: string }) {
  const { copied, copy } = useClipboard({ resetAfterMs: 1500 });
  const handleCopy = useCallback(() => {
    void copy(content);
  }, [copy, content]);
  return (
    <MessageAction
      tooltip={copied ? "Copied" : "Copy reply"}
      size="sm"
      onClick={handleCopy}
      data-testid="message-copy-button"
    >
      {copied ? <CheckIcon size={16} weight="bold" /> : <CopyIcon size={16} />}
    </MessageAction>
  );
}

/**
 * Render the chat-bubble cost ticker.
 *
 * Tries to surface as much information as is available, in this order:
 *
 *   1. `~$0.03 · 1.2k tokens · 5 tools` — full info (priced model,
 *      tokens reported, tool-call trace persisted).
 *   2. `~$0.03 · 1.2k tokens` — full info minus tool calls (discuss /
 *      docs replies have no tools by design).
 *   3. `1.2k tokens · 5 tools` — pricing miss (model not in
 *      `llmPricing.ts`); we still show what we know.
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

function buildNerdStats(
  message: Doc<"messages">,
  displayContent: string,
  activeMessageStream: ActiveMessageStream | null,
): {
  model: string;
  tokensPerSecond: string;
  messageTokens: string;
  generationTime: string;
} {
  const outputTokens = message.estimatedOutputTokens ?? estimateMessageTokens(displayContent);
  const streamTiming =
    activeMessageStream && activeMessageStream.content.trim()
      ? {
          elapsedMs: Math.max(0, activeMessageStream.lastAppendedAt - activeMessageStream.startedAt),
          tokenCount: estimateMessageTokens(activeMessageStream.content),
        }
      : null;

  return {
    model: message.modelName ?? "model unavailable",
    tokensPerSecond:
      streamTiming && streamTiming.elapsedMs > 0
        ? `${formatTokensPerSecond(streamTiming.tokenCount / (streamTiming.elapsedMs / 1000))} tok/sec`
        : "tok/sec unavailable",
    messageTokens: `${formatTokenCount(outputTokens)} est. tokens`,
    generationTime: streamTiming
      ? `Generation time ${formatDurationSeconds(streamTiming.elapsedMs)}`
      : "Generation time unavailable",
  };
}

function estimateMessageTokens(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function formatTokensPerSecond(value: number): string {
  if (value >= 100) {
    return value.toFixed(0);
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function formatDurationSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} sec`;
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) {
    return "<$0.01";
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
 * Renders the injected `<citation>` tag for `[A#]` citation tokens.
 *
 * The tag wraps exactly the `[A1]` / `[A1#path]` token text, so this
 * parses the numeric index out of `children` and resolves it against
 * the message's citation map: a resolved index renders the clickable
 * citation button (forwarding the artifact id to `onSelectArtifact`),
 * an unresolved or unparseable one falls back to the literal token text
 * so the model's intent stays visible even when the map is missing it.
 */
function CitationRef({
  children,
  indexToArtifactId,
  onSelectArtifact,
}: {
  children?: ReactNode;
  indexToArtifactId: ReadonlyMap<number, ArtifactId>;
  onSelectArtifact?: (artifactId: ArtifactId) => void;
}) {
  const match = CITATION_TOKEN_REGEX.exec(getNodeText(children));
  const tokenIndex = match ? Number.parseInt(match[1], 10) : Number.NaN;
  const artifactId = Number.isNaN(tokenIndex) ? undefined : indexToArtifactId.get(tokenIndex);

  if (!artifactId || !onSelectArtifact) {
    // Unresolved tokens render as plain text so the model's intent is
    // visible even when the citation map is missing or out of range.
    return <>{children}</>;
  }

  return (
    <button
      type="button"
      onClick={() => onSelectArtifact(artifactId)}
      className="mx-0.5 inline-flex items-center border border-primary/30 bg-primary/5 px-1 py-0 text-[11px] font-semibold leading-5 text-primary hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-testid={`citation-link-${tokenIndex}`}
      aria-label={`Open referenced artifact A${tokenIndex}`}
    >
      {children}
    </button>
  );
}

/**
 * Flatten a React node tree to its text content. The injected
 * `<citation>` tag wraps exactly the `[A#]` token, so for a citation
 * this returns the literal token text `CitationRef` parses the index
 * out of. Defensive against streamdown handing back the token as a
 * nested node rather than a bare string.
 */
function getNodeText(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }
  if (typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getNodeText).join("");
  }
  if (isValidElement(node)) {
    return getNodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * UnverifiedMark wraps content in the existing styled mark for
 * unverified claims, with soft-yellow background and dotted underline.
 */
function UnverifiedMark({ children }: { children?: ReactNode }) {
  return (
    <mark
      className="rounded-sm bg-highlight/20 px-0.5 underline decoration-highlight/70 decoration-dotted underline-offset-2 dark:bg-highlight/15"
      data-testid="unverified-claim"
      title="The model did not cite a tool-verified source for this sentence. Read with skepticism."
    >
      {children}
    </mark>
  );
}

function getMessageStatusLabel(status: Doc<"messages">["status"]): string | null {
  switch (status) {
    case "pending":
      return "Queued";
    case "streaming":
      return "Generating";
    case "completed":
      // The default terminal state — every settled reply lands here, so
      // labelling it would just paint "Ready" on every bubble forever.
      // Suppress entirely; the absence of a status IS the "ok" signal.
      return null;
    case "failed":
      return "Failed";
    case "cancelled":
      // Distinct from "Failed" so the user can tell at a glance that they
      // themselves stopped the reply (vs. an upstream error).
      return "Cancelled";
    default:
      return status;
  }
}
