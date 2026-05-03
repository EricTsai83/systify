import type { ToolCallOptions } from "ai";
import { describe, expect, test, vi } from "vitest";
import {
  SANDBOX_LIST_DIR_MAX_ENTRIES,
  SANDBOX_READ_FILE_MAX_BYTES,
  SANDBOX_READ_FILE_TIMEOUT_SECONDS,
  SANDBOX_TRUNCATION_MARKER,
  createSandboxTools,
  executeListDir,
  executeReadFile,
  type ListDirToolResult,
  type ReadFileToolResult,
  type SandboxFsClient,
  type SandboxListedFile,
} from "./sandboxTools";

/**
 * Minimal `ToolCallOptions` placeholder for direct `execute` invocation in
 * tests. The AI SDK passes this argument from inside its tool loop; our
 * `read_file` / `list_dir` `execute` functions never read any of the
 * fields, so a unique-call-id stub is enough. Constructing it through
 * `unknown` keeps TypeScript honest without leaking `any` into the
 * assertions and silences ESLint without an inline disable directive.
 */
function makeToolCallOptions(toolCallId: string): ToolCallOptions {
  return { toolCallId, messages: [] } as unknown as ToolCallOptions;
}

const REPO_PATH = "/workspace/repo";
const TEXT_ENCODER = new TextEncoder();
const NUL = String.fromCharCode(0);

/**
 * Build a `SandboxFsClient` whose `downloadFile` and `listFiles` are
 * controllable per-test. Each test pre-seeds expected responses or
 * substitutes its own implementation. The default implementations throw
 * loudly — forgetting to seed becomes a hard failure rather than a silent
 * undefined-return crash deep in the tool execute.
 */
function makeFakeFsClient(overrides: Partial<SandboxFsClient> = {}): SandboxFsClient {
  return {
    downloadFile: vi
      .fn<SandboxFsClient["downloadFile"]>()
      .mockImplementation(async () => {
        throw new Error("test forgot to stub downloadFile");
      }),
    listFiles: vi
      .fn<SandboxFsClient["listFiles"]>()
      .mockImplementation(async () => {
        throw new Error("test forgot to stub listFiles");
      }),
    ...overrides,
  };
}

function expectOk<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  expect(result.ok, `expected ok result, got ${JSON.stringify(result)}`).toBe(true);
  return result as Extract<R, { ok: true }>;
}

function expectErr<R extends { ok: boolean }>(result: R): Extract<R, { ok: false }> {
  expect(result.ok, `expected error result, got ${JSON.stringify(result)}`).toBe(false);
  return result as Extract<R, { ok: false }>;
}

describe("executeReadFile", () => {
  test("returns the decoded UTF-8 contents and resolves the path under repoPath", async () => {
    const downloadFile = vi
      .fn<SandboxFsClient["downloadFile"]>()
      .mockResolvedValue(TEXT_ENCODER.encode("hello, world\n"));
    const client = makeFakeFsClient({ downloadFile });

    const result = await executeReadFile(client, REPO_PATH, "convex/chat/send.ts");
    const ok = expectOk(result);

    // The file is small enough to fit under the cap, so byteCount and total
    // line up exactly and the body is the decoded UTF-8 string.
    expect(ok.content).toBe("hello, world\n");
    expect(ok.bytesReturned).toBe(13);
    expect(ok.totalBytes).toBe(13);
    expect(ok.truncated).toBe(false);
    expect(ok.path).toBe("convex/chat/send.ts");

    // Daytona is invoked with the absolute path under the repo root and the
    // bounded per-call timeout, never the file's "raw" relative path.
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledWith(
      `${REPO_PATH}/convex/chat/send.ts`,
      SANDBOX_READ_FILE_TIMEOUT_SECONDS,
    );
  });

  test("strips a leading './' for ergonomics", async () => {
    const downloadFile = vi
      .fn<SandboxFsClient["downloadFile"]>()
      .mockResolvedValue(TEXT_ENCODER.encode("ok"));
    const client = makeFakeFsClient({ downloadFile });

    const result = await executeReadFile(client, REPO_PATH, "./README.md");
    const ok = expectOk(result);

    expect(ok.path).toBe("README.md");
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledWith(`${REPO_PATH}/README.md`, SANDBOX_READ_FILE_TIMEOUT_SECONDS);
  });

  test("truncates files larger than 64 KiB and surfaces totalBytes for trace", async () => {
    // 80 KiB of UTF-8 bytes — well past the 64 KiB cap. We populate with a
    // single byte ('A') so the byte length and character length match,
    // letting us assert exact truncation arithmetic without UTF-8 surprises.
    const oversized = new Uint8Array(80 * 1024).fill(0x41); // 'A'
    const downloadFile = vi.fn<SandboxFsClient["downloadFile"]>().mockResolvedValue(oversized);
    const client = makeFakeFsClient({ downloadFile });

    const result = await executeReadFile(client, REPO_PATH, "package-lock.json");
    const ok = expectOk(result);

    expect(ok.bytesReturned).toBe(SANDBOX_READ_FILE_MAX_BYTES);
    expect(ok.totalBytes).toBe(80 * 1024);
    expect(ok.truncated).toBe(true);
    // The decoded body holds exactly the first 64 KiB of 'A's followed by
    // the truncation marker — no silent dropping of the marker on large
    // inputs.
    expect(ok.content.endsWith(SANDBOX_TRUNCATION_MARKER)).toBe(true);
    expect(ok.content.slice(0, SANDBOX_READ_FILE_MAX_BYTES)).toBe("A".repeat(SANDBOX_READ_FILE_MAX_BYTES));
  });

  test("decodes UTF-8 with substitution when truncation cuts a multi-byte sequence", async () => {
    // The repeated emoji ("🚀") is 4 bytes per char. Generating just over
    // the cap puts the truncation point inside a multi-byte sequence; the
    // tail must come back as a replacement char, never an exception.
    const piece = TEXT_ENCODER.encode("🚀");
    const repeats = Math.ceil((SANDBOX_READ_FILE_MAX_BYTES + 8) / piece.byteLength);
    const giant = new Uint8Array(piece.byteLength * repeats);
    for (let i = 0; i < repeats; i += 1) {
      giant.set(piece, i * piece.byteLength);
    }
    const client = makeFakeFsClient({
      downloadFile: vi.fn<SandboxFsClient["downloadFile"]>().mockResolvedValue(giant),
    });

    const result = await executeReadFile(client, REPO_PATH, "fixtures/emoji.txt");
    const ok = expectOk(result);

    // Truncation marker is appended; the function did not throw on the
    // partial multi-byte tail.
    expect(ok.truncated).toBe(true);
    expect(ok.content.endsWith(SANDBOX_TRUNCATION_MARKER)).toBe(true);
  });

  test.each([
    {
      name: "absolute path",
      input: "/etc/passwd",
      errorCode: "invalid_path" as const,
      messagePattern: /relative/i,
    },
    {
      name: "absolute path under repoPath (still rejected — guess-the-prefix attack)",
      input: `${REPO_PATH}/convex/secrets.ts`,
      errorCode: "invalid_path" as const,
      messagePattern: /relative/i,
    },
  ])("rejects $name with errorCode=$errorCode", async ({ input, errorCode, messagePattern }) => {
    const client = makeFakeFsClient();
    const result = await executeReadFile(client, REPO_PATH, input);
    const err = expectErr(result);

    expect(err.errorCode).toBe(errorCode);
    expect(err.message).toMatch(messagePattern);
    expect(client.downloadFile).not.toHaveBeenCalled();
  });

  test("rejects paths containing a NUL byte (string-truncation defense in depth)", async () => {
    // `String.fromCharCode(0)` keeps the literal control character out of
    // the test source where it would be invisible / fragile to round-trip
    // through tooling.
    const input = `convex/${NUL}.env`;
    const client = makeFakeFsClient();
    const result = await executeReadFile(client, REPO_PATH, input);
    const err = expectErr(result);

    expect(err.errorCode).toBe("invalid_path");
    expect(err.message).toMatch(/nul byte/i);
    expect(client.downloadFile).not.toHaveBeenCalled();
  });

  test.each([
    "../etc/passwd",
    "convex/../../etc/shadow",
    "..",
  ])("rejects path-escape attempt %s with errorCode=path_outside_repo", async (input) => {
    const client = makeFakeFsClient();
    const result = await executeReadFile(client, REPO_PATH, input);
    const err = expectErr(result);

    expect(err.errorCode).toBe("path_outside_repo");
    // The bad path appears in the message so the LLM (and any persisted
    // trace) can show the user what was rejected.
    expect(err.message).toContain(input);
    expect(client.downloadFile).not.toHaveBeenCalled();
  });

  test("rejects a path that normalizes to the repository root (not a file)", async () => {
    // `convex/..` is *not* an escape attempt — it cancels back to the repo
    // root, which is a valid relative location. But `read_file` cannot
    // target a directory, so the validator must reject this with
    // `invalid_path` (matching list_dir's contract: list_dir accepts the
    // empty path as "list the root", read_file does not).
    const client = makeFakeFsClient();
    const result = await executeReadFile(client, REPO_PATH, "convex/..");
    const err = expectErr(result);

    expect(err.errorCode).toBe("invalid_path");
    expect(err.message).toMatch(/repository root|not the repository root|directory/i);
    expect(client.downloadFile).not.toHaveBeenCalled();
  });

  test("collapses inner '..' segments that cancel out without escaping the root", async () => {
    // `convex/foo/../chat/send.ts` should normalize to `convex/chat/send.ts`
    // without rejection — the `..` cancels `foo/` but never crosses the
    // repo root.
    const downloadFile = vi
      .fn<SandboxFsClient["downloadFile"]>()
      .mockResolvedValue(TEXT_ENCODER.encode("ok"));
    const client = makeFakeFsClient({ downloadFile });

    const result = await executeReadFile(client, REPO_PATH, "convex/foo/../chat/send.ts");
    const ok = expectOk(result);

    expect(ok.path).toBe("convex/chat/send.ts");
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledWith(
      `${REPO_PATH}/convex/chat/send.ts`,
      SANDBOX_READ_FILE_TIMEOUT_SECONDS,
    );
  });

  test("forwards Daytona errors as a structured io_error envelope (no throw)", async () => {
    const downloadFile = vi
      .fn<SandboxFsClient["downloadFile"]>()
      .mockRejectedValue(new Error("file not found: convex/missing.ts"));
    const client = makeFakeFsClient({ downloadFile });

    const result = await executeReadFile(client, REPO_PATH, "convex/missing.ts");
    const err = expectErr(result);

    expect(err.errorCode).toBe("io_error");
    expect(err.message).toContain("file not found");
    expect(downloadFile).toHaveBeenCalledOnce();
  });

  test("rejects non-binary downloadFile responses without crashing", async () => {
    // A misbehaving fake (or a future Daytona SDK regression) might return
    // a string. The tool must surface this as an io_error rather than
    // throwing inside the decoder.
    const client = makeFakeFsClient({
      downloadFile: vi
        .fn<SandboxFsClient["downloadFile"]>()
        .mockResolvedValue("oops" as unknown as Uint8Array),
    });

    const result = await executeReadFile(client, REPO_PATH, "convex/x.ts");
    const err = expectErr(result);
    expect(err.errorCode).toBe("io_error");
    expect(err.message).toMatch(/non-binary/i);
  });
});

describe("executeListDir", () => {
  function fakeEntry(name: string, isDir: boolean, size = 0): SandboxListedFile {
    return { name, isDir, size };
  }

  test("returns dirs-first, alphabetical entries with the repo-relative path", async () => {
    const listFiles = vi.fn<SandboxFsClient["listFiles"]>().mockResolvedValue([
      fakeEntry("zeta.ts", false, 64),
      fakeEntry("alpha.ts", false, 128),
      fakeEntry("subdir", true, 0),
      fakeEntry("README.md", false, 12),
    ]);
    const client = makeFakeFsClient({ listFiles });

    const result = await executeListDir(client, REPO_PATH, "convex");
    const ok = expectOk(result);

    // Sorted: dirs (subdir) first, then files alphabetically.
    expect(ok.entries.map((e) => e.name)).toEqual(["subdir", "README.md", "alpha.ts", "zeta.ts"]);
    expect(ok.entries[0]).toEqual({ name: "subdir", type: "dir", sizeBytes: 0 });
    expect(ok.totalEntries).toBe(4);
    expect(ok.truncated).toBe(false);
    expect(ok.path).toBe("convex");
    expect(listFiles).toHaveBeenCalledOnce();
    expect(listFiles).toHaveBeenCalledWith(`${REPO_PATH}/convex`);
  });

  test.each(["", ".", "./"])("treats %j as the repository root", async (input) => {
    const listFiles = vi
      .fn<SandboxFsClient["listFiles"]>()
      .mockResolvedValue([fakeEntry("README.md", false, 12)]);
    const client = makeFakeFsClient({ listFiles });

    const result = await executeListDir(client, REPO_PATH, input);
    const ok = expectOk(result);

    expect(ok.path).toBe("");
    // For root, the absolute path is exactly repoPath (no trailing slash) —
    // matches Daytona's expected listFiles input.
    expect(listFiles).toHaveBeenCalledOnce();
    expect(listFiles).toHaveBeenCalledWith(REPO_PATH);
  });

  test("truncates directories with more than the entry cap and reports totalEntries", async () => {
    const overflow = SANDBOX_LIST_DIR_MAX_ENTRIES + 25;
    const overflowing = Array.from({ length: overflow }, (_, index) =>
      fakeEntry(`file-${String(index).padStart(4, "0")}.ts`, false, index),
    );
    const client = makeFakeFsClient({
      listFiles: vi.fn<SandboxFsClient["listFiles"]>().mockResolvedValue(overflowing),
    });

    const result = await executeListDir(client, REPO_PATH, "huge-dir");
    const ok = expectOk(result);

    expect(ok.entries).toHaveLength(SANDBOX_LIST_DIR_MAX_ENTRIES);
    expect(ok.totalEntries).toBe(overflow);
    expect(ok.truncated).toBe(true);
  });

  test.each([
    { name: "absolute path", input: "/etc", errorCode: "invalid_path" as const },
    { name: "escape attempt", input: "../..", errorCode: "path_outside_repo" as const },
  ])("rejects $name without calling listFiles", async ({ input, errorCode }) => {
    const client = makeFakeFsClient();
    const result = await executeListDir(client, REPO_PATH, input);
    const err = expectErr(result);
    expect(err.errorCode).toBe(errorCode);
    expect(client.listFiles).not.toHaveBeenCalled();
  });

  test("forwards Daytona errors as io_error envelopes", async () => {
    const client = makeFakeFsClient({
      listFiles: vi.fn<SandboxFsClient["listFiles"]>().mockRejectedValue("permission denied"),
    });
    const result = await executeListDir(client, REPO_PATH, "secrets");
    const err = expectErr(result);

    expect(err.errorCode).toBe("io_error");
    expect(err.message).toBe("permission denied");
  });
});

describe("createSandboxTools (AI SDK wrapper)", () => {
  test("wires read_file and list_dir with the captured client and repoPath", async () => {
    const downloadFile = vi
      .fn<SandboxFsClient["downloadFile"]>()
      .mockResolvedValue(TEXT_ENCODER.encode("hi"));
    const listFiles = vi
      .fn<SandboxFsClient["listFiles"]>()
      .mockResolvedValue([{ name: "x.ts", isDir: false, size: 2 }]);
    const tools = createSandboxTools({ downloadFile, listFiles }, REPO_PATH);

    // Both tools must be exposed under their canonical AI-SDK names so the
    // model sees them as `read_file` / `list_dir` (not arbitrary keys).
    expect(Object.keys(tools).sort()).toEqual(["list_dir", "read_file"]);

    // Each tool has a non-empty description (the model uses it to decide
    // which to call).
    expect(tools.read_file.description).toBeTruthy();
    expect(tools.list_dir.description).toBeTruthy();

    // We invoke `execute` directly here as the AI SDK would. The first
    // positional argument is the parsed input; the second is the SDK's
    // `ToolCallOptions`, which our execute bodies never consume.
    const readResult = (await tools.read_file.execute!(
      { path: "x.ts" },
      makeToolCallOptions("call-read-1"),
    )) as ReadFileToolResult;
    expect(readResult.ok).toBe(true);
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledWith(`${REPO_PATH}/x.ts`, SANDBOX_READ_FILE_TIMEOUT_SECONDS);

    const listResult = (await tools.list_dir.execute!(
      { path: "" },
      makeToolCallOptions("call-list-1"),
    )) as ListDirToolResult;
    expect(listResult.ok).toBe(true);
    expect(listFiles).toHaveBeenCalledOnce();
    expect(listFiles).toHaveBeenCalledWith(REPO_PATH);
  });
});
