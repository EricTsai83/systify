"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { runRepositoryImportPipeline } from "./lib/importPipeline";

/**
 * Repository import pipeline — GitHub-API-only.
 *
 * Tier 1 of the lazy-sandbox architecture: import never provisions a Daytona
 * sandbox. The pipeline fetches metadata, the recursive tree, README, and
 * package manifest contents directly from the GitHub API using the user's
 * GitHub App installation token. Sandbox-backed features (Sandbox Mode chat,
 * Design Docs generation) own their own sandbox lifecycle through
 * `ensureSandboxReady` and run on demand.
 *
 * Failure modes:
 *   - Missing / expired installation → fail-fast with a user-facing message
 *     pointing at GitHub Settings.
 *   - Repository not included in the App's repo selection → caught by the
 *     early `checkRepoAccess` probe and surfaced verbatim.
 *   - GitHub API outage / rate-limit storm → `fetchRepositorySnapshot`
 *     retries 5xx + 429 internally; persistent failure surfaces the wrapped
 *     GitHub error with a Reference ID.
 *
 * No sandbox cleanup is needed in the error path because no sandbox was
 * created.
 */
export const runImportPipeline = internalAction({
  args: {
    importId: v.id("imports"),
  },
  handler: runRepositoryImportPipeline,
});
