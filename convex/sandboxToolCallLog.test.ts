/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  SANDBOX_TOOL_CALL_LOG_CLEANUP_BATCH_SIZE,
  SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS,
  SANDBOX_TOOL_CALL_LOG_RETENTION_MS,
  capAuditInputJson,
  countUtf8Bytes,
  extractAuditMetadataFromToolOutput,
} from "./chat/sandboxToolCallLog";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * Plan 12 — Pure-helper coverage.
 *
 * Boundary tests for the helpers that {@link recordSandboxToolCallLogEntry}
 * composes; pinned independently of any DB wiring so a regression in the
 * cap math, byte counter, or audit-metadata extractor surfaces here
 * before it pollutes mutation tests.
 */
describe("capAuditInputJson", () => {
  test("returns the value unchanged when under the cap", () => {
    const input = "a".repeat(SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS - 1);
    expect(capAuditInputJson(input)).toBe(input);
  });

  test("returns the value unchanged at exactly the cap", () => {
    const input = "a".repeat(SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS);
    expect(capAuditInputJson(input)).toBe(input);
  });

  test("truncates oversized inputs with the truncation marker", () => {
    const oversized = "a".repeat(SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS + 100);
    const capped = capAuditInputJson(oversized);
    // The marker is included inside the cap (not appended past it) so
    // the persisted value never exceeds the documented limit.
    expect(capped.length).toBe(SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS);
    expect(capped.endsWith("…[truncated]")).toBe(true);
  });

  test("preserves the prefix verbatim before the marker", () => {
    // Distinguish "wrote the marker" from "rewrote the prefix" — a
    // future regression that base64-encoded or otherwise transformed the
    // body before the cap would silently break compliance audits since
    // the persisted input would no longer match what the LLM saw.
    const prefix = "ABCDEFGH"; // 8-char distinguishable prefix
    const tail = "z".repeat(SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS);
    const capped = capAuditInputJson(prefix + tail);
    expect(capped.startsWith(prefix)).toBe(true);
  });
});

describe("countUtf8Bytes", () => {
  test("returns 0 for the empty string", () => {
    expect(countUtf8Bytes("")).toBe(0);
  });

  test("counts ASCII as 1 byte per character", () => {
    expect(countUtf8Bytes("hello")).toBe(5);
  });

  test("counts a 2-byte code point correctly", () => {
    // Latin-1 supplement (e.g. 'é' = U+00E9) is 2 bytes in UTF-8.
    expect(countUtf8Bytes("é")).toBe(2);
  });

  test("counts a 3-byte CJK character correctly", () => {
    // CJK Unified (e.g. '中' = U+4E2D) is 3 bytes in UTF-8.
    expect(countUtf8Bytes("中")).toBe(3);
  });

  test("counts a 4-byte surrogate-pair emoji correctly", () => {
    // '🚀' = U+1F680 is 4 bytes in UTF-8 (a surrogate pair in UTF-16).
    expect(countUtf8Bytes("🚀")).toBe(4);
  });

  test("matches TextEncoder for a mixed-script input", () => {
    // Round-trip parity with the standard library encoder pins the
    // bitwise math against the canonical implementation; if the
    // helper drifts, this case fails before tests that rely on
    // size-signal accuracy do.
    const mixed = 'ascii é 中 🚀 {"k":"v"}';
    expect(countUtf8Bytes(mixed)).toBe(new TextEncoder().encode(mixed).byteLength);
  });
});

describe("extractAuditMetadataFromToolOutput", () => {
  test("returns redactedFields from a success envelope", () => {
    const result = extractAuditMetadataFromToolOutput({
      ok: true,
      content: "irrelevant",
      redactedTypes: ["github_token", "aws_access_key"],
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.redactedFields).toEqual(["github_token", "aws_access_key"]);
  });

  test("returns empty redactedFields when the success envelope omits them", () => {
    // Some envelopes (a hypothetical future tool) might not surface
    // a `redactedTypes` array. The default must be `[]` (not
    // `undefined`) so the persisted schema's `v.array(v.string())`
    // contract is always satisfied.
    const result = extractAuditMetadataFromToolOutput({ ok: true, content: "x" });
    expect(result.errorCode).toBeUndefined();
    expect(result.redactedFields).toEqual([]);
  });

  test("returns the structured errorCode from an error envelope", () => {
    const result = extractAuditMetadataFromToolOutput({
      ok: false,
      errorCode: "path_outside_repo",
      message: "Path escapes the repository root.",
    });
    expect(result.errorCode).toBe("path_outside_repo");
    expect(result.redactedFields).toEqual([]);
  });

  test("falls back to a generic errorCode when ok=false but the field is missing", () => {
    // Defensive against a malformed envelope. Audit consumers always
    // need *something* to filter on for the error class; surfacing
    // `unknown_tool_error` is more useful than `undefined`.
    const result = extractAuditMetadataFromToolOutput({ ok: false });
    expect(result.errorCode).toBe("unknown_tool_error");
  });

  test.each([null, undefined, 42, "string", []] as const)("returns empty fields for non-object input %j", (input) => {
    const result = extractAuditMetadataFromToolOutput(input);
    expect(result.errorCode).toBeUndefined();
    expect(result.redactedFields).toEqual([]);
  });

  test("filters non-string entries out of redactedTypes (defense in depth)", () => {
    // A buggy upstream that puts numbers / objects into `redactedTypes`
    // must not leak them into the audit row, where the schema requires
    // `v.array(v.string())`. The helper drops malformed entries
    // silently — audit recording must never crash on a malformed
    // upstream payload.
    const result = extractAuditMetadataFromToolOutput({
      ok: true,
      redactedTypes: ["github_token", 42, { foo: "bar" }, "jwt"],
    });
    expect(result.redactedFields).toEqual(["github_token", "jwt"]);
  });
});

/**
 * Plan 12 — Mutation + retention coverage.
 *
 * Sets up a fixture that satisfies all the foreign-key references
 * (`threadId`, `messageId`, `sandboxId`) so the audit row has a
 * realistic shape. Tests assert:
 *
 *   1. The mutation writes every documented field.
 *   2. The persisted `inputJson` is capped server-side.
 *   3. `outputBytes` / `durationMs` are floored to non-negative
 *      integers.
 *   4. The `by_owner_and_time` and `by_message` indexes return rows in
 *      the contract-pinned order.
 *   5. The cleanup mutation deletes only rows past the 90-day window
 *      and self-reschedules when a full batch was drained.
 */
describe("sandboxToolCallLog mutation + retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("recordSandboxToolCallLogEntry writes every documented field", async () => {
    const ownerTokenIdentifier = "user|audit-record-shape";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-record-shape");

    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "read_file",
      inputJson: '{"path":"convex/chat/send.ts"}',
      outputBytes: 12_345,
      durationMs: 250,
      errorCode: undefined,
      redactedFields: ["github_token"],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "read_file",
      inputJson: '{"path":"convex/chat/send.ts"}',
      outputBytes: 12_345,
      durationMs: 250,
      redactedFields: ["github_token"],
    });
    // `errorCode` is optional and intentionally unset on success rows
    // so audit consumers can filter `errorCode === undefined` for the
    // "successful calls" view.
    expect(rows[0].errorCode).toBeUndefined();
  });

  test("recordSandboxToolCallLogEntry caps oversized inputJson at the documented limit", async () => {
    const ownerTokenIdentifier = "user|audit-record-cap";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-record-cap");

    const oversized = "x".repeat(SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS + 500);
    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "run_shell",
      inputJson: oversized,
      outputBytes: 0,
      durationMs: 0,
      redactedFields: [],
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .first(),
    );
    expect(row?.inputJson.length).toBe(SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS);
    expect(row?.inputJson.endsWith("…[truncated]")).toBe(true);
  });

  test("recordSandboxToolCallLogEntry floors negative or fractional numeric fields", async () => {
    // Defense-in-depth against a buggy upstream that passes
    // `durationMs: -1` or `outputBytes: 12.7`. Audit aggregations like
    // SUM(outputBytes) must not see negatives or non-integer values.
    const ownerTokenIdentifier = "user|audit-record-floor";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-record-floor");

    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "list_dir",
      inputJson: "{}",
      outputBytes: 12.7,
      durationMs: -5,
      redactedFields: [],
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .first(),
    );
    expect(row?.outputBytes).toBe(12);
    expect(row?.durationMs).toBe(0);
  });

  test("by_owner_and_time index returns entries in newest-first order for the same owner", async () => {
    // Pins the canonical audit query: "what did user X do, newest first".
    // We insert three rows with progressing creation times (forward-only
    // `vi.advanceTimersByTime` between inserts so each row picks up a
    // distinct `_creationTime`) and assert the descending order via
    // `.order("desc")`.
    const ownerTokenIdentifier = "user|audit-order";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-order");

    for (const toolName of ["read_file", "list_dir", "run_shell"] as const) {
      await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
        ownerTokenIdentifier,
        threadId: fixture.threadId,
        messageId: fixture.assistantMessageId,
        sandboxId: fixture.sandboxId,
        toolName,
        inputJson: "{}",
        outputBytes: 0,
        durationMs: 0,
        redactedFields: [],
      });
      vi.advanceTimersByTime(60_000);
    }

    const rowsDesc = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .order("desc")
        .collect(),
    );
    expect(rowsDesc.map((row) => row.toolName)).toEqual(["run_shell", "list_dir", "read_file"]);
  });

  test("by_owner_and_time index isolates rows per owner (cross-tenant fence)", async () => {
    // Audit recording must never leak across owners. A query for user
    // A must return only A's rows even when user B also recorded
    // entries against the same sandbox / message ids in a hypothetical
    // future shared-resource scenario.
    const ownerA = "user|audit-fence-a";
    const ownerB = "user|audit-fence-b";
    const t = convexTest(schema, modules);
    const fixtureA = await createAuditLogFixture(t, ownerA, "audit-fence-a");
    const fixtureB = await createAuditLogFixture(t, ownerB, "audit-fence-b");

    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier: ownerA,
      threadId: fixtureA.threadId,
      messageId: fixtureA.assistantMessageId,
      sandboxId: fixtureA.sandboxId,
      toolName: "read_file",
      inputJson: "{}",
      outputBytes: 0,
      durationMs: 0,
      redactedFields: [],
    });
    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier: ownerB,
      threadId: fixtureB.threadId,
      messageId: fixtureB.assistantMessageId,
      sandboxId: fixtureB.sandboxId,
      toolName: "run_shell",
      inputJson: "{}",
      outputBytes: 0,
      durationMs: 0,
      redactedFields: [],
    });

    const ownerARows = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerA))
        .collect(),
    );
    expect(ownerARows.map((row) => row.toolName)).toEqual(["read_file"]);
  });

  test("by_message index returns entries for a specific assistant message", async () => {
    const ownerTokenIdentifier = "user|audit-by-message";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-by-message");

    // Two calls under the same assistant message — the audit log keeps
    // them as distinct rows, both reachable via `by_message`.
    for (const toolName of ["read_file", "list_dir"]) {
      await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
        ownerTokenIdentifier,
        threadId: fixture.threadId,
        messageId: fixture.assistantMessageId,
        sandboxId: fixture.sandboxId,
        toolName,
        inputJson: "{}",
        outputBytes: 0,
        durationMs: 0,
        redactedFields: [],
      });
    }

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_message", (q) => q.eq("messageId", fixture.assistantMessageId))
        .collect(),
    );
    expect(rows.map((row) => row.toolName).sort()).toEqual(["list_dir", "read_file"]);
  });

  test("cleanupExpiredSandboxToolCallLogs deletes only rows past the retention window", async () => {
    const ownerTokenIdentifier = "user|audit-cleanup-window";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-cleanup-window");

    // The convex-test clock advances forward only — `vi.setSystemTime`
    // to an earlier timestamp does not rewind `_creationTime`. We use
    // `vi.advanceTimersByTime` (the same forward-only pattern existing
    // tests like `chat-history.test.ts` rely on) so each insert lands
    // at a known relative position on the timeline, and then run the
    // cleanup at the latest tick.
    //
    // Layout:
    //   - t = baseline:        insert "stale" row (lives at t = baseline)
    //   - t = baseline + 89d:  insert "fresh" row (will be 2d old at cleanup)
    //   - t = baseline + 91d:  run cleanup
    //     cutoff = (baseline + 91d) − 90d = baseline + 1d
    //     stale  _creationTime = baseline    < cutoff → delete
    //     fresh  _creationTime = baseline+89d > cutoff → keep
    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "stale-read_file",
      inputJson: "{}",
      outputBytes: 0,
      durationMs: 0,
      redactedFields: [],
    });
    vi.advanceTimersByTime(89 * 24 * 60 * 60_000);
    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "fresh-list_dir",
      inputJson: "{}",
      outputBytes: 0,
      durationMs: 0,
      redactedFields: [],
    });

    vi.advanceTimersByTime(2 * 24 * 60 * 60_000);
    const result = await t.mutation(internal.chat.sandboxToolCallLog.cleanupExpiredSandboxToolCallLogs, {});
    expect(result).toEqual({ deletedCount: 1, rescheduled: false });

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(remaining.map((row) => row.toolName)).toEqual(["fresh-list_dir"]);
  });

  test("cleanupExpiredSandboxToolCallLogs is a no-op when no rows are expired", async () => {
    const ownerTokenIdentifier = "user|audit-cleanup-noop";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-cleanup-noop");

    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "read_file",
      inputJson: "{}",
      outputBytes: 0,
      durationMs: 0,
      redactedFields: [],
    });

    const result = await t.mutation(internal.chat.sandboxToolCallLog.cleanupExpiredSandboxToolCallLogs, {});
    expect(result).toEqual({ deletedCount: 0, rescheduled: false });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("cleanupExpiredSandboxToolCallLogs self-reschedules when a full batch was drained", async () => {
    // Pins the documented backlog-drain contract: a batch full of
    // expired rows triggers a follow-up tick. We seed one more than
    // the batch size so the first tick deletes BATCH and reschedules.
    //
    // Same forward-only timeline pattern as the previous test: insert
    // all rows at the baseline, advance past the retention window, run
    // cleanup. All rows are then expired and the first tick must hit
    // the batch cap.
    const ownerTokenIdentifier = "user|audit-cleanup-batch";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-cleanup-batch");

    for (let i = 0; i < SANDBOX_TOOL_CALL_LOG_CLEANUP_BATCH_SIZE + 1; i += 1) {
      await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
        ownerTokenIdentifier,
        threadId: fixture.threadId,
        messageId: fixture.assistantMessageId,
        sandboxId: fixture.sandboxId,
        toolName: `read_file_${i}`,
        inputJson: "{}",
        outputBytes: 0,
        durationMs: 0,
        redactedFields: [],
      });
    }

    vi.advanceTimersByTime(91 * 24 * 60 * 60_000);
    const firstTick = await t.mutation(internal.chat.sandboxToolCallLog.cleanupExpiredSandboxToolCallLogs, {});
    expect(firstTick).toEqual({
      deletedCount: SANDBOX_TOOL_CALL_LOG_CLEANUP_BATCH_SIZE,
      rescheduled: true,
    });

    // The runtime fires the rescheduled mutation at delay 0; we run it
    // explicitly here so the test asserts the second-tick behaviour
    // without depending on the scheduler's deferral semantics. The
    // self-reschedule contract is "this would happen on the next
    // tick" — which we simulate.
    const secondTick = await t.mutation(internal.chat.sandboxToolCallLog.cleanupExpiredSandboxToolCallLogs, {});
    expect(secondTick).toEqual({ deletedCount: 1, rescheduled: false });

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  test("retention window is exactly the documented constant", () => {
    // Pin the policy so a future change to the retention duration
    // surfaces here as an explicit change rather than a silent drift.
    expect(SANDBOX_TOOL_CALL_LOG_RETENTION_MS).toBe(90 * 24 * 60 * 60_000);
  });

  test("audit log survives parent thread / message deletion (90-day TTL is the only cleanup path)", async () => {
    // Pins the design boundary documented in `sandboxToolCallLog.ts`:
    // the audit log is *not* drained on cascade-deletes. A user-
    // initiated thread or message delete must not erase the
    // compliance trail mid-window — only the time-based cron does.
    //
    // We simulate the parent deletion directly (the cascade paths
    // themselves are tested elsewhere) and assert the audit row is
    // still reachable by its `by_owner_and_time` index.
    const ownerTokenIdentifier = "user|audit-survives-cascade";
    const t = convexTest(schema, modules);
    const fixture = await createAuditLogFixture(t, ownerTokenIdentifier, "audit-survives-cascade");

    await t.mutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, {
      ownerTokenIdentifier,
      threadId: fixture.threadId,
      messageId: fixture.assistantMessageId,
      sandboxId: fixture.sandboxId,
      toolName: "read_file",
      inputJson: "{}",
      outputBytes: 0,
      durationMs: 0,
      redactedFields: [],
    });

    // Direct delete of the parent message + thread mimics what a
    // user-initiated cascade would do post-Plan-12 if it didn't
    // intentionally skip this table.
    await t.run(async (ctx) => {
      await ctx.db.delete(fixture.assistantMessageId);
      await ctx.db.delete(fixture.threadId);
    });

    const survivors = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
        .collect(),
    );
    expect(survivors).toHaveLength(1);
    expect(survivors[0].toolName).toBe("read_file");
  });
});

/**
 * Build a minimal fixture so the audit-log row's foreign-key references
 * (`threadId`, `messageId`, `sandboxId`) point at real rows. Mirrors the
 * shape used by `chat-streaming.test.ts:createStreamingFixture` but
 * trimmed to the columns Plan 12 actually needs.
 */
async function createAuditLogFixture(t: ReturnType<typeof convexTest>, ownerTokenIdentifier: string, slug: string) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${slug}`,
      sourceRepoFullName: `acme/${slug}`,
      sourceRepoOwner: "acme",
      sourceRepoName: slug,
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
    });

    const sandboxId: Id<"sandboxes"> = await ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId: `remote-${slug}`,
      status: "ready",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      ttlExpiresAt: Date.now() + 60 * 60_000,
      autoStopIntervalMinutes: 30,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 120,
      networkBlockAll: false,
    });

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier,
      title: `${slug} thread`,
      mode: "lab",
      lastMessageAt: Date.now(),
    });

    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier,
      threadId,
      kind: "chat",
      status: "running",
      stage: "generating_reply",
      progress: 0.5,
      costCategory: "system_design",
      triggerSource: "user",
      startedAt: Date.now(),
    });

    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier,
      role: "assistant",
      status: "streaming",
      mode: "lab",
      content: "",
    });

    return { repositoryId, sandboxId, threadId, jobId, assistantMessageId };
  });
}
