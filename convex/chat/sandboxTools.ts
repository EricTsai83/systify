/**
 * Sandbox tool factory.
 *
 * Three tools the LLM can call during a sandbox-mode chat reply:
 *
 *   - `read_file`: UTF-8 file contents for files up to 64 KiB.
 *   - `list_dir`: directory entries capped at 200 names.
 *   - `run_shell`: arbitrary shell command, output capped at 32 KiB,
 *     gated by a deny list of obviously-destructive patterns, bounded
 *     by a per-call timeout, working directory pinned inside the repo
 *     subtree.
 *
 * Design boundaries the rest of the chat pipeline depends on:
 *
 *   1. **Pure factory.** `createSandboxTools(client, repoPath)` is a pure
 *      function over a small `SandboxFsClient` interface. Tests pass a fake
 *      client and exercise every error branch without mocking
 *      `@daytona/sdk`; the production wiring (in `daytona.ts`) adapts the
 *      Daytona SDK to this interface in one place. This keeps the runtime
 *      coupling shallow — the factory itself runs in any JS runtime.
 *
 *   2. **Errors are values, not throws.** Every tool's `execute` returns
 *      either an `ok: true` payload or an `ok: false` error envelope. Returning
 *      the error means the LLM sees the message verbatim and can adapt
 *      ("retry with a different path", "tell the user they asked for `.env`,
 *      which is restricted"). Throwing would either pop the AI SDK retry loop
 *      out of the step budget or crash the whole reply — both are worse
 *      outcomes than a structured "I couldn't do that and here's why".
 *
 *   3. **Path validation is POSIX-only.** Daytona sandboxes are always Linux,
 *      so we compute path safety in plain `/`-separated segments without the
 *      Node `path` module — the file stays runtime-agnostic and the rules
 *      ("no absolute paths, no `..` escape, no NULs") are auditable here.
 *      The check is on the *normalized* relative path, so tricks like
 *      `foo/../../etc/passwd` collapse to `../etc/passwd` and reject as
 *      `path_outside_repo`. `run_shell`'s `workdir` argument flows through
 *      the same validator so the tool can never `cd` out of the repo subtree.
 *
 *   4. **Truncation is byte-level.** `downloadFile` returns the entire file
 *      as a `Uint8Array`. Production probes file size first and rejects
 *      files above `SANDBOX_READ_FILE_MAX_BYTES` before download so a
 *      multi-MB file doesn't materialise in memory. The decoder runs with
 *      `fatal: false` for bounded fake clients and fallback adapters.
 *      `run_shell` truncates at the character level instead — Daytona returns
 *      the merged stdout/stderr as an already-decoded `string`, so the byte
 *      cost has already been paid; truncating earlier would force a re-encode
 *      round-trip with no benefit.
 *
 *   5. **Result shape carries trace-friendly metadata.** Each success
 *      envelope carries `truncated`, `bytesReturned`, and (where useful)
 *      `totalBytes` / `totalEntries` / `durationMs` / `exitCode` so the
 *      tool-call ticker can summarise a call as `Reading
 *      convex/chat/send.ts (12.4 KB, truncated)` or `Ran grep (exit 0,
 *      842 ms)` without re-running the tool.
 *
 *   6. **Every return path runs through `redact()`.** Tool output flows
 *      two places: into the LLM's next-step input *and* into durable
 *      storage (`messages.toolCalls`, `sandboxToolCallLog`). A
 *      `.git/config` token or hard-coded API key that escapes here lands
 *      in the `messages` table and survives sandbox deletion. So
 *      `read_file` content, `list_dir` entry names, *and* `run_shell`
 *      combined output are all scrubbed before the success envelope is
 *      built; matched pattern types bubble up via `redactedTypes` so the
 *      LLM (and any downstream audit reader) knows that something was
 *      filtered without learning what. See
 *      `docs/sandbox-mode-security-system-design.md` for the threat model.
 *
 *   7. **`run_shell` deny list is last-mile, not the boundary.**
 *      The primary defense against destructive operations is Daytona's
 *      sandbox isolation (process limits, network policy, and the fact that
 *      the sandbox is throwaway). The deny list is a defense-in-depth filter
 *      for *obvious* RCE / fork-bomb / mkfs-class commands — it is regex-
 *      based by design (no shell parsing) and accepts that a determined
 *      adversary inside the LLM could rephrase past it. The system prompt
 *      reinforces "read-only inspection only" so the LLM does not even try.
 *      See `docs/sandbox-mode-system-design.md` for what Daytona enforces
 *      around it.
 */

import { tool } from "ai";
import { z } from "zod";
import { redact, type RedactionType } from "./redaction";

/* ---------------------------------------------------------------------- *
 * Public limits (constants live here so tests pin the boundary, not the *
 * symptom — a value tweak below propagates into all the tests below.)   *
 * ---------------------------------------------------------------------- */

/**
 * Hard byte cap for `read_file` output. 64 KiB comfortably fits any
 * human-authored source file in this repo (largest TS files in `convex/` are
 * ~30 KiB) while stopping the LLM from quietly burning context on a
 * package-lock.json or a 1 MB CSV. The cap is enforced on the **byte**
 * length of the file as Daytona returns it, so a 600 KiB UTF-8 file is
 * sliced to its first 65,536 bytes and only then decoded.
 */
export const SANDBOX_READ_FILE_MAX_BYTES = 64 * 1024;

/**
 * Maximum entries returned from `list_dir`. 200 is well above typical
 * source-tree directory sizes (`convex/` itself currently has ~70 entries)
 * and an order of magnitude above what an LLM productively reasons about in
 * a single tool call. Larger directories are surfaced as `truncated: true`
 * with the total count so the model can ask the user to narrow the path.
 */
export const SANDBOX_LIST_DIR_MAX_ENTRIES = 200;

/**
 * Per-call download timeout in seconds. Daytona's default is 30 minutes;
 * for an interactive chat reply that's a hostage situation. 15 s is long
 * enough for any reasonable single-file fetch over a healthy connection
 * and short enough that a stalled call doesn't blow the chat-job lease
 * (`CHAT_JOB_LEASE_MS`).
 */
export const SANDBOX_READ_FILE_TIMEOUT_SECONDS = 15;

/**
 * Marker appended to truncated read_file outputs. The LLM sees this in the
 * tool result and can either ask the user for a narrower section or report
 * "I only saw the first 64 KB of this file" — both better than silent
 * truncation that leads to "I checked the file and didn't find X" when X is
 * past byte 65,536.
 */
export const SANDBOX_TRUNCATION_MARKER = "\n\n[…truncated by Systify after 64 KB…]";

/* ---------------------------------------------------------------------- *
 * `run_shell` limits.                                                     *
 * ---------------------------------------------------------------------- */

/**
 * Default per-call timeout for `run_shell`. Picked low enough that an
 * accidentally-runaway command (`grep -r '' /` against a multi-GB tree) is
 * killed before it eats the chat-job lease window, and high enough to fit a
 * realistic `git log --stat` or `find . -name '*.ts' | xargs wc -l` over
 * a typical repo. The model can request shorter or longer per-call (capped
 * at {@link SANDBOX_RUN_SHELL_MAX_TIMEOUT_SECONDS}).
 */
export const SANDBOX_RUN_SHELL_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Hard ceiling on the per-call timeout. The chat-job lease (`CHAT_JOB_LEASE_MS`)
 * is the budget the entire reply has before it gets recovered as stale; a
 * single tool call must stay well below that so other work (model deltas,
 * subsequent tool calls, finalize) can still complete. 60 s is the largest
 * safe value given the model can call multiple tools in one reply.
 */
export const SANDBOX_RUN_SHELL_MAX_TIMEOUT_SECONDS = 60;

/**
 * Output cap for `run_shell`. Daytona's `executeCommand` returns merged
 * stdout/stderr in a single `result` string (the SDK does *not* split the
 * two streams), so the cap is enforced on the combined buffer. 32 KiB
 * gives the LLM enough room to reason over a reasonable `grep` / `git log`
 * result without pushing the message document past Convex's 1 MB row
 * limit.
 */
export const SANDBOX_RUN_SHELL_MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * Marker appended to truncated run_shell outputs. Mirrors the read_file
 * marker so the LLM (and the tool-call ticker) can pattern-match the
 * `[…truncated by Systify after N KB…]` shape uniformly across tools.
 */
export const SANDBOX_RUN_SHELL_TRUNCATION_MARKER = "\n\n[…truncated by Systify after 32 KB…]";

/* ---------------------------------------------------------------------- *
 * Sandbox FS adapter interface — kept intentionally minimal so the       *
 * production adapter (daytona.ts) and the test fake stay in lockstep.   *
 * ---------------------------------------------------------------------- */

export interface SandboxListedFile {
  readonly name: string;
  readonly isDir: boolean;
  readonly size: number;
}

export interface SandboxFileInfo {
  readonly isDir: boolean;
  readonly size: number;
}

export interface SandboxLimitedListResult {
  readonly entries: readonly SandboxListedFile[];
  readonly totalEntries: number;
  readonly truncated: boolean;
}

/**
 * Options bag for `executeCommand`. The shape is option-bag (rather than
 * positional like `downloadFile(path, timeoutSeconds)`) because Daytona's
 * underlying call has four orthogonal arguments (`command, cwd, env,
 * timeout`) and a positional bridge would be ambiguous to read at call
 * sites. `timeoutSeconds` is required at the type level — the tool layer
 * always picks a value (default or model-supplied), so an "implicit
 * Daytona default" mode would be a footgun.
 */
export interface SandboxShellExecuteOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes?: number;
}

/**
 * Outcome of `executeCommand`.
 *
 * Daytona surfaces *timeouts* as a typed exception (`DaytonaTimeoutError`).
 * The adapter (`getSandboxFsClient` in `daytona.ts`) translates that into a
 * `kind: "timeout"` outcome so the tool layer can map it to a structured
 * error envelope without importing Daytona symbols. Other Daytona errors
 * (auth, 404, network) keep throwing — they are infrastructural failures
 * the tool's generic `catch` already rolls up into the `io_error` envelope.
 *
 * Non-zero exit codes are *not* errors at this layer: a `grep` that finds
 * nothing legitimately exits 1, and the LLM benefits from seeing the code.
 * The contract is "the command ran to completion; here is its exit status
 * and combined output."
 */
export type SandboxShellOutcome =
  | {
      readonly kind: "ok";
      readonly exitCode: number;
      readonly output: string;
      readonly bytesReturned?: number;
      readonly totalBytes?: number;
      readonly truncated?: boolean;
    }
  | { readonly kind: "timeout"; readonly message: string };

/**
 * Minimal projection of Daytona's `Sandbox` surface area used by the tool
 * factory. Only the methods the tools actually need are part of the
 * contract; broader access stays off the menu so adding a tool is a
 * deliberate API change here, not an accidental capability widening.
 *
 * The interface name retains the `Fs` suffix even though `executeCommand`
 * is a shell call rather than a filesystem operation — the shell access
 * shares the same Daytona handle and lifecycle, so renaming would touch
 * a wider blast radius (`getSandboxFsClient` in `daytona.ts`, all
 * generation call sites) with no semantic gain.
 */
export interface SandboxFsClient {
  /** Optional metadata probe used to reject oversized reads before download. */
  readonly getFileInfo?: (path: string) => Promise<SandboxFileInfo>;
  /** Returns the entire file as raw bytes. Caller is responsible for size guards. */
  readonly downloadFile: (path: string, timeoutSeconds?: number) => Promise<Uint8Array>;
  readonly listFiles: (path: string) => Promise<readonly SandboxListedFile[]>;
  /**
   * Optional bounded directory listing. Production uses this to avoid
   * asking Daytona to serialize huge directory listings; tests and fallback
   * adapters can omit it and retain the legacy `listFiles` behavior.
   */
  readonly listFilesLimited?: (path: string, maxEntries: number) => Promise<SandboxLimitedListResult>;
  /**
   * Execute a shell command inside the sandbox.
   *
   * The contract is intentionally narrower than Daytona's raw
   * `executeCommand(command, cwd?, env?, timeout?)`:
   *   - `cwd` must be a path the caller has already validated as
   *     repo-rooted (the tool layer does this through `resolveSandboxPath`).
   *   - `timeoutSeconds` is required (no implicit upstream default).
   *   - Timeouts surface as `kind: "timeout"`, not as thrown exceptions,
   *     so the runtime-agnostic tool layer can keep its "errors are values"
   *     contract without importing `@daytona/sdk`.
   */
  readonly executeCommand: (command: string, options: SandboxShellExecuteOptions) => Promise<SandboxShellOutcome>;
}

/* ---------------------------------------------------------------------- *
 * Result shapes (also exported so callers persisting tool traces import  *
 * the same types).                                                       *
 * ---------------------------------------------------------------------- */

/**
 * Structured error codes the tool factory emits. The deny list emits
 * `command_blocked`; an exceeded server-side timeout maps to
 * `command_timeout`; an empty / whitespace-only command emits
 * `invalid_command`. `io_error` catches any other infrastructural Daytona
 * failure (auth, 404, network) so the model sees a single, predictable
 * envelope shape across the entire surface.
 */
export type SandboxToolErrorCode =
  | "invalid_path"
  | "path_outside_repo"
  | "file_too_large_to_decode"
  | "io_error"
  | "invalid_command"
  | "command_blocked"
  | "command_timeout";

export type SandboxToolErrorEnvelope = {
  readonly ok: false;
  readonly errorCode: SandboxToolErrorCode;
  readonly message: string;
};

export type ReadFileToolResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly bytesReturned: number;
      readonly totalBytes: number;
      readonly truncated: boolean;
      readonly content: string;
      /**
       * Sorted, de-duplicated redaction slugs that fired against the
       * decoded content. Empty when nothing was scrubbed.
       * `sandboxToolCallLog.redactedFields` lifts this field directly,
       * so the typed union (rather than `string[]`) ensures audit
       * consumers stay in sync with the registry.
       */
      readonly redactedTypes: readonly RedactionType[];
    }
  | SandboxToolErrorEnvelope;

export type ListDirToolEntry = {
  readonly name: string;
  readonly type: "file" | "dir";
  readonly sizeBytes: number;
};

export type ListDirToolResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly entries: readonly ListDirToolEntry[];
      readonly totalEntries: number;
      readonly truncated: boolean;
      /**
       * Like `ReadFileToolResult.redactedTypes` but aggregated across
       * every entry name. Forecloses an obscure leak path where an
       * attacker plants a file whose *name* is the secret and the LLM
       * exfiltrates it through a directory listing alone.
       */
      readonly redactedTypes: readonly RedactionType[];
    }
  | SandboxToolErrorEnvelope;

/**
 * `run_shell` result envelope.
 *
 * Success path carries:
 *   - `command` / `workdir`: echo of the *resolved* values so the LLM
 *     reasons over what actually ran (defaulted-or-supplied, normalized).
 *   - `exitCode`: even non-zero exits are surfaced as `ok: true` — a
 *     `grep` that finds nothing legitimately exits 1 and the LLM benefits
 *     from seeing the code rather than getting a generic "io_error".
 *   - `output`: combined stdout/stderr (Daytona does not split the two),
 *     post-redaction, post-truncation. The byte counts (`bytesReturned`,
 *     `totalBytes`) refer to the *pre-redaction* bytes — they are size
 *     signals for the "Ran grep (32.0 KB)" ticker, not lengths of the
 *     redacted display string.
 *   - `durationMs`: wall-clock time from the moment the tool layer dispatched
 *     to the adapter to the moment it returned. Useful for the live ticker
 *     and for per-command latency metrics.
 *   - `redactedTypes`: same closed-set slug array as the other tools.
 */
export type RunShellToolResult =
  | {
      readonly ok: true;
      readonly command: string;
      readonly workdir: string;
      readonly exitCode: number;
      readonly output: string;
      readonly bytesReturned: number;
      readonly totalBytes: number;
      readonly truncated: boolean;
      readonly durationMs: number;
      readonly timeoutSeconds: number;
      readonly redactedTypes: readonly RedactionType[];
    }
  | SandboxToolErrorEnvelope;

/* ---------------------------------------------------------------------- *
 * Internals — POSIX path normalization + relative resolution.           *
 * ---------------------------------------------------------------------- */

/**
 * Normalize a POSIX-style relative path the way `path.posix.normalize`
 * would, but keep it self-contained so the file remains runtime-agnostic
 * (Convex V8 ships without `node:path`). Operates on segments to make the
 * `..` collapse logic auditable in one place.
 *
 * Returns `null` when the path tries to escape the root (e.g. `../foo`).
 * The empty string and `.` both normalize to the empty string ("repo
 * root"), which is what `list_dir("")` should mean.
 */
function normalizePosixRelative(input: string): string | null {
  // Trim a single leading `./` for ergonomics — the LLM might emit either
  // `convex/x.ts` or `./convex/x.ts`, both should be accepted.
  let working = input;
  while (working.startsWith("./")) {
    working = working.slice(2);
  }
  if (working === "." || working === "") {
    return "";
  }

  const segments = working.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      // Collapse repeated `/` and `.` segments. We *do* allow these inside
      // the input (forgiving) — empty trailing segments from a trailing
      // slash are dropped here so `convex/` and `convex` produce the same
      // canonical form.
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        // Escape attempt: caller asked for a path above the repo root.
        return null;
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Resolve a user-supplied path to its absolute location inside the
 * sandbox's repo subtree, or reject with a structured error.
 *
 * The contract:
 *   - Empty, ".", or trailing-slash inputs collapse to the repo root.
 *   - Absolute paths are *rejected* (LLM has no business addressing
 *     `/etc/...` even though Daytona's API would happily try). Allowing an
 *     absolute path that happens to start with `repoPath` would let
 *     prompt-injection attacks pivot to system locations by guessing
 *     `repoPath` — easier to forbid the input shape entirely.
 *   - NUL bytes are rejected outright (defense-in-depth against C-string
 *     truncation in any downstream tooling that round-trips the path).
 */
function resolveSandboxPath(
  userPath: string,
  repoPath: string,
):
  | { ok: true; absolutePath: string; normalizedRelative: string }
  | { ok: false; errorCode: SandboxToolErrorCode; message: string } {
  if (typeof userPath !== "string") {
    return { ok: false, errorCode: "invalid_path", message: "Path must be a string." };
  }
  if (userPath.includes("\0")) {
    return { ok: false, errorCode: "invalid_path", message: "Path contains a NUL byte." };
  }
  if (userPath.startsWith("/")) {
    return {
      ok: false,
      errorCode: "invalid_path",
      message: "Path must be relative to the repository root, not absolute.",
    };
  }

  const normalized = normalizePosixRelative(userPath);
  if (normalized === null) {
    return {
      ok: false,
      errorCode: "path_outside_repo",
      message: `Path escapes the repository root: ${userPath}`,
    };
  }

  const absolutePath = normalized.length === 0 ? repoPath : `${repoPath}/${normalized}`;
  return { ok: true, absolutePath, normalizedRelative: normalized };
}

/**
 * Module-scoped UTF-8 decoder. `TextDecoder.decode()` is stateless when
 * called without `{ stream: true }`, so a single instance is safe across
 * concurrent reads — and we save one allocation per `read_file` call.
 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Slice raw bytes to `SANDBOX_READ_FILE_MAX_BYTES` and UTF-8-decode with
 * substitution. Returns `{ content, bytesReturned, truncated }` so callers
 * can build the surrounding metadata.
 *
 * Decoding is deliberately tolerant: a truncated tail that lands inside a
 * multi-byte sequence becomes a single replacement character rather than a
 * thrown error.
 */
function decodeFileBytes(bytes: Uint8Array): { content: string; bytesReturned: number; truncated: boolean } {
  const truncated = bytes.byteLength > SANDBOX_READ_FILE_MAX_BYTES;
  const sliced = truncated ? bytes.subarray(0, SANDBOX_READ_FILE_MAX_BYTES) : bytes;
  const decoded = UTF8_DECODER.decode(sliced);
  return {
    content: truncated ? `${decoded}${SANDBOX_TRUNCATION_MARKER}` : decoded,
    bytesReturned: sliced.byteLength,
    truncated,
  };
}

function explainIoError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown sandbox I/O error.";
}

/* ---------------------------------------------------------------------- *
 * `run_shell` deny list.                                                  *
 * ---------------------------------------------------------------------- */

/**
 * Deny-list entries are deliberately *narrow* regex patterns over the raw
 * command string. The design boundary is "block obvious destructive
 * patterns; rely on Daytona for the real isolation":
 *
 *   - Daytona's container is the primary enforcement layer (process limits,
 *     network policy, throwaway sandbox lifecycle). The deny list cannot —
 *     and is not asked to — be a complete sandbox.
 *   - Regex matching is intentionally *not* shell-aware: a determined LLM
 *     could obfuscate past it (`r''m -rf /`). That is acceptable because
 *     the worst case is "the model burns a step on a Daytona-blocked
 *     operation"; it cannot achieve the destruction the regex is named for.
 *   - Each entry pairs a `pattern` with a `reason`. The reason flows back
 *     to the LLM through the `command_blocked` envelope so the model can
 *     adapt (rephrase as a non-destructive read) instead of looping.
 *
 * The set covers, in priority order:
 *
 *   1. Catastrophic recursive deletion targeting `/`, `~`, `$HOME`.
 *   2. Classic fork bombs.
 *   3. Filesystem creation (`mkfs`, `mkswap`).
 *   4. `dd` with input/output spec — the textbook disk-imaging command.
 *   5. System lifecycle: `shutdown`, `reboot`, `halt`, `poweroff`.
 *   6. Direct block-device redirects (`> /dev/sda`).
 *   7. Privilege escalation (`sudo`, `su -`).
 *   8. Network download piped into a shell (`curl … | sh`) — the textbook
 *      RCE pattern. Blocking this is independent of any Daytona network
 *      policy because the LLM should not be downloading arbitrary code
 *      regardless of egress rules.
 *   9. Recursive permission/ownership changes on `/` (`chmod -R … /`,
 *      `chown -R … /`).
 *
 * Each pattern is exported via {@link COMMAND_DENY_LIST} for tests and
 * future audit consumers; runtime evaluation walks the list once per call.
 */
type CommandDenyEntry = { readonly pattern: RegExp; readonly reason: string };

export const COMMAND_DENY_LIST: ReadonlyArray<CommandDenyEntry> = [
  // 1. Catastrophic recursive deletion. Must satisfy *both* lookaheads on
  //    the same command segment: an `-rf`/`-fr`/`--recursive`/`--force`
  //    flag *and* a path argument that is the filesystem root or home.
  //    `\b` anchors `rm` so we don't trip on substrings like `firmrm`.
  //    Lookaheads (`(?=...)`) inspect the string without consuming, so the
  //    flag and the path can appear in any order. Both lookaheads exclude
  //    shell separators (`&|;<>\n`) so they cannot reach across multiple
  //    commands and produce a false positive on a benign `rm foo.txt &&
  //    echo /` chain.
  //
  //    Path forms accepted by lookahead 2 (each followed by whitespace,
  //    end-of-string, or shell separator so we don't capture `/home/user`):
  //      - `/`     → root
  //      - `/*`    → root glob
  //      - `~`     → home
  //      - `~/`    → home with slash
  //      - `~/*`   → home glob
  //      - `$HOME` / `${HOME}` (optionally followed by `/` or `/*`)
  {
    pattern:
      /\brm\b(?=[^&|;<>\n]*\s-{1,2}(?:[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|recursive|force)\b)(?=[^&|;<>\n]*\s(?:\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?)(?:\s|$|[;&|]))/,
    reason: "Recursive deletion of root or home directories is blocked.",
  },
  // 2. Fork bombs. Canonical form is `:(){ :|:& };:` (the colon is the
  //    function name; `:` is also a POSIX shell builtin no-op, so it's
  //    valid as a function name). We accept any short identifier or `:`
  //    in the four name slots so trivial renames (`x(){ x|x& };x`,
  //    `b(){ b|b& };b`) don't sneak through.
  {
    pattern:
      /(?:[A-Za-z_]\w*|:)\s*\(\s*\)\s*\{\s*(?:[A-Za-z_]\w*|:)\s*\|\s*(?:[A-Za-z_]\w*|:)\s*&\s*\}\s*;\s*(?:[A-Za-z_]\w*|:)/,
    reason: "Fork-bomb pattern detected.",
  },
  // 3. Filesystem creation / swap formatting.
  //    Anchored to a command segment start (beginning of string or after
  //    a shell separator) so a benign `echo 'mkfs.ext4 is a filesystem
  //    command'` does not false-positive on prose. The trailing `\b`
  //    keeps `mkfsbench --help` allowed (`b` after `mkfs` is a word
  //    char, no boundary).
  {
    pattern: /(?:^|[;&|]\s*)(?:mkfs(?:\.[A-Za-z0-9]+)?|mkswap)\b/,
    reason: "Filesystem creation commands are blocked.",
  },
  // 4. `dd` with explicit input or output disk image. The negated class
  //    `[^|;&\n]*` keeps the match scoped to the same command segment.
  //    Anchored to segment start so prose `'dd if=...'` doesn't trigger.
  {
    pattern: /(?:^|[;&|]\s*)dd\b[^|;&\n]*\b(?:if|of)=\S+/,
    reason: "`dd` with explicit input/output is blocked.",
  },
  // 5. System lifecycle. `init 0` / `init 6` are textbook variants but
  //    `init` alone is too noisy (other commands legitimately use it),
  //    so only the runlevel-zero/six forms are blocked.
  //    Segment-anchored: `git log --grep='reboot fix'` must not trip the
  //    deny list, but `cat hosts && reboot` must.
  {
    pattern: /(?:^|[;&|]\s*)(?:shutdown|reboot|halt|poweroff|init\s+[06])\b/,
    reason: "System lifecycle commands are blocked.",
  },
  // 6. Direct block-device redirects. Covers SATA/NVMe/IDE/virt-IO
  //    naming conventions plus loopback devices. Already segment-internal
  //    via the required `>` redirect operator.
  {
    pattern: />\s*\/dev\/(?:sd[a-z]+|nvme\d+n\d+(?:p\d+)?|hd[a-z]+|vd[a-z]+|loop\d+)/,
    reason: "Writing to a block device is blocked.",
  },
  // 7. Privilege escalation. Segment-anchored so `grep sudoers convex/`
  //    or `grep sudo /var/log/auth.log` (legitimate inspection of log
  //    entries) is not blocked, but `sudo cat /etc/shadow` and
  //    `cat foo && sudo cat /etc/shadow` are.
  { pattern: /(?:^|[;&|]\s*)sudo\b/, reason: "`sudo` is blocked." },
  { pattern: /(?:^|[;&|]\s*)su\s+-(?:\s|$)/, reason: "`su -` is blocked." },
  // 8. Network download piped into a shell. We accept the most common
  //    download tools (`curl` / `wget` / `fetch`) and the most common
  //    interpreters (`bash` / `sh` / `zsh` / `dash` / `ksh`). The
  //    negated class `[^|;&\n]*` keeps the match anchored to a single
  //    pipeline rather than allowing arbitrary characters across
  //    command separators. Segment anchor on the leading tool name so
  //    `echo 'curl x | bash'` in prose doesn't trip.
  {
    pattern: /(?:^|[;&|]\s*)(?:curl|wget|fetch)\b[^|;&\n]*\|\s*(?:bash|sh|zsh|dash|ksh)\b/,
    reason: "Piping a network download into a shell is blocked.",
  },
  // 9. Recursive permission / ownership changes targeting root.
  //    Segment-anchored.
  {
    pattern: /(?:^|[;&|]\s*)(?:chmod|chown)\s+(?:-R|--recursive)\b[^|;&\n]*\s\/(?:\s|$|[;&|])/,
    reason: "Recursive permission changes on root are blocked.",
  },
];

/**
 * Walk the deny list once and return the first matching entry's reason,
 * or `null` if the command is allowed by the deny list. We intentionally
 * stop on the first match — the LLM gets the highest-priority reason
 * (deletion before chmod), which is the most useful guidance.
 */
function findCommandDenyReason(command: string): string | null {
  for (const entry of COMMAND_DENY_LIST) {
    if (entry.pattern.test(command)) {
      return entry.reason;
    }
  }
  return null;
}

/**
 * Slice the merged stdout/stderr to {@link SANDBOX_RUN_SHELL_MAX_OUTPUT_BYTES}
 * and append a truncation marker. We measure on UTF-8 byte length (not
 * `string.length`, which counts UTF-16 code units) so the cap matches the
 * documented "32 KB" budget regardless of the input's character set.
 *
 * Single-pass, allocation-free design:
 *
 *   - We walk the string by code point (`for...of` iterates code points,
 *     so a surrogate-pair character like "🚀" is yielded once, not twice).
 *   - The UTF-8 byte cost of each code point is computed *bitwise* from
 *     its numeric value rather than by calling `TextEncoder.encode(ch)` per
 *     character. The bit-length encoding rules
 *     (1 / 2 / 3 / 4 bytes for `< 0x80` / `< 0x800` / `< 0x10000` / rest)
 *     are stable and match what `TextEncoder` produces for any well-formed
 *     code point. Avoiding the per-char `encode` call removes one small
 *     `Uint8Array` allocation per character — meaningful for a 32 KB+ ASCII
 *     output where we'd otherwise allocate 32 K+ small buffers.
 *   - Total byte count and the truncation cutoff are computed in the same
 *     pass: we record the cutoff as soon as the running byte count would
 *     exceed the cap, but keep iterating to finish counting `totalBytes`.
 *     `totalBytes` reports the *true* pre-truncation cost so the ticker
 *     can show "32.0 KB out of 580 KB" rather than just the visible
 *     payload size.
 *
 * Daytona's `executeCommand` returns the merged output as an already-decoded
 * `string`; we never round-trip through `TextEncoder` because doing so would
 * materialise a multi-MB intermediate `Uint8Array` only to discard it.
 */
function truncateShellOutput(rawOutput: string): {
  output: string;
  bytesReturned: number;
  totalBytes: number;
  truncated: boolean;
} {
  let totalBytes = 0;
  // Exclusive UTF-16 code-unit index where truncation kicks in (or -1 if
  // the entire output fits). We track the cutoff in code-unit space (not
  // code-point space) so `rawOutput.slice(0, cutoffEnd)` is a single O(1)
  // slice that stays on a valid UTF-16 boundary — surrogate pairs are
  // either entirely kept or entirely dropped, never split.
  let cutoffEnd = -1;
  let bytesReturned = 0;
  let codeUnitIndex = 0;
  for (const ch of rawOutput) {
    // `ch.codePointAt(0)` is the full code point (because `for...of`
    // already paired the surrogates). The non-null assertion is safe:
    // every character produced by `for...of` has at least one code unit.
    const cp = ch.codePointAt(0)!;
    const chBytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (cutoffEnd === -1 && totalBytes + chBytes > SANDBOX_RUN_SHELL_MAX_OUTPUT_BYTES) {
      // First over-budget character: pin the cutoff at the *start* of this
      // character so the kept slice never includes a partial multi-byte
      // sequence. `bytesReturned` reflects the bytes already accepted
      // before this character.
      cutoffEnd = codeUnitIndex;
      bytesReturned = totalBytes;
    }
    totalBytes += chBytes;
    // `ch.length` is 1 for BMP code points and 2 for surrogate-pair code
    // points. Advancing by that amount keeps `codeUnitIndex` aligned with
    // `String.prototype.slice`'s code-unit indexing.
    codeUnitIndex += ch.length;
  }
  if (cutoffEnd === -1) {
    return { output: rawOutput, bytesReturned: totalBytes, totalBytes, truncated: false };
  }
  return {
    output: `${rawOutput.slice(0, cutoffEnd)}${SANDBOX_RUN_SHELL_TRUNCATION_MARKER}`,
    bytesReturned,
    truncated: true,
    totalBytes,
  };
}

/**
 * Clamp the model-supplied timeout into the allowed range.
 *
 * The Zod schema already constrains the input to `[1, MAX]`, but a missing
 * value or an upstream validator change should not be able to widen that
 * window. The clamp is the source of truth for what the adapter actually
 * sees.
 */
function clampShellTimeout(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) {
    return SANDBOX_RUN_SHELL_DEFAULT_TIMEOUT_SECONDS;
  }
  const integral = Math.floor(input);
  if (integral < 1) return 1;
  if (integral > SANDBOX_RUN_SHELL_MAX_TIMEOUT_SECONDS) return SANDBOX_RUN_SHELL_MAX_TIMEOUT_SECONDS;
  return integral;
}

/* ---------------------------------------------------------------------- *
 * Pure entry points — exported so unit tests can exercise them without   *
 * going through the AI SDK `tool({...})` wrapper.                        *
 * ---------------------------------------------------------------------- */

export async function executeReadFile(
  client: SandboxFsClient,
  repoPath: string,
  rawPath: string,
): Promise<ReadFileToolResult> {
  const resolution = resolveSandboxPath(rawPath, repoPath);
  if (!resolution.ok) {
    return { ok: false, errorCode: resolution.errorCode, message: resolution.message };
  }

  // `read_file` cannot meaningfully target the repo root — it is a
  // directory, not a file. The input path may have *normalized* to empty
  // ("convex/..", ".", "") even when the raw input was non-empty, so we
  // enforce the constraint here on the *post-normalization* path. The
  // matching `list_dir` tool happily accepts empty (= "list the root").
  if (resolution.normalizedRelative.length === 0) {
    return {
      ok: false,
      errorCode: "invalid_path",
      message: "read_file requires a path to a file inside the repository, not the repository root.",
    };
  }

  if (client.getFileInfo) {
    try {
      const info = await client.getFileInfo(resolution.absolutePath);
      if (info.isDir) {
        return {
          ok: false,
          errorCode: "invalid_path",
          message: "read_file requires a file path, but the resolved path is a directory.",
        };
      }
      if (info.size > SANDBOX_READ_FILE_MAX_BYTES) {
        return {
          ok: false,
          errorCode: "file_too_large_to_decode",
          message:
            `File is ${info.size} bytes; read_file only supports files up to ` +
            `${SANDBOX_READ_FILE_MAX_BYTES} bytes. Use run_shell with a targeted ` +
            "`sed`, `head`, `tail`, or `grep` command to inspect a smaller slice.",
        };
      }
    } catch (error) {
      return { ok: false, errorCode: "io_error", message: explainIoError(error) };
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await client.downloadFile(resolution.absolutePath, SANDBOX_READ_FILE_TIMEOUT_SECONDS);
  } catch (error) {
    return { ok: false, errorCode: "io_error", message: explainIoError(error) };
  }

  if (!(bytes instanceof Uint8Array)) {
    // Defensive: `Buffer` extends `Uint8Array` in Node, so the production
    // adapter is fine — but a fake client returning a plain object would
    // crash `decodeFileBytes`. Catch it here as a structured error.
    return {
      ok: false,
      errorCode: "io_error",
      message: "Sandbox download returned a non-binary payload.",
    };
  }

  const { content, bytesReturned, truncated } = decodeFileBytes(bytes);
  // `bytesReturned` / `totalBytes` keep their pre-redaction values: they
  // are cost signals for the "Reading X.ts (12.4 KB)" ticker, not lengths
  // of the post-redaction string.
  const { redacted, matchedTypes } = redact(content);

  return {
    ok: true,
    path: resolution.normalizedRelative,
    bytesReturned,
    totalBytes: bytes.byteLength,
    truncated,
    content: redacted,
    redactedTypes: matchedTypes,
  };
}

export async function executeListDir(
  client: SandboxFsClient,
  repoPath: string,
  rawPath: string,
): Promise<ListDirToolResult> {
  const resolution = resolveSandboxPath(rawPath, repoPath);
  if (!resolution.ok) {
    return { ok: false, errorCode: resolution.errorCode, message: resolution.message };
  }

  let entries: readonly SandboxListedFile[];
  let totalEntries: number;
  let wasTruncatedByAdapter = false;
  try {
    if (client.listFilesLimited) {
      const limited = await client.listFilesLimited(resolution.absolutePath, SANDBOX_LIST_DIR_MAX_ENTRIES);
      entries = limited.entries;
      totalEntries = limited.totalEntries;
      wasTruncatedByAdapter = limited.truncated;
    } else {
      entries = await client.listFiles(resolution.absolutePath);
      totalEntries = entries.length;
    }
  } catch (error) {
    return { ok: false, errorCode: "io_error", message: explainIoError(error) };
  }

  // Sort by (dirs-first, then name) for stable output. Daytona's API does
  // not guarantee ordering and the LLM benefits from a deterministic view —
  // it can reference "the third entry in convex/" across turns and have
  // that mean the same thing both times.
  //
  // Binary code-point comparison (`a < b ? -1 : ...`) is intentional over
  // `localeCompare`: the JavaScript edge / browser / Node runtimes can
  // differ in their default locale ICU data, which would give the same
  // directory two different orderings depending on where it is sorted.
  // Code-point ordering is identical everywhere — `'README.md'` (`R` =
  // 82) always sorts before `'alpha.ts'` (`a` = 97), no surprise diffs
  // between local tests and production.
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });

  const truncated = wasTruncatedByAdapter || sortedEntries.length > SANDBOX_LIST_DIR_MAX_ENTRIES;
  const sliced = truncated ? sortedEntries.slice(0, SANDBOX_LIST_DIR_MAX_ENTRIES) : sortedEntries;

  // Redaction signals are aggregated to the result level (not annotated
  // per-entry) so the entry shape stays `{name, type, sizeBytes}`, which
  // the tool-call ticker depends on.
  const aggregatedRedactionTypes = new Set<RedactionType>();
  const redactedEntries: ListDirToolEntry[] = sliced.map((entry) => {
    const { redacted, matchedTypes } = redact(entry.name);
    for (const type of matchedTypes) {
      aggregatedRedactionTypes.add(type);
    }
    return {
      name: redacted,
      type: entry.isDir ? "dir" : "file",
      sizeBytes: entry.size,
    };
  });

  return {
    ok: true,
    path: resolution.normalizedRelative,
    entries: redactedEntries,
    totalEntries,
    truncated,
    redactedTypes: [...aggregatedRedactionTypes].sort(),
  };
}

/**
 * Execute a shell command inside the sandbox.
 *
 * Steps, in order:
 *   1. Trim and validate the command. An empty / whitespace-only command
 *      is `invalid_command` (the Zod layer also rejects `min(1)`, but a
 *      whitespace-only command would survive that and we want a clear
 *      envelope rather than a Daytona "empty command" upstream error).
 *   2. Walk the deny list. The first matching entry's reason becomes the
 *      `command_blocked` envelope's message.
 *   3. Resolve `workdir` through the same `resolveSandboxPath` helper that
 *      `read_file` / `list_dir` use. The result is always under
 *      `repoPath`; an unspecified workdir resolves to the repo root.
 *   4. Clamp the per-call timeout into `[1, MAX_TIMEOUT]`.
 *   5. Dispatch to the adapter; map `kind: "timeout"` to `command_timeout`,
 *      let other thrown errors fall through to the generic `io_error`
 *      catch.
 *   6. Truncate the merged output, redact, build the success envelope.
 *
 * `durationMs` is measured at the tool-layer boundary (just around the
 * adapter call) so the tool result reflects the real latency the user
 * waited on rather than only the upstream Daytona compute time.
 */
export async function executeRunShell(
  client: SandboxFsClient,
  repoPath: string,
  rawCommand: string,
  rawWorkdir: string | undefined,
  rawTimeoutSeconds: number | undefined,
): Promise<RunShellToolResult> {
  // Step 1 — trim + sanity check.
  const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
  if (command.length === 0) {
    return {
      ok: false,
      errorCode: "invalid_command",
      message: "run_shell requires a non-empty command string.",
    };
  }
  if (command.includes("\0")) {
    return {
      ok: false,
      errorCode: "invalid_command",
      message: "Command contains a NUL byte.",
    };
  }

  // Step 2 — deny list. Run this *before* resolving the workdir because
  // a blocked command should produce the same `command_blocked` envelope
  // regardless of whether the workdir was malformed.
  const denyReason = findCommandDenyReason(command);
  if (denyReason !== null) {
    return {
      ok: false,
      errorCode: "command_blocked",
      message: denyReason,
    };
  }

  // Step 3 — workdir resolution. Empty / undefined / "." all collapse to
  // the repo root.
  const resolution = resolveSandboxPath(rawWorkdir ?? "", repoPath);
  if (!resolution.ok) {
    return { ok: false, errorCode: resolution.errorCode, message: resolution.message };
  }

  // Step 4 — timeout clamp.
  const timeoutSeconds = clampShellTimeout(rawTimeoutSeconds);

  // Step 5 — dispatch to the adapter and measure the wall-clock duration
  // around the call. `durationMs` is only meaningful — and only persisted —
  // on the success envelope, where it varies per call. The other branches
  // carry an implicit duration:
  //
  //   - `command_timeout`: the duration is by construction
  //     `~timeoutSeconds`. The ticker formats this as "Ran for 30s,
  //     timed out" using `timeoutSeconds`, so we do not need to surface a
  //     measured `durationMs` on the error envelope to render that string.
  //   - `io_error`: an upstream Daytona failure (auth, 404, network drop)
  //     can occur at any point, including before the call is dispatched.
  //     Reporting a measured duration could mislead — "the call ran for
  //     12 ms" when the call did not in fact ever reach Daytona is worse
  //     than no number at all.
  //
  // If a future change needs the wall-clock measurement on either error
  // envelope, the cleanest extension is to add an optional `durationMs`
  // to `SandboxToolErrorEnvelope` (and its persisted counterpart in
  // `messageToolCallEvents`), not to silently overload the success-only
  // field.
  const startedAt = Date.now();
  let outcome: SandboxShellOutcome;
  try {
    outcome = await client.executeCommand(command, {
      cwd: resolution.absolutePath,
      maxOutputBytes: SANDBOX_RUN_SHELL_MAX_OUTPUT_BYTES,
      timeoutSeconds,
    });
  } catch (error) {
    return { ok: false, errorCode: "io_error", message: explainIoError(error) };
  }
  const durationMs = Date.now() - startedAt;

  if (outcome.kind === "timeout") {
    // The adapter has already translated `DaytonaTimeoutError` into a
    // structured outcome, so we can build the envelope without inspecting
    // any Daytona-specific symbols.
    return {
      ok: false,
      errorCode: "command_timeout",
      message:
        outcome.message ||
        `Command exceeded the ${timeoutSeconds}s timeout. Re-run with a more specific path or shorter input.`,
    };
  }

  // Step 6 — truncate, redact, return.
  const truncatedOutput = truncateShellOutput(outcome.output);
  const output = truncatedOutput.output;
  const bytesReturned = outcome.bytesReturned ?? truncatedOutput.bytesReturned;
  const totalBytes = outcome.totalBytes ?? truncatedOutput.totalBytes;
  const truncated = outcome.truncated ?? truncatedOutput.truncated;
  const { redacted, matchedTypes } = redact(output);

  // Convert the absolute workdir back to its repo-relative form for the
  // envelope. Always echo a path the LLM can hand to the next tool call
  // (relative to repo root); echoing the absolute path would leak the
  // sandbox's filesystem layout into messages without giving the model
  // anything actionable.
  const workdirEcho = resolution.normalizedRelative.length === 0 ? "" : resolution.normalizedRelative;

  return {
    ok: true,
    command,
    workdir: workdirEcho,
    exitCode: outcome.exitCode,
    output: redacted,
    bytesReturned,
    totalBytes,
    truncated,
    durationMs,
    timeoutSeconds,
    redactedTypes: matchedTypes,
  };
}

/* ---------------------------------------------------------------------- *
 * AI SDK tool factory.                                                   *
 * ---------------------------------------------------------------------- */

/**
 * Tool input schemas. Pulled out of the factory body so the Zod objects are
 * allocated once per process rather than once per chat reply (the factory
 * is invoked per request, but the schemas themselves are immutable).
 */
const READ_FILE_INPUT_SCHEMA = z.object({
  path: z
    .string()
    .describe(
      "Path to the file inside the repository, relative to the repo root (e.g. 'convex/chat/send.ts'). Absolute paths and '..' escape attempts are rejected.",
    ),
});

const LIST_DIR_INPUT_SCHEMA = z.object({
  path: z
    .string()
    .describe(
      "Directory to list, relative to the repo root. Use '' or '.' for the repo root itself. Absolute paths and '..' escape attempts are rejected.",
    ),
});

/**
 * `run_shell` input schema.
 *
 * The schema is deliberately loose on `command`: the LLM may submit any
 * non-empty string, and the tool layer enforces deny list / safety. We do
 * NOT call out specific allowed commands here — that would couple the
 * schema to a curated list and make read-only inspection harder to
 * compose (`grep -rn ... | head`, `find -name '*.ts' | wc -l`, etc.).
 *
 * `workdir` accepts the same path shape as `read_file` / `list_dir`: a
 * repo-relative string, with `''` / `'.'` meaning "the repo root." The
 * resolver enforces no-escape semantics; the schema just declares the
 * shape.
 *
 * `timeout_seconds` is bounded at the schema layer so an obviously
 * out-of-range value (`-1`, `1000`) is rejected before the tool body
 * runs. The clamp inside `executeRunShell` is a defense-in-depth pin so
 * a future schema relaxation cannot widen the upstream window.
 */
const RUN_SHELL_INPUT_SCHEMA = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      "Shell command to execute (read-only inspection only). Examples: 'grep -rn pattern convex/', 'git log --oneline -20', 'find . -name \"*.ts\" | wc -l'. Destructive commands (rm -rf /, mkfs, dd, sudo, fork bombs) are blocked and return errorCode='command_blocked'. The sandbox is read-only by policy; do not attempt network egress, package installs, or state-changing operations.",
    ),
  workdir: z
    .string()
    .optional()
    .describe(
      "Optional working directory inside the repository, relative to the repo root. Defaults to the repo root. Absolute paths and '..' escape attempts are rejected.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(SANDBOX_RUN_SHELL_MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(
      `Optional execution timeout in seconds. Default ${SANDBOX_RUN_SHELL_DEFAULT_TIMEOUT_SECONDS}, max ${SANDBOX_RUN_SHELL_MAX_TIMEOUT_SECONDS}.`,
    ),
});

/**
 * Build the {@link ToolSet} the LLM sees during a sandbox-mode reply.
 *
 * The factory captures `client` and `repoPath` in the closures — a fresh
 * call per chat reply means each reply binds to its own sandbox handle,
 * with no cross-thread sharing. The returned tools are otherwise plain AI
 * SDK `tool({...})` instances; nothing prevents downstream code (the
 * tool-call ticker) from wrapping them or peeking at their inputs.
 */
export function createSandboxTools(client: SandboxFsClient, repoPath: string) {
  return {
    read_file: tool({
      description:
        "Read the UTF-8 contents of a file inside the repository. Files larger than 64 KiB return `errorCode: 'file_too_large_to_decode'`; use run_shell with `sed`, `head`, `tail`, or `grep` for a narrower section.",
      inputSchema: READ_FILE_INPUT_SCHEMA,
      execute: ({ path }) => executeReadFile(client, repoPath, path),
    }),
    list_dir: tool({
      description:
        "List the entries (files and directories) of a directory inside the repository. Output is capped at 200 entries; pass '' or '.' for the repository root.",
      inputSchema: LIST_DIR_INPUT_SCHEMA,
      execute: ({ path }) => executeListDir(client, repoPath, path),
    }),
    run_shell: tool({
      description: [
        "Run a shell command inside the repository sandbox for read-only inspection (grep, find, git log, tree, wc, head, tail, ...).",
        "Combined stdout/stderr is capped at 32 KiB and the call is bounded by `timeout_seconds` (default 30, max 60).",
        "Working directory defaults to the repository root and cannot escape the repo subtree.",
        "Destructive commands (rm -rf /, fork bombs, mkfs, dd, sudo, system shutdown, network pipe-to-shell) are blocked at the tool layer and return `errorCode: 'command_blocked'`.",
        "Non-zero `exitCode` is *not* an error — it is returned in the success envelope so you can interpret it (e.g. `grep` exits 1 when nothing matched).",
      ].join(" "),
      inputSchema: RUN_SHELL_INPUT_SCHEMA,
      execute: ({ command, workdir, timeout_seconds }) =>
        executeRunShell(client, repoPath, command, workdir, timeout_seconds),
    }),
  };
}

export type SandboxToolSet = ReturnType<typeof createSandboxTools>;
