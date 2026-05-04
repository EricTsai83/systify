import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { CaretDownIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Plan 06 — live + persisted tool-call trace for a single assistant
 * message.
 *
 * Two states one component:
 *
 *   1. **Streaming** (`isStreaming === true`) — subscribe to
 *      `chat/streaming.getMessageToolCallEvents`. The query folds the
 *      ephemeral `messageToolCallEvents` rows into the same shape as the
 *      durable `messages.toolCalls` plus an explicit `state` field. While
 *      a tool is in flight, the latest entry's `state` is `"running"` and
 *      the ticker bar paints "Reading <path>…" with a spinner. As soon as
 *      the matching `tool-result`/`tool-error` event lands, the entry
 *      transitions to `"completed"` / `"errored"` and the ticker switches
 *      to the next (or disappears).
 *
 *   2. **Finalized** — the streaming finalize / fail mutation drains the
 *      events table in the same transaction that flips `messages.status`
 *      and writes `messages.toolCalls`. The component receives that
 *      array via `persistedToolCalls` and uses it as the source of truth.
 *
 * Why one component (not two): both states render the same collapsible
 * "Tool Calls (N)" footer. Hoisting the renderer keeps the visual
 * boundary stable across the streaming → finalized transition (no flicker
 * when the events drain) and means the tests only need to cover one
 * shape.
 *
 * Why a single normalized type (`NormalizedToolCall`): the live shape
 * carries an explicit `state`, while the persisted shape derives state
 * from `endedAt > startedAt` + `errorCode`. Normalizing in `useMemo`
 * once per render means the renderer body never branches on which
 * upstream produced the entry.
 */

interface ToolCallTraceProps {
  messageId: Id<"messages">;
  /**
   * Persisted trace from `messages.toolCalls`, populated at finalize/fail
   * time. The component prefers the live subscription while
   * `isStreaming === true`; this prop becomes the source of truth as
   * soon as streaming settles.
   */
  persistedToolCalls?: Doc<"messages">["toolCalls"];
  /**
   * `true` while the assistant message is in `streaming` status. Drives
   * whether `useQuery` subscribes (the "skip" sentinel keeps the live
   * subscription off for finalized messages, so chat-panel re-renders
   * don't open extra subscriptions for completed history items).
   */
  isStreaming: boolean;
}

type ToolCallState = "running" | "completed" | "errored";

type NormalizedToolCall = {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  startedAt: number;
  endedAt: number;
  errorCode?: string;
  state: ToolCallState;
};

/**
 * Best-effort string-field extractor for the redacted JSON-stringified
 * tool args produced by `generation.ts` (e.g.
 * `{"path":"convex/chat/send.ts"}` for `read_file` /
 * `{"command":"grep -r foo convex/"}` for `run_shell`).
 *
 * Returns the value of `field` when:
 *   - `inputSummary` parses to a non-array object, AND
 *   - the field is present and is a non-empty string.
 *
 * A parse failure (truncated JSON, future tool whose input isn't an
 * object, raw-string fixture) returns `null` so callers can fall back to
 * the raw summary. We exclude arrays explicitly because `Array.isArray`
 * objects have a property index of `0,1,…` that could collide with a
 * future tool whose schema accepts an array of strings.
 */
function extractInputField(inputSummary: string, field: string): string | null {
  try {
    const parsed: unknown = JSON.parse(inputSummary);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && field in parsed) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  } catch {
    // Fall through; the JSON may have been truncated or the input is a
    // raw string (e.g. unit-test fixtures, or a tool whose `inputSummary`
    // isn't JSON-shaped after redaction).
  }
  return null;
}

/** Convenience for the common `path` lookup used by the entry renderer. */
function extractPath(inputSummary: string): string | null {
  return extractInputField(inputSummary, "path");
}

function deriveStateFromPersisted(entry: {
  startedAt: number;
  endedAt: number;
  errorCode?: string;
}): ToolCallState {
  if (entry.errorCode) return "errored";
  if (entry.endedAt > entry.startedAt) return "completed";
  return "running";
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Cap the ticker preview so a long command doesn't overflow the bar. */
const TICKER_PREVIEW_MAX_CHARS = 60;

function truncatePreview(value: string): string {
  return value.length > TICKER_PREVIEW_MAX_CHARS
    ? `${value.slice(0, TICKER_PREVIEW_MAX_CHARS)}…`
    : value;
}

function tickerLabel(tool: NormalizedToolCall): string {
  const path = extractPath(tool.inputSummary);
  switch (tool.toolName) {
    case "read_file":
      return path ? `Reading ${path}` : "Reading file";
    case "list_dir":
      return path ? `Listing ${path}` : "Listing directory";
    case "run_shell": {
      // Plan 08 lands `run_shell` whose `inputSummary` is the redacted
      // JSON-stringified args (e.g. `{"command":"grep -r foo convex/"}`).
      // Pull `command` out so the ticker reads `Running grep -r foo …`
      // instead of leaking the JSON braces. If the JSON parse fails
      // (e.g. unit-test fixture passing a raw string, or a truncated
      // payload), fall back to a length-capped preview of the raw
      // summary so the ticker still has something to display.
      const command = extractInputField(tool.inputSummary, "command");
      return command
        ? `Running ${truncatePreview(command)}`
        : `Running ${truncatePreview(tool.inputSummary)}`;
    }
    default:
      return path ? `${tool.toolName}: ${path}` : tool.toolName;
  }
}

export function ToolCallTrace({
  messageId,
  persistedToolCalls,
  isStreaming,
}: ToolCallTraceProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Live subscription. We pass `"skip"` for non-streaming messages so the
  // historical chat list doesn't fan out one subscription per assistant
  // bubble — only the in-flight reply (at most one per thread) holds an
  // active query.
  const liveEvents = useQuery(
    api.chat.streaming.getMessageToolCallEvents,
    isStreaming ? { assistantMessageId: messageId } : "skip",
  );

  const toolCalls = useMemo<NormalizedToolCall[]>(() => {
    // Streaming mode: prefer live data even when `persistedToolCalls` is
    // present, so the streaming → completed handoff never displays a
    // momentarily-stale persisted trace from a previous render snapshot.
    if (isStreaming) {
      // `null` means "still loading" — render nothing rather than a stale
      // persisted trace, so the user doesn't see a previous reply's
      // ticker reappear under a new in-flight reply.
      if (!liveEvents) {
        return [];
      }
      return liveEvents;
    }
    if (!persistedToolCalls || persistedToolCalls.length === 0) {
      return [];
    }
    return persistedToolCalls.map((entry) => ({
      ...entry,
      state: deriveStateFromPersisted(entry),
    }));
  }, [isStreaming, liveEvents, persistedToolCalls]);

  if (toolCalls.length === 0) {
    return null;
  }

  // The ticker shows the *currently running* tool. If everything has
  // settled (or the message has finalized), there is no running tool and
  // we drop the ticker — only the collapsible summary remains.
  const runningTool = isStreaming ? toolCalls.find((tool) => tool.state === "running") : undefined;

  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="tool-call-trace">
      {runningTool ? (
        <div
          className="mb-2 flex items-center gap-2 rounded-sm bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground"
          data-testid="tool-call-ticker"
          aria-live="polite"
        >
          <SpinnerGapIcon size={14} className="animate-spin shrink-0" />
          <span className="truncate">{tickerLabel(runningTool)}…</span>
        </div>
      ) : null}

      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-ml-2 gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            data-testid="tool-call-trace-toggle"
            aria-expanded={isExpanded}
          >
            <CaretDownIcon
              size={12}
              weight="bold"
              className={cn("transition-transform duration-200", isExpanded && "rotate-180")}
            />
            <span>Tool calls ({toolCalls.length})</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2">
          {toolCalls.map((tool) => (
            <ToolCallEntry key={tool.toolCallId} tool={tool} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ToolCallEntry({ tool }: { tool: NormalizedToolCall }) {
  const path = extractPath(tool.inputSummary);
  const durationMs = tool.endedAt - tool.startedAt;

  return (
    <div
      className={cn(
        "rounded-sm border border-border/60 bg-muted/30 px-2 py-2 text-xs",
        tool.state === "errored" && "border-destructive/30 bg-destructive/5",
      )}
      data-testid={`tool-call-entry-${tool.toolCallId}`}
      data-state={tool.state}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="font-mono font-semibold">{tool.toolName}</span>
          {path ? <span className="truncate text-muted-foreground">{path}</span> : null}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {tool.state === "running" ? (
            <SpinnerGapIcon size={11} className="animate-spin" />
          ) : null}
          {tool.state === "errored" ? (
            <WarningCircleIcon size={11} weight="bold" className="text-destructive" />
          ) : null}
          {tool.state !== "running" ? <span>{formatDuration(durationMs)}</span> : null}
        </div>
      </div>
      {tool.outputSummary ? (
        <pre
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-background/40 p-1.5 font-mono text-[10px] leading-snug text-muted-foreground"
          data-testid={`tool-call-output-${tool.toolCallId}`}
        >
          {tool.outputSummary}
        </pre>
      ) : null}
      {tool.errorCode ? (
        <p className="mt-1.5 text-[10px] text-destructive">Error code: {tool.errorCode}</p>
      ) : null}
    </div>
  );
}
