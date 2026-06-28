"use node";

/**
 * Live stream controller for a single assistant reply.
 *
 * This module owns the implementation-heavy parts of a reply stream:
 * cancellation polling, gateway abort wiring, text / reasoning buffers,
 * `fullStream` event handling, sandbox tool trace persistence, and partial
 * usage recovery. The caller keeps the higher-level session lifecycle:
 * context assembly, model selection, prompt construction, and terminal
 * message mutation selection.
 */

import { stepCountIs, type ToolSet } from "ai";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { STREAM_FLUSH_THRESHOLD } from "../lib/constants";
import { LlmRateLimitError, streamViaGateway, type LlmStreamResult } from "../lib/llmGateway";
import type { LlmProvider } from "../lib/llmProvider";
import { emitMetric, logInfo, logWarn } from "../lib/observability";
import type { ReasoningEffort, UserPickableCapability } from "./modelSelection";
import { redact } from "./redaction";
import type { SandboxTooling } from "./replyGrounding";
import {
  countUtf8Bytes,
  extractAuditMetadataFromToolOutput,
  tryRecordSandboxToolCallLogEntry,
} from "./sandboxToolCallLog";

/**
 * Maximum number of LLM steps in a sandbox-mode reply. Each step is one
 * model call — either the model emits text or it emits a tool call (which
 * the loop runs and feeds back as a new turn). 8 steps gives the model
 * room for a `list_dir` → 2-3 `read_file` → final answer pattern with
 * headroom for one corrective retry, and bounds total latency / cost.
 */
const SANDBOX_STEP_BUDGET = 8;

/**
 * Interval for the background poll that watches for owner-initiated
 * cancellation while the reply streams.
 */
const CANCELLATION_POLL_INTERVAL_MS = 1_000;

export interface ReplyStreamTelemetry {
  hadTools: boolean;
  toolInvocations: number;
  toolErrors: number;
}

/**
 * Shape consumed by the finalize / fail / cancel mutations and by the
 * session metric. Mirrors the gateway's normalized usage + `finalCostUsd`.
 * Optional everywhere because partial / aborted streams can leave any
 * subset of the fields unresolved.
 */
export type GatewayUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
};

export type ReplyStreamOutcome =
  | {
      kind: "completed";
      finalDelta: string;
      usage: GatewayUsage;
    }
  | {
      kind: "cancelled";
      finalDelta?: string;
      reason?: string;
      usage: GatewayUsage;
    }
  | {
      kind: "aborted_orphan";
      usage: GatewayUsage;
    }
  | {
      kind: "failed";
      finalDelta: string;
      errorMessage: string;
      usage: GatewayUsage;
    };

export interface ReplyCancellationState {
  wasCancelled: boolean;
  generationAborted: boolean;
  cancellationReason?: string;
}

interface ReplyStreamControllerArgs {
  assistantMessageId: Id<"messages">;
  jobId: Id<"jobs">;
}

interface ReplyStreamModelChoice {
  provider: LlmProvider;
  modelName: string;
  reasoningEffort: ReasoningEffort | undefined;
  capability: UserPickableCapability;
}

export type ReplyGroundingAudit = {
  ownerTokenIdentifier: string;
  sandboxTooling?: SandboxTooling;
};

interface ConsumeReplyStreamArgs {
  threadId: Id<"threads">;
  groundingAudit: ReplyGroundingAudit;
  modelChoice: ReplyStreamModelChoice;
  systemPrompt: string;
  userPromptText: string;
  sandboxTools?: ToolSet;
}

/**
 * Build the high-cardinality `details` payload shared by both
 * `sandbox_tool_invoked` emit sites.
 */
function buildToolMetricDetails(assistantMessageId: Id<"messages">, jobId: Id<"jobs">, toolCallId: string) {
  return {
    assistantMessageId: String(assistantMessageId),
    jobId: String(jobId),
    toolCallId,
  };
}

export function createReplyStreamController(ctx: ActionCtx, controllerArgs: ReplyStreamControllerArgs) {
  let pendingDelta = "";
  let pendingReasoningDelta = "";
  let stream: LlmStreamResult | undefined;
  let firstContentMarked = false;

  let wasCancelled = false;
  let cancellationReason: string | undefined;
  let generationAborted = false;
  let pollHandle: ReturnType<typeof setTimeout> | undefined;
  let pollingStarted = false;
  let pollingStopped = false;

  const telemetry: ReplyStreamTelemetry = {
    hadTools: false,
    toolInvocations: 0,
    toolErrors: 0,
  };

  const flushTextIfNeeded = async () => {
    if (pendingDelta.length >= STREAM_FLUSH_THRESHOLD) {
      await ctx.runMutation(internal.chat.streaming.appendAssistantStreamChunk, {
        assistantMessageId: controllerArgs.assistantMessageId,
        jobId: controllerArgs.jobId,
        delta: pendingDelta,
      });
      pendingDelta = "";
    }
  };

  const flushReasoningIfNeeded = async (options?: { force?: boolean }) => {
    if (pendingReasoningDelta.length === 0) {
      return;
    }
    if (!options?.force && pendingReasoningDelta.length < STREAM_FLUSH_THRESHOLD) {
      return;
    }
    const delta = pendingReasoningDelta;
    pendingReasoningDelta = "";
    try {
      await ctx.runMutation(internal.chat.streaming.appendAssistantReasoningDelta, {
        assistantMessageId: controllerArgs.assistantMessageId,
        jobId: controllerArgs.jobId,
        delta,
      });
    } catch (err) {
      logWarn("chat", "reasoning_flush_failed", {
        assistantMessageId: controllerArgs.assistantMessageId,
        jobId: controllerArgs.jobId,
        deltaLength: delta.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const terminalOutcome = (usage: GatewayUsage): ReplyStreamOutcome | undefined => {
    if (generationAborted) {
      return { kind: "aborted_orphan", usage };
    }
    if (wasCancelled) {
      return {
        kind: "cancelled",
        finalDelta: pendingDelta || undefined,
        reason: cancellationReason,
        usage,
      };
    }
    return undefined;
  };

  const readGatewayUsage = async (modelChoice: Pick<ReplyStreamModelChoice, "provider" | "modelName">) => {
    if (!stream) {
      return {};
    }
    try {
      const [usage, costUsd] = await Promise.all([stream.finalUsage, stream.finalCostUsd]);
      return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        reasoningTokens: usage.reasoningTokens,
        costUsd,
      };
    } catch (error) {
      logWarn("chat", "assistant_reply_usage_unavailable", {
        assistantMessageId: controllerArgs.assistantMessageId,
        jobId: controllerArgs.jobId,
        provider: modelChoice.provider,
        model: modelChoice.modelName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  };

  const runPollTick = async (): Promise<void> => {
    if (pollingStopped) {
      return;
    }
    try {
      const status = await ctx.runQuery(internal.chat.streaming.getJobCancellationStatus, {
        jobId: controllerArgs.jobId,
      });
      if (pollingStopped) {
        return;
      }
      if (status.cancelled) {
        wasCancelled = true;
        cancellationReason = "Cancelled by user.";
        stream?.abort();
        return;
      }
      if (status.jobMissing) {
        generationAborted = true;
        pollingStopped = true;
        stream?.abort();
        return;
      }
    } catch (error) {
      logWarn("chat", "cancellation_poll_failed", {
        assistantMessageId: controllerArgs.assistantMessageId,
        jobId: controllerArgs.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    schedulePoll();
  };

  const schedulePoll = (): void => {
    if (pollingStopped) {
      return;
    }
    pollHandle = setTimeout(() => {
      void runPollTick();
    }, CANCELLATION_POLL_INTERVAL_MS);
  };

  const consume = async (args: ConsumeReplyStreamArgs): Promise<ReplyStreamOutcome> => {
    const preStreamTerminal = terminalOutcome({});
    if (preStreamTerminal) {
      return preStreamTerminal;
    }

    telemetry.hadTools = args.sandboxTools !== undefined;

    try {
      stream = await streamViaGateway(
        ctx,
        {
          provider: args.modelChoice.provider,
          modelName: args.modelChoice.modelName,
          ownerTokenIdentifier: args.groundingAudit.ownerTokenIdentifier,
          capability: args.modelChoice.capability,
          feature: "chat",
          threadId: args.threadId,
          messageId: controllerArgs.assistantMessageId,
        },
        {
          system: args.systemPrompt,
          prompt: args.userPromptText,
          tools: args.sandboxTools,
          stopWhen: stepCountIs(SANDBOX_STEP_BUDGET),
          reasoningEffort: args.modelChoice.reasoningEffort,
          prepareStep: args.sandboxTools
            ? ({ stepNumber }) => {
                if (stepNumber === 0) {
                  return undefined;
                }
                const remaining = SANDBOX_STEP_BUDGET - stepNumber;
                return {
                  system: `${args.systemPrompt}\n\n[Tool-budget reminder: you have used ${stepNumber} of ${SANDBOX_STEP_BUDGET} tool steps; ${remaining} remain. If your evidence is already sufficient, write the final answer now instead of taking another tool step.]`,
                };
              }
            : undefined,
        },
      );

      if (wasCancelled || generationAborted) {
        stream.abort();
      }

      await consumeGatewayEvents(args);

      if (!generationAborted) {
        await flushReasoningIfNeeded({ force: true });
      }

      const usage = await readGatewayUsage(args.modelChoice);
      const terminal = terminalOutcome(usage);
      if (terminal) {
        return terminal;
      }
      return {
        kind: "completed",
        finalDelta: pendingDelta,
        usage,
      };
    } catch (error) {
      if (!generationAborted) {
        try {
          await flushReasoningIfNeeded({ force: true });
        } catch (flushError) {
          logWarn("chat", "reasoning_flush_failed_on_error_path", {
            assistantMessageId: controllerArgs.assistantMessageId,
            jobId: controllerArgs.jobId,
            error: flushError instanceof Error ? flushError.message : String(flushError),
          });
        }
      }

      const usage = await readGatewayUsage(args.modelChoice);
      const terminal = terminalOutcome(usage);
      if (terminal) {
        return terminal;
      }
      return {
        kind: "failed",
        finalDelta: pendingDelta,
        errorMessage: formatReplyStreamError(error),
        usage,
      };
    }
  };

  const consumeGatewayEvents = async (args: ConsumeReplyStreamArgs): Promise<void> => {
    if (!stream) {
      return;
    }
    const toolCallMap = new Map<string, { toolName: string; inputSummary: string; startedAt: number }>();

    for await (const part of stream.fullStream) {
      if (wasCancelled || generationAborted) {
        break;
      }
      switch (part.type) {
        case "text-delta": {
          if (!firstContentMarked && part.text.length > 0) {
            firstContentMarked = true;
            await ctx.runMutation(internal.chat.streaming.markAssistantFirstContentAt, {
              assistantMessageId: controllerArgs.assistantMessageId,
              jobId: controllerArgs.jobId,
              occurredAt: Date.now(),
            });
          }
          pendingDelta += part.text;
          await flushTextIfNeeded();
          break;
        }
        case "tool-call": {
          const occurredAt = Date.now();
          const inputJson = JSON.stringify(part.input ?? {});
          const { redacted: inputSummary } = redact(inputJson);

          toolCallMap.set(part.toolCallId, {
            toolName: part.toolName,
            inputSummary,
            startedAt: occurredAt,
          });
          telemetry.toolInvocations += 1;

          await ctx.runMutation(internal.chat.streaming.appendAssistantToolCallEvent, {
            assistantMessageId: controllerArgs.assistantMessageId,
            jobId: controllerArgs.jobId,
            toolCallId: part.toolCallId,
            type: "start",
            toolName: part.toolName,
            inputSummary,
            occurredAt,
          });

          logInfo("chat", "sandbox_tool_call", {
            assistantMessageId: controllerArgs.assistantMessageId,
            jobId: controllerArgs.jobId,
            toolName: part.toolName,
            toolCallId: part.toolCallId,
          });
          break;
        }
        case "tool-result": {
          const occurredAt = Date.now();
          const toolCall = toolCallMap.get(part.toolCallId);
          const resultJson = JSON.stringify(part.output ?? {});
          const { redacted: outputSummary } = redact(resultJson);

          await ctx.runMutation(internal.chat.streaming.appendAssistantToolCallEvent, {
            assistantMessageId: controllerArgs.assistantMessageId,
            jobId: controllerArgs.jobId,
            toolCallId: part.toolCallId,
            type: "end",
            toolName: toolCall?.toolName ?? part.toolName,
            inputSummary: toolCall?.inputSummary ?? "",
            outputSummary,
            occurredAt,
          });

          const auditMetadata = extractAuditMetadataFromToolOutput(part.output);
          const toolDurationMs = toolCall ? Math.max(0, occurredAt - toolCall.startedAt) : 0;
          const isOk = auditMetadata.errorCode === undefined;
          if (!isOk) {
            telemetry.toolErrors += 1;
          }
          emitMetric("sandbox_tool_invoked", {
            value: toolDurationMs,
            tags: {
              tool: toolCall?.toolName ?? part.toolName,
              ok: isOk,
              error_code: auditMetadata.errorCode,
            },
            details: buildToolMetricDetails(controllerArgs.assistantMessageId, controllerArgs.jobId, part.toolCallId),
          });

          if (args.groundingAudit.sandboxTooling) {
            await tryRecordSandboxToolCallLogEntry(ctx, {
              ownerTokenIdentifier: args.groundingAudit.ownerTokenIdentifier,
              threadId: args.threadId,
              messageId: controllerArgs.assistantMessageId,
              sandboxId: args.groundingAudit.sandboxTooling.sandboxId,
              toolName: toolCall?.toolName ?? part.toolName,
              inputJson: toolCall?.inputSummary ?? "{}",
              outputBytes: countUtf8Bytes(resultJson),
              durationMs: toolDurationMs,
              errorCode: auditMetadata.errorCode,
              redactedFields: auditMetadata.redactedFields,
            });
          }

          logInfo("chat", "sandbox_tool_result", {
            assistantMessageId: controllerArgs.assistantMessageId,
            jobId: controllerArgs.jobId,
            toolName: part.toolName,
            toolCallId: part.toolCallId,
          });
          break;
        }
        case "tool-error": {
          const occurredAt = Date.now();
          const toolCall = toolCallMap.get(part.toolCallId);
          const errorMessage = part.error instanceof Error ? part.error.message : String(part.error);
          const redactedError = redact(`Error: ${errorMessage}`).redacted;

          await ctx.runMutation(internal.chat.streaming.appendAssistantToolCallEvent, {
            assistantMessageId: controllerArgs.assistantMessageId,
            jobId: controllerArgs.jobId,
            toolCallId: part.toolCallId,
            type: "end",
            toolName: toolCall?.toolName ?? part.toolName,
            inputSummary: toolCall?.inputSummary ?? "",
            outputSummary: redactedError,
            errorCode: "tool_error",
            occurredAt,
          });

          telemetry.toolErrors += 1;
          const toolErrorDurationMs = toolCall ? Math.max(0, occurredAt - toolCall.startedAt) : 0;
          emitMetric("sandbox_tool_invoked", {
            value: toolErrorDurationMs,
            tags: {
              tool: toolCall?.toolName ?? part.toolName,
              ok: false,
              error_code: "tool_error",
            },
            details: buildToolMetricDetails(controllerArgs.assistantMessageId, controllerArgs.jobId, part.toolCallId),
          });

          if (args.groundingAudit.sandboxTooling) {
            await tryRecordSandboxToolCallLogEntry(ctx, {
              ownerTokenIdentifier: args.groundingAudit.ownerTokenIdentifier,
              threadId: args.threadId,
              messageId: controllerArgs.assistantMessageId,
              sandboxId: args.groundingAudit.sandboxTooling.sandboxId,
              toolName: toolCall?.toolName ?? part.toolName,
              inputJson: toolCall?.inputSummary ?? "{}",
              outputBytes: 0,
              durationMs: toolErrorDurationMs,
              errorCode: "tool_error",
              redactedFields: [],
            });
          }

          logWarn("chat", "sandbox_tool_error", {
            assistantMessageId: controllerArgs.assistantMessageId,
            jobId: controllerArgs.jobId,
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            error: redactedError,
          });
          break;
        }
        case "reasoning-start": {
          try {
            await ctx.runMutation(internal.chat.streaming.markReasoningStarted, {
              assistantMessageId: controllerArgs.assistantMessageId,
              jobId: controllerArgs.jobId,
              occurredAt: Date.now(),
            });
          } catch (err) {
            logWarn("chat", "reasoning_start_failed", {
              assistantMessageId: controllerArgs.assistantMessageId,
              jobId: controllerArgs.jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case "reasoning-delta": {
          pendingReasoningDelta += part.text;
          await flushReasoningIfNeeded();
          break;
        }
        case "reasoning-end": {
          await flushReasoningIfNeeded({ force: true });
          try {
            await ctx.runMutation(internal.chat.streaming.markReasoningEnded, {
              assistantMessageId: controllerArgs.assistantMessageId,
              jobId: controllerArgs.jobId,
              occurredAt: Date.now(),
            });
          } catch (err) {
            logWarn("chat", "reasoning_end_failed", {
              assistantMessageId: controllerArgs.assistantMessageId,
              jobId: controllerArgs.jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case "error": {
          const message = part.error instanceof Error ? part.error.message : `Stream error: ${String(part.error)}`;
          throw new Error(message);
        }
        default:
          break;
      }
    }
  };

  return {
    startCancellationPolling: () => {
      if (pollingStarted) {
        return;
      }
      pollingStarted = true;
      schedulePoll();
    },
    stopCancellationPolling: () => {
      pollingStopped = true;
      if (pollHandle) {
        clearTimeout(pollHandle);
        pollHandle = undefined;
      }
    },
    getCancellationState: (): ReplyCancellationState => ({
      wasCancelled,
      generationAborted,
      cancellationReason,
    }),
    getBufferedText: () => pendingDelta,
    getTelemetry: (): ReplyStreamTelemetry => ({ ...telemetry }),
    consume,
  };
}

/**
 * Surface a gateway-level rate-limit denial to the user as a single
 * sentence the chat bubble can render verbatim.
 */
export function formatReplyStreamError(error: unknown): string {
  if (error instanceof LlmRateLimitError) {
    const retrySeconds = Math.max(1, Math.round(error.retryAfterMs / 1000));
    switch (error.code) {
      case "requests_per_minute_exceeded":
        return `Too many recent requests. Please wait about ${retrySeconds}s and try again.`;
      case "concurrency_exceeded":
        return "Too many active replies. Close another conversation or wait for the current ones to finish.";
    }
  }
  return error instanceof Error ? error.message : "Unknown assistant error";
}
