"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { runFocusedInspection } from "./daytona";
import { logErrorWithId } from "./lib/observability";

type FailureModeContext = {
  threadId: Id<"threads">;
  repositoryId: Id<"repositories">;
  ownerTokenIdentifier: string;
  sourceRepoFullName: string;
  remoteSandboxId: string;
  repoPath: string;
};

export const runFailureModeAnalysis = internalAction({
  args: {
    threadId: v.id("threads"),
    subsystem: v.string(),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const start = (await ctx.runMutation(internal.designArtifacts.markFailureModeRunning, {
      jobId: args.jobId,
    })) as { started: boolean };
    if (!start.started) {
      return;
    }

    try {
      const context = (await ctx.runQuery(internal.designArtifacts.getFailureModeContext, {
        threadId: args.threadId,
      })) as FailureModeContext;

      const inspectionPrompt = [
        `Subsystem: ${args.subsystem}`,
        "List potential failure modes, likely blast radius, and concrete mitigations.",
        "Prioritize integration boundaries and stateful paths.",
      ].join("\n");
      const inspectionLog = await runFocusedInspection(context.remoteSandboxId, context.repoPath, inspectionPrompt);

      const { summary, contentMarkdown } = buildFailureModeReport(
        context.sourceRepoFullName,
        args.subsystem,
        inspectionLog,
      );

      await ctx.runMutation(internal.designArtifacts.completeFailureModeAnalysis, {
        jobId: args.jobId,
        threadId: context.threadId,
        repositoryId: context.repositoryId,
        ownerTokenIdentifier: context.ownerTokenIdentifier,
        subsystem: args.subsystem,
        summary,
        contentMarkdown,
      });
    } catch (error) {
      const errorId = logErrorWithId("designArtifacts", "failure_mode_analysis_failed", error, {
        threadId: args.threadId,
        subsystem: args.subsystem,
        jobId: args.jobId,
      });
      await ctx.runMutation(internal.designArtifacts.failFailureModeAnalysis, {
        jobId: args.jobId,
        errorMessage: `${
          error instanceof Error ? error.message : "Unknown failure mode analysis error"
        }\n\nReference: ${errorId}`,
      });
    }
  },
});

function buildFailureModeReport(repository: string, subsystem: string, inspectionLog: string) {
  const inspection = parseInspectionLog(inspectionLog);
  const files = inspection.matchingFiles.slice(0, 8);

  const rows =
    files.length > 0
      ? files.map((path, index) => {
          const n = index + 1;
          return [
            `### Failure ${n}: ${subsystem} path regression (${path})`,
            "- **Component**: subsystem runtime path",
            "- **Failure description**: Runtime or integration behavior diverges from expected contract.",
            "- **Blast radius**: User-facing flow relying on this path plus adjacent callers.",
            "- **Mitigation**: Add targeted guardrails, explicit error handling, and focused integration tests.",
            `- **Code references**: \`${path}\``,
          ].join("\n");
        })
      : [
          [
            `### Failure 1: ${subsystem} boundary mismatch`,
            "- **Component**: subsystem integration boundary",
            "- **Failure description**: Interface contracts drift across components.",
            "- **Blast radius**: Calls traversing this boundary may return inconsistent state.",
            "- **Mitigation**: Add contract tests and tighten validation at boundary ingress.",
            "- **Code references**: No direct file match detected from sandbox scan.",
          ].join("\n"),
        ];

  const summary = `${repository}: identified ${rows.length} failure mode ${
    rows.length === 1 ? "entry" : "entries"
  } for subsystem "${subsystem}".`;

  const markdown = [
    "# Failure Mode Analysis",
    "",
    `- Repository: ${repository}`,
    `- Subsystem: ${subsystem}`,
    `- Search terms: ${inspection.terms.length > 0 ? inspection.terms.join(", ") : "none"}`,
    "",
    "## Findings",
    ...rows,
    "",
    "## Sandbox Scan Snapshot",
    "```json",
    inspectionLog || "{}",
    "```",
  ].join("\n");

  return { summary, contentMarkdown: markdown };
}

function parseInspectionLog(raw: string): { terms: string[]; matchingFiles: string[] } {
  try {
    const parsed = JSON.parse(raw) as {
      terms?: unknown;
      matchingFiles?: unknown;
    };
    const terms = Array.isArray(parsed.terms)
      ? parsed.terms.filter((item): item is string => typeof item === "string")
      : [];
    const matchingFiles = Array.isArray(parsed.matchingFiles)
      ? parsed.matchingFiles.filter((item): item is string => typeof item === "string")
      : [];
    return { terms, matchingFiles };
  } catch {
    return { terms: [], matchingFiles: [] };
  }
}
