"use node";

import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { createSandboxTools } from "./chat/sandboxTools";
import { resolveModelForReply } from "./chat/modelSelection";
import { getSandboxFsClient } from "./daytona";
import { ensureSandboxReady, SandboxPreparationError, type SandboxPreparationStage } from "./lib/sandboxLiveness";
import { logErrorWithId, logInfo, logWarn } from "./lib/observability";
import {
  SYSTEM_DESIGN_KIND_TITLES,
  isSystemDesignKind,
  systemDesignKindValidator,
  type SystemDesignKind,
} from "./lib/systemDesign";

const SYSTEM_DESIGN_STEP_BUDGET = 20;

/**
 * Library System Design generator.
 *
 * Every kind is LLM-backed: the action prepares a Daytona sandbox once via
 * `ensureSandboxReady`, then runs one `generateText` call per selected kind
 * against the sandbox-backed model with the same `read_file` / `list_dir` /
 * `run_shell` tool factory the chat-sandbox path uses. Kinds run serially to
 * honour the per-sandbox tool budget and the OpenAI rate limit; the job lease
 * is refreshed before each one so a long publication (e.g. all seven kinds
 * with high step budgets) does not trip the stale-recovery sweep while the
 * action is still making progress.
 *
 * Per-kind failures are isolated: the catch logs an errorId, records a
 * structured `kindFailures` entry, and the next kind continues. Progress
 * flows back through `updateGenerationProgress` after every kind completes
 * (success or fail). If sandbox preparation fails up front the whole run is
 * failed with the structured `userFacingMessage` and no kinds run.
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

    const selections = args.selections.filter(isSystemDesignKind);
    const totalCount = selections.length;

    if (totalCount === 0) {
      await ctx.runMutation(internal.systemDesign.failGeneration, {
        jobId: args.jobId,
        errorMessage: "No valid system design kinds selected.",
      });
      return;
    }

    // Every kind reads live source through the sandbox, so the run always
    // needs a ready sandbox. `ensureSandboxReady` probes / wakes / provisions
    // / clones as needed and reports each stage as job progress. On failure
    // the whole run is failed with the structured `userFacingMessage` — no
    // kinds run, because the user requested them together.
    let liveSandbox: Doc<"sandboxes"> | null = context.activeSandbox;
    const stageLabel: Record<SandboxPreparationStage, string> = {
      probing: "Preparing environment for your request…",
      waking: "Waking up the repository sandbox…",
      provisioning: "Setting up the repository sandbox…",
      cloning: "Cloning repository…",
      polling: "Preparing environment for your request…",
    };
    try {
      const prepared = await ensureSandboxReady(
        ctx,
        {
          repositoryId: args.repositoryId,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
        },
        async (stage) => {
          await ctx.runMutation(internal.systemDesign.updateGenerationProgress, {
            jobId: args.jobId,
            completedCount: 0,
            totalCount,
            stage: stageLabel[stage] ?? "Preparing environment for your request…",
          });
        },
      );
      // Re-fetch the sandbox row so the LLM pass sees the post-clone state
      // (`remoteId`, `repoPath`, status=ready) without re-reading per kind.
      liveSandbox = await ctx.runQuery(internal.ops.getSandboxRow, { sandboxId: prepared.sandboxId });
    } catch (error) {
      if (error instanceof SandboxPreparationError) {
        await ctx.runMutation(internal.systemDesign.failGeneration, {
          jobId: args.jobId,
          errorMessage: error.userFacingMessage,
        });
        logInfo("systemDesign", "generation_failed_sandbox_prep", {
          jobId: args.jobId,
          repositoryId: args.repositoryId,
          reason: error.reason,
        });
        return;
      }
      throw error;
    }

    let completedCount = 0;
    let succeeded = 0;
    let failed = 0;

    // Kinds run serially: each one is a sandbox-backed LLM session, so running
    // them in parallel would contend on the per-sandbox tool budget and the
    // OpenAI rate limit.
    for (const kind of selections) {
      // Refresh the running job's lease before each kind so a long multi-kind
      // publication does not overrun the lease window and trigger a spurious
      // stale-recovery while progress is still happening.
      await ctx.runMutation(internal.systemDesign.refreshGenerationLease, { jobId: args.jobId });

      try {
        const result = await generateLlm(kind, liveSandbox, context.repository);
        await ctx.runMutation(internal.systemDesign.persistGeneratedArtifact, {
          repositoryId: args.repositoryId,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          jobId: args.jobId,
          kind,
          title: SYSTEM_DESIGN_KIND_TITLES[kind],
          summary: result.summary,
          contentMarkdown: result.contentMarkdown,
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
        const rawMessage = error instanceof Error ? error.message : String(error);
        const reason: "live_source_unavailable" | "model_empty_output" | "other" =
          error instanceof SandboxPreparationError
            ? "live_source_unavailable"
            : /empty document/i.test(rawMessage)
              ? "model_empty_output"
              : "other";
        await ctx.runMutation(internal.systemDesign.recordKindFailure, {
          jobId: args.jobId,
          kind,
          errorId,
          message: rawMessage,
          reason,
        });
      }

      completedCount += 1;
      await ctx.runMutation(internal.systemDesign.updateGenerationProgress, {
        jobId: args.jobId,
        completedCount,
        totalCount,
        stage: `Generated ${completedCount} of ${totalCount}: ${SYSTEM_DESIGN_KIND_TITLES[kind]}`,
      });
    }

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

const LLM_PROMPTS: Record<SystemDesignKind, string> = {
  readme_summary: `You are summarising a software repository for an engineer who needs to
understand the system at a design level. Use the sandbox tools (read_file,
list_dir, run_shell) to locate and read the README (usually README.md /
README.rst / README.txt at the repo root). If the README points to other
docs (CONTRIBUTING, ARCHITECTURE, docs/), you may follow them for context,
but ground the summary in what the project's own documentation states.
Identify:

- what the system is and the problem it exists to solve;
- the services and capabilities it provides;
- who its intended users / audience are;
- the key operations and workflows those users perform;
- notable constraints: licence, maturity (early-access / beta / archived),
  and external services or accounts the user must provision to run it.

Write a Markdown document titled "# README Summary" with these sections in
order: 'Purpose', 'Services & Capabilities', 'Audience', 'Key Operations',
'Notable Constraints', 'Source'. Under 'Source', cite the README (and any
other doc you used) by file path in backticks. Stay faithful to what the
documentation actually says — do not invent services, users, or operations.
If the README is missing, empty, or boilerplate-only, say so explicitly in
'Purpose' and write "Not documented." in the other sections rather than
padding.`,
  architecture_overview: `You are documenting the architecture of a software repository for a new
engineer joining the team. Use the sandbox tools (read_file, list_dir,
run_shell) to inspect the repository's structure and identify:

- the overall shape of the system — its major components / modules /
  services and how the codebase is organised;
- what each major component is responsible for;
- how a typical request or operation flows through the system;
- the key boundaries and integrations — process boundaries, external
  services, and how layers communicate;
- the highest-signal files to read first.

Write a Markdown document titled "# Architecture Overview" with these
sections in order: 'System Shape', 'Components & Responsibilities', 'Data &
Control Flow', 'Boundaries & Integrations', 'Where to Look First'. Cite
concrete file paths in backticks. Be specific to this repository — do not
invent components or describe a generic architecture. If the evidence for a
section is thin, say what you could determine and what you could not rather
than padding.`,
  architecture_diagram: `You are drawing an architecture diagram of a software repository as a
Mermaid graph for an engineer who needs to understand the system at a
design level. Use the sandbox tools (read_file, list_dir, run_shell) to
inspect the repository — directory layout, entry points, routing /
controller / handler files, ORM / schema files, build & deploy config —
and identify:

- the major components / modules / services that make up the system;
- how data and control flow between them (request paths, event paths,
  background workers, queues);
- external boundaries (third-party APIs, databases, queues, blob stores);
- which components belong together logically (group them into subgraphs).

Write a Markdown document titled "# Architecture Diagram" with these
parts in order:

1. A short (2–3 sentence) introduction stating what the diagram covers
   and what it deliberately omits.
2. A fenced \`\`\`mermaid code block containing a single \`graph TD\` or
   \`graph LR\` diagram. The block must be valid Mermaid that parses on
   its own.
3. A 'Legend' section that briefly explains any subgraph groupings,
   node styling, or non-obvious edge labels you used.
4. A 'Reading guide' section that lists 3–8 highest-signal files (in
   backticks) and notes which diagram node each one backs.

Constraints on the Mermaid block:

- Use unique alphanumeric node ids (e.g. \`api\`, \`worker_1\`) and put
  the human label in quotes: \`api["API server"]\`.
- Keep labels short (≤ 5 words). Move detail to the Legend or Reading
  guide, not into the node.
- Aim for 10–25 nodes. Under-detail beats hallucinated detail.
- Group related components with \`subgraph\` blocks where it aids clarity.
- Use solid arrows (\`-->\`) for in-process calls and dotted arrows
  (\`-.->\`) for boundaries crossing into external services. Label edges
  only when the flow is non-obvious.
- Do not invent components, services, or integrations. Every node must
  correspond to evidence you read in the source.

If the evidence for a section is thin, say what you could determine and
what you could not — do not pad the diagram with placeholder boxes.`,
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
): Promise<{ contentMarkdown: string; summary: string }> {
  if (!sandbox || !sandbox.remoteId || !sandbox.repoPath) {
    throw new Error("Sandbox is not provisioned. Provision a sandbox to generate this document.");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the backend.");
  }

  const client = await getSandboxFsClient(sandbox.remoteId);
  const tools = createSandboxTools(client, sandbox.repoPath);

  const modelName = resolveModelForReply({ mode: "discuss", groundSandbox: true });
  // Appended once for every LLM kind so the per-kind prompts don't have to
  // each restate the budget — keeps the limit in sync with
  // `SYSTEM_DESIGN_STEP_BUDGET` and avoids drift.
  const systemPrompt =
    LLM_PROMPTS[kind] +
    `\n\nYou have a hard limit of ${SYSTEM_DESIGN_STEP_BUDGET} sandbox tool calls. After at most ~6 tool calls, ` +
    "start writing the document — partial coverage with citations is better than " +
    "exhausting the budget on reads and producing nothing.";
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
  return {
    contentMarkdown: text,
    summary: extractSummary(text),
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
