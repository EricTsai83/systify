"use node";

import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";
import { createSandboxTools } from "./chat/sandboxTools";
import { resolveModelForMode } from "./chat/modelSelection";
import { getSandboxFsClient } from "./daytona";
import {
  buildRepositoryManifest,
  createArchitectureArtifactMarkdown,
  createManifestArtifactMarkdown,
  type RepositorySnapshot,
} from "./lib/repoAnalysis";
import { logErrorWithId, logInfo, logWarn } from "./lib/observability";
import type { SystemDesignKind } from "./lib/systemDesign";

const SYSTEM_DESIGN_STEP_BUDGET = 12;

const HEURISTIC_FILES_TAKE_LIMIT = 2000;

const systemDesignKindValidator = v.union(
  v.literal("manifest"),
  v.literal("readme_summary"),
  v.literal("architecture_overview"),
  v.literal("data_model_overview"),
  v.literal("api_surface_overview"),
  v.literal("deployment_overview"),
  v.literal("security_overview"),
  v.literal("operations_overview"),
);

type HeuristicKind = Extract<SystemDesignKind, "manifest" | "readme_summary" | "architecture_overview">;

function isHeuristicKind(kind: SystemDesignKind): kind is HeuristicKind {
  return kind === "manifest" || kind === "readme_summary" || kind === "architecture_overview";
}

/**
 * Library System Design generator.
 *
 * Concurrency model:
 *   - Heuristic kinds (`manifest` / `readme_summary` / `architecture_overview`)
 *     derive from imported `repoFiles` + `repoChunks` rows and only touch
 *     Convex. They run concurrently against the shared snapshot.
 *   - LLM kinds (`*_overview`) each spin a `generateText` call against the
 *     sandbox-backed model with the same `read_file` / `list_dir` /
 *     `run_shell` tool factory the chat-sandbox path uses. They run serially
 *     to honour the per-sandbox tool budget and the OpenAI rate limit; the
 *     job lease is refreshed before each one so a long publication does not
 *     trip the stale-recovery sweep.
 *
 * The two passes run in parallel so a long LLM run does not gate the cheap
 * heuristic publication. Per-kind failures are isolated: the catch logs an
 * errorId and the next kind continues. Progress flows back through
 * `updateGenerationProgress` after every kind completes (success or fail).
 */
export const runSystemDesignGeneration = internalAction({
  args: {
    jobId: v.id("jobs"),
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    selections: v.array(systemDesignKindValidator),
  },
  handler: async (ctx, args) => {
    const start = (await ctx.runMutation(internal.systemDesign.markGenerationStarted, {
      jobId: args.jobId,
      selections: args.selections,
    })) as { started: boolean };
    if (!start.started) {
      return;
    }

    const context = await ctx.runQuery(internal.systemDesign.getGenerationContext, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
    });

    if (context === null) {
      await ctx.runMutation(internal.systemDesign.failGeneration, {
        jobId: args.jobId,
        errorMessage: "Repository was deleted before the generation could start.",
      });
      return;
    }

    const selections = args.selections as ReadonlyArray<SystemDesignKind>;
    const heuristicKinds = selections.filter(isHeuristicKind);
    const llmKinds = selections.filter(
      (kind): kind is Exclude<SystemDesignKind, HeuristicKind> => !isHeuristicKind(kind),
    );

    const heuristicSnapshot =
      heuristicKinds.length > 0 ? await loadHeuristicSnapshot(ctx, args.repositoryId, args.jobId) : null;

    const totalCount = selections.length;
    let completedCount = 0;
    let succeeded = 0;
    let failed = 0;

    const reportProgress = async (kindLabel: string) => {
      await ctx.runMutation(internal.systemDesign.updateGenerationProgress, {
        jobId: args.jobId,
        completedCount,
        totalCount,
        stage: `Generated ${completedCount} of ${totalCount}: ${kindLabel}`,
      });
    };

    const runKind = async (
      kind: SystemDesignKind,
      produce: () => Promise<{ contentMarkdown: string; summary: string; source: "heuristic" | "sandbox" }>,
    ) => {
      try {
        const result = await produce();
        await ctx.runMutation(internal.systemDesign.persistGeneratedArtifact, {
          repositoryId: args.repositoryId,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          jobId: args.jobId,
          kind,
          title: HEADINGS[kind],
          summary: result.summary,
          contentMarkdown: result.contentMarkdown,
          source: result.source,
        });
        succeeded += 1;
      } catch (error) {
        failed += 1;
        const errorId = logErrorWithId("systemDesign", "kind_generation_failed", error, {
          jobId: args.jobId,
          repositoryId: args.repositoryId,
          kind,
        });
        logWarn("systemDesign", "kind_skipped", {
          jobId: args.jobId,
          kind,
          errorId,
        });
      }
      completedCount += 1;
      await reportProgress(HEADINGS[kind]);
    };

    const heuristicPass = Promise.all(
      heuristicKinds.map((kind) =>
        runKind(kind, async () => {
          if (heuristicSnapshot === null) {
            throw new Error("Heuristic snapshot was not loaded.");
          }
          return generateHeuristic(kind, heuristicSnapshot);
        }),
      ),
    );

    const llmPass = (async () => {
      for (const kind of llmKinds) {
        // Refresh the running job's lease before each LLM kind so a long
        // multi-kind publication does not overrun the initial lease window
        // and trigger spurious stale-recovery while progress is still
        // happening.
        await ctx.runMutation(internal.systemDesign.refreshGenerationLease, { jobId: args.jobId });
        await runKind(kind, () => generateLlm(kind, context.activeSandbox, context.repository));
      }
    })();

    await Promise.all([heuristicPass, llmPass]);

    await ctx.runMutation(internal.systemDesign.completeGeneration, {
      jobId: args.jobId,
      selections: args.selections,
      succeededCount: succeeded,
      failedCount: failed,
    });

    logInfo("systemDesign", "generation_complete", {
      jobId: args.jobId,
      repositoryId: args.repositoryId,
      succeeded,
      failed,
      total: totalCount,
    });
  },
});

const HEADINGS: Record<SystemDesignKind, string> = {
  manifest: "Repository Manifest",
  readme_summary: "README Summary",
  architecture_overview: "Architecture Overview",
  data_model_overview: "Data Model Overview",
  api_surface_overview: "API Surface Overview",
  deployment_overview: "Deployment Overview",
  security_overview: "Security Overview",
  operations_overview: "Operations Overview",
};

type HeuristicSnapshot = {
  snapshot: RepositorySnapshot;
  readmePath: string | undefined;
  readmeContent: string | undefined;
};

async function loadHeuristicSnapshot(
  ctx: ActionCtx,
  repositoryId: Id<"repositories">,
  jobId: Id<"jobs">,
): Promise<HeuristicSnapshot> {
  const [files, readme] = await Promise.all([
    ctx.runQuery(internal.systemDesign.listRepoFilesForHeuristics, { repositoryId }),
    ctx.runQuery(internal.systemDesign.findReadmeChunkForHeuristics, { repositoryId }),
  ]);

  if (files.length === HEURISTIC_FILES_TAKE_LIMIT) {
    // We hit the per-query `take` cap. The heuristic generators still
    // produce a usable doc, but it will under-represent very large repos —
    // surface that explicitly so we can spot the silent truncation in
    // logs without having to repro.
    logWarn("systemDesign", "heuristic_file_list_truncated", {
      jobId,
      repositoryId,
      takeLimit: HEURISTIC_FILES_TAKE_LIMIT,
      hint: "Heuristic generators saw a truncated repo file list; consider paging the query or accepting partial coverage.",
    });
  }

  const snapshot: RepositorySnapshot = {
    readmePath: readme?.path,
    readmeContent: readme?.content,
    importantFileContents: [],
    files: files.map((file) => ({
      path: file.path,
      parentPath: file.parentPath,
      fileType: file.fileType,
      extension: file.extension,
      language: file.language,
      sizeBytes: file.sizeBytes,
      isEntryPoint: file.isEntryPoint,
      isConfig: file.isConfig,
      isImportant: file.isImportant,
      summary: file.summary,
    })),
  };

  return { snapshot, readmePath: readme?.path, readmeContent: readme?.content };
}

function generateHeuristic(
  kind: HeuristicKind,
  data: HeuristicSnapshot,
): { contentMarkdown: string; summary: string; source: "heuristic" } {
  const manifest = buildRepositoryManifest(data.snapshot);

  if (kind === "manifest") {
    return {
      contentMarkdown: createManifestArtifactMarkdown(manifest),
      summary: manifest.summary,
      source: "heuristic",
    };
  }
  if (kind === "readme_summary") {
    const md =
      data.readmeContent && data.readmePath
        ? `# README Summary\n\nSource: \`${data.readmePath}\`\n\n${data.readmeContent.slice(0, 6000)}`
        : "# README Summary\n\nNo README was detected during import.";
    return {
      contentMarkdown: md,
      summary: summarizeReadmeText(data.readmeContent),
      source: "heuristic",
    };
  }
  return {
    contentMarkdown: createArchitectureArtifactMarkdown(manifest, data.snapshot),
    summary: "Initial architecture map derived from the repository layout.",
    source: "heuristic",
  };
}

function summarizeReadmeText(readme: string | undefined): string {
  if (!readme) return "No README was detected during import.";
  const firstParagraph = readme
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4)
    .join(" ");
  return firstParagraph.slice(0, 280) || "README captured at import time.";
}

const LLM_PROMPTS: Record<
  Extract<
    SystemDesignKind,
    "data_model_overview" | "api_surface_overview" | "deployment_overview" | "security_overview" | "operations_overview"
  >,
  string
> = {
  data_model_overview: `You are documenting the data model of a software repository for a new
engineer joining the team. Use the sandbox tools (read_file, list_dir,
run_shell) to inspect the repository and identify:

- the primary persistent data stores (databases, ORMs, schema files, migration
  directories);
- the major entities / tables / collections and how they relate;
- non-obvious denormalisations, write paths, or invariants encoded in the code;
- file paths (with line ranges if relevant) backing each claim.

Write a Markdown document titled "# Data Model Overview" with these sections in
order: 'Stores & Schemas', 'Entities & Relationships', 'Read & Write Paths',
'Notable Invariants', 'Where to Look First (file references)'. Be specific.
Cite concrete file paths in backticks. Do not invent: if information is not
present in the source, say so. Avoid generic prose.`,
  api_surface_overview: `You are documenting the externally-visible API surface (HTTP routes, RPC
methods, GraphQL operations, public library entry points) of a software
repository. Use sandbox tools to inspect routes, controllers, handlers, and
exported modules. Identify:

- request entry points and their dispatch path;
- authentication / authorisation requirements per surface;
- shape of inputs and outputs (link to validators or type files);
- error envelopes;
- file paths backing each claim.

Write a Markdown document titled "# API Surface Overview" with sections:
'Public Endpoints', 'Authentication & Authorisation', 'Request / Response
Shapes', 'Error Handling', 'Where to Look First'. Cite concrete file paths in
backticks. Do not invent endpoints — only document what the source actually
exposes.`,
  deployment_overview: `You are documenting how this repository is deployed and operated. Use the
sandbox tools to inspect deployment configuration (Dockerfiles, CI files,
Terraform, Convex / Vercel / similar service config). Identify:

- the runtime targets (where it runs, what hosts it);
- build and release pipeline (CI workflow files, deployment scripts);
- environment variables and secrets management;
- infrastructure dependencies (databases, queues, external services);
- the file paths backing each claim.

Write a Markdown document titled "# Deployment Overview" with sections:
'Runtime Targets', 'Build & Release Pipeline', 'Environment & Secrets',
'Infrastructure Dependencies', 'Where to Look First'. Cite file paths in
backticks. If a section has no evidence in the source, say so explicitly
rather than inventing content.`,
  security_overview: `You are documenting the security posture of a software repository. Use the
sandbox tools to inspect authentication code, authorisation checks, input
validation, secrets handling, and any cryptographic operations. Identify:

- how users authenticate;
- where authorisation decisions live;
- input validation strategy;
- secrets storage and rotation;
- known sensitive surfaces (PII, tokens, payment data);
- gaps you can identify from the source (with file references).

Write a Markdown document titled "# Security Overview" with sections:
'Authentication', 'Authorisation', 'Input Validation', 'Secrets & Sensitive
Data', 'Observed Gaps & Risks'. Cite file paths in backticks. Be conservative
— only flag a gap if the evidence is in the source.`,
  operations_overview: `You are documenting how this software is operated in production. Use the
sandbox tools to inspect logging, metrics, tracing, alerting, dashboards,
health checks, and run-books referenced in the source. Identify:

- structured logging conventions;
- metrics / tracing instrumentation;
- alerts and on-call signals;
- dashboards (if referenced in code or docs);
- run-books and operational playbooks present in the repo;
- file paths backing each claim.

Write a Markdown document titled "# Operations Overview" with sections:
'Logging', 'Metrics & Tracing', 'Alerting & On-Call', 'Dashboards & Run-Books',
'Where to Look First'. Cite file paths in backticks. If the codebase does not
emit metrics or has no run-books, say so directly rather than padding.`,
};

async function generateLlm(
  kind: SystemDesignKind,
  sandbox: Doc<"sandboxes"> | null,
  repository: Doc<"repositories">,
): Promise<{ contentMarkdown: string; summary: string; source: "sandbox" }> {
  if (isHeuristicKind(kind)) {
    throw new Error(`generateLlm should not be called for heuristic kind ${kind}`);
  }
  if (!sandbox || !sandbox.remoteId || !sandbox.repoPath) {
    throw new Error("Sandbox is not provisioned. Provision a sandbox to generate this document.");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the backend.");
  }

  const client = await getSandboxFsClient(sandbox.remoteId);
  const tools = createSandboxTools(client, sandbox.repoPath);

  const modelName = resolveModelForMode("lab");
  const systemPrompt = LLM_PROMPTS[kind as keyof typeof LLM_PROMPTS];
  const userPrompt = [
    `Repository: ${repository.sourceRepoFullName ?? "(unknown)"}`,
    repository.defaultBranch ? `Default branch: ${repository.defaultBranch}` : null,
    "",
    "Begin by listing the repository root, then inspect the most relevant files",
    "before writing the document. Stay within the repo subtree.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const completion = await generateText({
    model: openai(modelName),
    system: systemPrompt,
    prompt: userPrompt,
    tools,
    stopWhen: stepCountIs(SYSTEM_DESIGN_STEP_BUDGET),
    maxRetries: 2,
  });

  const text = completion.text.trim();
  if (text.length === 0) {
    throw new Error("LLM returned an empty document.");
  }
  // `source: "sandbox"` carries the semantic load here: the artifact was
  // produced by an LLM session that read live source through the sandbox
  // tool factory. `createArtifactInMutation` translates that to
  // `producedIn: "lab"` + `lastVerifiedAt: now`, which gates the
  // "verified against current source" badge in the Library freshness UI.
  return {
    contentMarkdown: text,
    summary: extractSummary(text),
    source: "sandbox",
  };
}

function extractSummary(markdown: string): string {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.slice(0, 280);
  }
  return "Generated by Library System Design.";
}
