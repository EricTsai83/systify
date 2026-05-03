/**
 * Plan 04 — Sandbox tool factory.
 *
 * Two file-system tools that the LLM can call during a sandbox-mode chat
 * reply: `read_file` (UTF-8 file contents capped at 64 KiB) and `list_dir`
 * (directory entries capped at 200 names). Both are read-only; the
 * destructive `run_shell` tool lands in Plan 08 *after* the redaction layer
 * (Plan 05) is in place.
 *
 * Design boundaries that future plans depend on:
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
 *      `path_outside_repo`.
 *
 *   4. **Truncation is byte-level.** `downloadFile` returns the entire file
 *      as a `Uint8Array`. We slice the byte buffer to the cap *before*
 *      decoding so a multi-MB file doesn't materialise an intermediate
 *      multi-MB UTF-8 string just to be sliced down. The decoder runs with
 *      `fatal: false` so a truncation that lands inside a multi-byte
 *      sequence yields a single replacement character, not an exception.
 *
 *   5. **Result shape is forward-compatible with Plan 06's persisted trace.**
 *      Each result carries `truncated`, `bytesReturned`, and (where useful)
 *      `totalBytes` / `totalEntries` so the upcoming tool-call ticker can
 *      summarise a call as `Reading convex/chat/send.ts (12.4 KB, truncated)`
 *      without re-running the tool.
 */

import { tool } from "ai";
import { z } from "zod";

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
export const SANDBOX_TRUNCATION_MARKER = "\n\n[…truncated by SysTify after 64 KB…]";

/* ---------------------------------------------------------------------- *
 * Sandbox FS adapter interface — kept intentionally minimal so the       *
 * production adapter (daytona.ts) and the test fake stay in lockstep.   *
 * ---------------------------------------------------------------------- */

export interface SandboxListedFile {
  readonly name: string;
  readonly isDir: boolean;
  readonly size: number;
}

/**
 * Minimal projection of Daytona's `Sandbox.fs` surface area. Only the two
 * methods the tools actually need are part of the contract; broader access
 * stays off the menu so a future tool addition (`run_shell` in Plan 08) is
 * a deliberate API change here, not an accidental capability widening.
 */
export interface SandboxFsClient {
  /** Returns the entire file as raw bytes. Caller is responsible for size guards. */
  readonly downloadFile: (path: string, timeoutSeconds?: number) => Promise<Uint8Array>;
  readonly listFiles: (path: string) => Promise<readonly SandboxListedFile[]>;
}

/* ---------------------------------------------------------------------- *
 * Result shapes (also exported so callers persisting tool traces in     *
 * Plan 06 / Plan 12 import the same types).                              *
 * ---------------------------------------------------------------------- */

export type SandboxToolErrorCode =
  | "invalid_path"
  | "path_outside_repo"
  | "file_too_large_to_decode"
  | "io_error";

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
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const decoded = decoder.decode(sliced);
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
  return {
    ok: true,
    path: resolution.normalizedRelative,
    bytesReturned,
    totalBytes: bytes.byteLength,
    truncated,
    content,
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
  try {
    entries = await client.listFiles(resolution.absolutePath);
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

  const truncated = sortedEntries.length > SANDBOX_LIST_DIR_MAX_ENTRIES;
  const sliced = truncated ? sortedEntries.slice(0, SANDBOX_LIST_DIR_MAX_ENTRIES) : sortedEntries;

  return {
    ok: true,
    path: resolution.normalizedRelative,
    entries: sliced.map((entry) => ({
      name: entry.name,
      type: entry.isDir ? "dir" : "file",
      sizeBytes: entry.size,
    })),
    totalEntries: sortedEntries.length,
    truncated,
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
    .min(1, { message: "path must not be empty" })
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
 * Build the {@link ToolSet} the LLM sees during a sandbox-mode reply.
 *
 * The factory captures `client` and `repoPath` in the closures — a fresh
 * call per chat reply means each reply binds to its own sandbox handle,
 * with no cross-thread sharing. The returned tools are otherwise plain AI
 * SDK `tool({...})` instances; nothing prevents downstream code (Plan 06's
 * tool-call ticker) from wrapping them or peeking at their inputs.
 */
export function createSandboxTools(client: SandboxFsClient, repoPath: string) {
  return {
    read_file: tool({
      description:
        "Read the UTF-8 contents of a file inside the repository. Output is capped at 64 KiB; the response includes a `truncated` flag and the file's `totalBytes` so you can decide whether to ask for a narrower section.",
      inputSchema: READ_FILE_INPUT_SCHEMA,
      execute: ({ path }) => executeReadFile(client, repoPath, path),
    }),
    list_dir: tool({
      description:
        "List the entries (files and directories) of a directory inside the repository. Output is capped at 200 entries; pass '' or '.' for the repository root.",
      inputSchema: LIST_DIR_INPUT_SCHEMA,
      execute: ({ path }) => executeListDir(client, repoPath, path),
    }),
  };
}

export type SandboxToolSet = ReturnType<typeof createSandboxTools>;
