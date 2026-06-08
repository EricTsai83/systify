/**
 * System Design generator prompt registry.
 *
 * Lives in `lib/` (not the Node action) for three reasons:
 *
 *   1. The prompts are the highest-leverage tuning target — moving them
 *      out of the Node action puts them in a pure module the eval harness
 *      (`convex/eval/systemDesign/`) can re-import without booting the
 *      Node runtime.
 *   2. `SYSTEM_DESIGN_PROMPT_VERSIONS` is part of the artifact-cache key
 *      (`(repositoryId, kind, alignedImportCommitSha, generatedByProvider,
 *      generatedByModel, promptVersion)`). Bumping a version invalidates
 *      every cached artifact for that kind — see the
 *      `promptShape.test.ts` snapshot test which fails the suite when a
 *      prompt edit lands without a version bump.
 *   3. The validators (`validateRequiredSections`, `validateMermaidBlock`)
 *      run inside an internalAction and have to stay pure JS — no DB,
 *      no SDK. Co-locating them with the prompts that *define* the
 *      expected shape keeps the contract obvious: editing the prompt's
 *      "Write … with these sections in order" line means editing
 *      EXPECTED_SECTIONS in the same file.
 *
 * No `"use node"` directive — the module is consumed both from the
 * `convex/systemDesignNode.ts` action (Node runtime) and from tests
 * (Bun / Vitest). Convex resolves Node-vs-v8 per file, so this file
 * landing in the v8 runtime keeps the cost of the eval harness
 * importing it bounded.
 */

import { extractMermaidCodeBlocks } from "./mermaidMarkdown";
import type { SystemDesignKind } from "./systemDesign";

/**
 * Stable, human-readable prompt strings keyed by `SystemDesignKind`.
 * The prompts deliberately specify the exact section layout the
 * generator must produce — `EXPECTED_SECTIONS` derives from these
 * literal "sections in order" lists. Edit one, update the other (and
 * bump `SYSTEM_DESIGN_PROMPT_VERSIONS`); the snapshot test fails
 * otherwise.
 */
export const LLM_PROMPTS: Record<SystemDesignKind, string> = {
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
validation, secrets handling, callback / webhook handlers, rate limits,
logging of sensitive values, and any cryptographic operations. Identify:

- how users authenticate;
- where authorisation decisions live;
- input validation strategy;
- secrets storage and rotation;
- known sensitive surfaces (PII, tokens, payment data);
- trust boundaries where external identifiers, callback parameters, webhook
  payloads, model / tool inputs, or provider responses enter the system;
- abuse-prevention controls such as CSRF state, PKCE, signature checks,
  replay protection, ownership checks, rate limits, pagination caps,
  idempotency, and fail-closed behaviour;
- gaps you can identify from the source (with file references).

Write a Markdown document titled "# Security Overview" with sections:
'Authentication', 'Authorisation', 'Input Validation', 'Secrets & Sensitive
Data', 'Trust Boundaries & Abuse Controls', 'Observed Gaps & Risks'. For
'Trust Boundaries & Abuse Controls', explicitly explain how the code defends
against cross-tenant binding, forged callbacks / webhooks, replay, resource
amplification, and secret leakage when the source contains evidence. Cite
file paths in backticks. Be conservative — only flag a gap if the evidence is
in the source.`,
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

/**
 * Per-kind prompt revision. Forms part of the artifact-cache key — a
 * bump invalidates every cached artifact for that kind. Always
 * monotonically increasing; never reuse a number.
 *
 * Snapshot test (`convex/systemDesignNode.test.ts`) hashes each
 * prompt and fails when the hash changes without a matching version
 * bump, so a prompt edit cannot land silently.
 */
export const SYSTEM_DESIGN_PROMPT_VERSIONS: Record<SystemDesignKind, number> = {
  readme_summary: 1,
  architecture_overview: 1,
  architecture_diagram: 1,
  data_model_overview: 1,
  api_surface_overview: 1,
  deployment_overview: 1,
  security_overview: 2,
  operations_overview: 1,
};

/**
 * Expected H2 section names per kind, in the order the prompt asks the
 * model to emit them. Used by `validateRequiredSections` as a quality
 * gate — if the model's output is missing any of these headings the
 * run is rejected as `output_quality` and no artifact is written.
 *
 * The lists below intentionally mirror the literal "Write a Markdown
 * document titled … with these sections in order: …" lines in each
 * prompt above. Drift between the two surfaces as a failing
 * snapshot test (`promptShape.test.ts`) — keep them in sync.
 */
export const EXPECTED_SECTIONS: Record<SystemDesignKind, ReadonlyArray<string>> = {
  readme_summary: ["Purpose", "Services & Capabilities", "Audience", "Key Operations", "Notable Constraints", "Source"],
  architecture_overview: [
    "System Shape",
    "Components & Responsibilities",
    "Data & Control Flow",
    "Boundaries & Integrations",
    "Where to Look First",
  ],
  architecture_diagram: ["Legend", "Reading guide"],
  data_model_overview: [
    "Stores & Schemas",
    "Entities & Relationships",
    "Read & Write Paths",
    "Notable Invariants",
    "Where to Look First (file references)",
  ],
  api_surface_overview: [
    "Public Endpoints",
    "Authentication & Authorisation",
    "Request / Response Shapes",
    "Error Handling",
    "Where to Look First",
  ],
  deployment_overview: [
    "Runtime Targets",
    "Build & Release Pipeline",
    "Environment & Secrets",
    "Infrastructure Dependencies",
    "Where to Look First",
  ],
  security_overview: [
    "Authentication",
    "Authorisation",
    "Input Validation",
    "Secrets & Sensitive Data",
    "Trust Boundaries & Abuse Controls",
    "Observed Gaps & Risks",
  ],
  operations_overview: [
    "Logging",
    "Metrics & Tracing",
    "Alerting & On-Call",
    "Dashboards & Run-Books",
    "Where to Look First",
  ],
};

/**
 * Per-kind sandbox tool-call budget. The generator enforces this as
 * `stopWhen: stepCountIs(stepBudget)` and appends a "you have N tool
 * calls" line to the system prompt. Ships uniform at 20 until the
 * eval harness produces enough per-kind data to differentiate —
 * `eval/README.md` documents the tuning loop.
 *
 * Independent of model: a `gpt-5` and a `claude-opus-4-8` run on the
 * same kind get the same budget. Step economics (depth vs breadth)
 * are a kind-level property, not a model-level one — bumping a model
 * tier should buy quality, not more tools.
 */
export const STEP_BUDGET_BY_KIND: Record<SystemDesignKind, number> = {
  readme_summary: 20,
  architecture_overview: 20,
  architecture_diagram: 20,
  data_model_overview: 20,
  api_surface_overview: 20,
  deployment_overview: 20,
  security_overview: 20,
  operations_overview: 20,
};

/**
 * Per-kind run config bundle. The generator pulls this once at the
 * start of each kind iteration so the four pieces of state stay
 * locked to a single source of truth — a stale read against a
 * partial update can't produce a mixed config.
 */
export function getKindRunConfig(kind: SystemDesignKind): {
  prompt: string;
  promptVersion: number;
  expectedSections: ReadonlyArray<string>;
  stepBudget: number;
} {
  return {
    prompt: LLM_PROMPTS[kind],
    promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS[kind],
    expectedSections: EXPECTED_SECTIONS[kind],
    stepBudget: STEP_BUDGET_BY_KIND[kind],
  };
}

/**
 * Append the "you have N tool calls" budget reminder to a kind's
 * system prompt. Keeping this here (rather than re-pasting per
 * prompt) means the budget number lives once at the call site and
 * matches whatever `STEP_BUDGET_BY_KIND` returns for the kind.
 */
export function budgetSuffix(stepBudget: number): string {
  return (
    `\n\nYou have a hard limit of ${stepBudget} sandbox tool calls. After at most ~6 tool calls, ` +
    "start writing the document — partial coverage with citations is better than " +
    "exhausting the budget on reads and producing nothing."
  );
}

/**
 * Pure validator: returns the set of `expected` section names that
 * are NOT present as H2/H3 headings in `markdown`. Comparison is
 * normalised (lower-case alphanumeric only) so the validator survives
 * cosmetic drift — "Authentication & Authorisation" matches "##
 * Authentication and Authorisation" only if both normalise to the
 * same key, which they intentionally don't (the prompt's exact
 * spelling is what we want); but trailing punctuation, italics, etc.
 * are tolerated.
 *
 * `ok: true` only when every expected section appears. The caller
 * folds the result into a kind-run status of `quality_rejected` plus
 * a `missingSections` array of the gaps.
 */
export function validateRequiredSections(
  markdown: string,
  expected: ReadonlyArray<string>,
): { ok: boolean; missingSections: string[] } {
  const headings: { key: string; index: number }[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ") || line.startsWith("### ")) {
      headings.push({
        key: normalizeHeading(line.replace(/^#+\s+/, "")),
        index: headings.length,
      });
    }
  }

  const missingSections: string[] = [];
  let lastIndex = -1;
  for (const section of expected) {
    const normalized = normalizeHeading(section);
    const heading = headings.find((h) => h.key === normalized);
    if (!heading) {
      missingSections.push(section);
    } else if (heading.index <= lastIndex) {
      missingSections.push(section);
    } else {
      lastIndex = heading.index;
    }
  }
  return { ok: missingSections.length === 0, missingSections };
}

/**
 * Pure validator for the `architecture_diagram` kind — checks that
 * the markdown contains at least one closed fenced \`\`\`mermaid block.
 *
 * Mermaid syntax itself is validated by the renderer. This server-side
 * gate stays intentionally structural so it does not couple background
 * generation to browser-oriented Mermaid rendering internals.
 */
export function validateMermaidBlock(markdown: string): boolean {
  return extractMermaidCodeBlocks(markdown).length > 0;
}

function normalizeHeading(text: string): string {
  // Collapse all non-alphanumeric runs to single empty string so
  // section comparison ignores punctuation, casing, and whitespace
  // variations introduced by the model's formatter.
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
