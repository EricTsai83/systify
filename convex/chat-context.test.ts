/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("chat reply context", () => {
  test("loads viewer customization for the queued reply", async () => {
    const ownerTokenIdentifier = "user|customization-context";
    const t = convexTest(schema, modules);

    const { threadId, userMessageId } = await t.run(async (ctx) => {
      await ctx.db.insert("userPreferences", {
        ownerTokenIdentifier,
        traits: ["Direct", "Technical"],
        customInstructions: "Prefer explicit failure modes.",
        customizationUpdatedAt: Date.now(),
      });
      const threadId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Customization context",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const userMessageId = await ctx.db.insert("messages", {
        ownerTokenIdentifier,
        threadId,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "How should we design this?",
      });
      return { threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.customization).toEqual({
      traits: ["Direct", "Technical"],
      customInstructions: "Prefer explicit failure modes.",
    });
  });

  test("discuss with Sandbox grounding returns a live-source prepare intent without raw context files", async () => {
    // Sandbox grounding is LLM-driven retrieval — the model runs `read_file`
    // / `list_dir` against the live sandbox via tools. The context query
    // should seed the preparation intent only; it must not preload repo
    // chunks, artifacts, or a ready sandbox-tooling snapshot.
    const ownerTokenIdentifier = "user|sandbox-context";
    const t = convexTest(schema, modules);

    const { repositoryId, threadId, userMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/sandbox-context-repo",
        sourceRepoFullName: "acme/sandbox-context-repo",
        sourceRepoOwner: "acme",
        sourceRepoName: "sandbox-context-repo",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });

      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Sandbox context thread",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      const latestJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const latestImportId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/sandbox-context-repo",
        branch: "main",
        adapterKind: "git_clone",
        status: "completed",
        jobId: latestJobId,
      });
      // Chunks would have been loaded under the old behavior — seed one
      // so the assertion that they are NOT loaded is non-trivial.
      const latestFileId = await ctx.db.insert("repoFiles", {
        repositoryId,
        ownerTokenIdentifier,
        importId: latestImportId,
        path: "src/current.ts",
        parentPath: "src",
        fileType: "file",
        extension: "ts",
        language: "typescript",
        sizeBytes: 128,
        isEntryPoint: true,
        isConfig: false,
        isImportant: true,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        ownerTokenIdentifier,
        importId: latestImportId,
        fileId: latestFileId,
        path: "src/current.ts",
        chunkIndex: 0,
        startLine: 1,
        endLine: 5,
        chunkKind: "code",
        summary: "Should not appear",
        content: "const value = 1;",
      });

      // Control row — sandbox mode no longer pre-loads any artifact
      // documents; design context is read on demand via tools.
      await ctx.db.insert("artifacts", {
        repositoryId,
        jobId: latestJobId,
        ownerTokenIdentifier,
        kind: "architecture_diagram",
        title: "Diagram (excluded)",
        summary: "Excluded by sandbox-mode artifact filter",
        contentMarkdown: "graph TD;A-->B;",
        version: 1,
      });
      await ctx.db.patch(repositoryId, {
        latestImportId,
        latestImportJobId: latestJobId,
      });

      const userMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        groundSandbox: true,
        content: "What does the latest source tree look like?",
      });

      return { repositoryId, threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.grounding.flags).toEqual({ groundLibrary: false, groundSandbox: true });
    expect(context.grounding.repository).toMatchObject({
      repositoryId,
      sourceRepoFullName: "acme/sandbox-context-repo",
    });
    expect(context.grounding.artifactEvidence).toEqual({ kind: "none" });
    expect(context.grounding.liveSource).toEqual({
      kind: "prepare",
      repositoryId,
      ownerTokenIdentifier,
    });
    expect(context).not.toHaveProperty("artifacts");
    expect(context).not.toHaveProperty("artifactChunks");
    expect(context).not.toHaveProperty("chunks");
    expect(context).not.toHaveProperty("sandboxTooling");
  });

  test("sandbox grounding stays a prepare intent even when a ready sandbox row exists", async () => {
    const ownerTokenIdentifier = "user|sandbox-tooling-ready";
    const t = convexTest(schema, modules);

    const { repositoryId, threadId, userMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/tooling-ready",
        sourceRepoFullName: "acme/tooling-ready",
        sourceRepoOwner: "acme",
        sourceRepoName: "tooling-ready",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });

      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-tool-ready",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 1440,
        networkBlockAll: false,
      });
      await ctx.db.patch(repositoryId, { latestSandboxId: sandboxId });

      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Tooling thread",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const userMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        groundSandbox: true,
        content: "Read the entrypoint.",
      });

      return { repositoryId, threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.grounding.liveSource).toEqual({
      kind: "prepare",
      repositoryId,
      ownerTokenIdentifier,
    });
    expect(context.grounding.liveSource).not.toHaveProperty("readyHint");
    expect(context).not.toHaveProperty("sandboxTooling");
  });

  test("ungrounded Discuss on a repository-less thread returns no repository grounding", async () => {
    const ownerTokenIdentifier = "user|repo-less-thread";
    const t = convexTest(schema, modules);

    const { threadId, userMessageId } = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Design conversation",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const userMessageId = await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "Open-ended question.",
      });
      return { threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.grounding.repository).toBeNull();
    expect(context.grounding.artifactEvidence).toEqual({ kind: "none" });
    expect(context.grounding.liveSource).toEqual({ kind: "none" });
    expect(context).not.toHaveProperty("artifacts");
    expect(context).not.toHaveProperty("chunks");
  });

  test("Library mode returns pending artifact retrieval and skips raw indexed code chunks", async () => {
    const ownerTokenIdentifier = "user|docs-artifact-only";
    const t = convexTest(schema, modules);

    const { threadId, userMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/docs-mode",
        sourceRepoFullName: "acme/docs-mode",
        sourceRepoOwner: "acme",
        sourceRepoName: "docs-mode",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });

      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Docs thread",
        mode: "library",
        lastMessageAt: Date.now(),
      });

      const importJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/docs-mode",
        branch: "main",
        adapterKind: "git_clone",
        status: "completed",
        jobId: importJobId,
      });
      const fileId = await ctx.db.insert("repoFiles", {
        repositoryId,
        ownerTokenIdentifier,
        importId,
        path: "src/engine.ts",
        parentPath: "src",
        fileType: "file",
        extension: "ts",
        language: "typescript",
        sizeBytes: 128,
        isEntryPoint: false,
        isConfig: false,
        isImportant: true,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        ownerTokenIdentifier,
        importId,
        fileId,
        path: "src/engine.ts",
        chunkIndex: 0,
        startLine: 1,
        endLine: 3,
        chunkKind: "code",
        summary: "engine internals",
        content: 'export const engine = () => "hot path";',
      });

      await ctx.db.insert("artifacts", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        kind: "architecture_diagram",
        title: "Architecture diagram",
        summary: "Module boundaries",
        contentMarkdown: "graph TD\nA-->B",
        version: 1,
      });
      const userMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "library",
        content: "What did we already decide about architecture?",
      });

      await ctx.db.patch(repositoryId, {
        latestImportId: importId,
        latestImportJobId: importJobId,
      });

      return { threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });
    expect(context.grounding.repository).toMatchObject({
      sourceRepoFullName: "acme/docs-mode",
    });
    expect(context.grounding.artifactEvidence).toEqual({ kind: "pending_retrieval" });
    expect(context.grounding.liveSource).toEqual({ kind: "none" });
    expect(context).not.toHaveProperty("artifactChunks");
    expect(context).not.toHaveProperty("chunks");
  });

  test("Discuss with Library grounding returns pending artifact retrieval", async () => {
    const ownerTokenIdentifier = "user|discuss-library-grounding";
    const t = convexTest(schema, modules);

    const { repositoryId, threadId, userMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/discuss-library-grounding",
        sourceRepoFullName: "acme/discuss-library-grounding",
        sourceRepoOwner: "acme",
        sourceRepoName: "discuss-library-grounding",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });
      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Discuss library grounding",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const userMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        groundLibrary: true,
        content: "Use the library evidence.",
      });
      return { repositoryId, threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.grounding.flags).toEqual({ groundLibrary: true, groundSandbox: false });
    expect(context.grounding.repository?.repositoryId).toBe(repositoryId);
    expect(context.grounding.artifactEvidence).toEqual({ kind: "pending_retrieval" });
    expect(context.grounding.liveSource).toEqual({ kind: "none" });
  });

  test("Discuss with both grounding axes returns artifact and live-source intents", async () => {
    const ownerTokenIdentifier = "user|discuss-both-grounding";
    const t = convexTest(schema, modules);

    const { repositoryId, threadId, userMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/discuss-both-grounding",
        sourceRepoFullName: "acme/discuss-both-grounding",
        sourceRepoOwner: "acme",
        sourceRepoName: "discuss-both-grounding",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });
      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Discuss both grounding",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const userMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        groundLibrary: true,
        groundSandbox: true,
        content: "Use both evidence sources.",
      });
      return { repositoryId, threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.grounding.flags).toEqual({ groundLibrary: true, groundSandbox: true });
    expect(context.grounding.repository?.repositoryId).toBe(repositoryId);
    expect(context.grounding.artifactEvidence).toEqual({ kind: "pending_retrieval" });
    expect(context.grounding.liveSource).toEqual({
      kind: "prepare",
      repositoryId,
      ownerTokenIdentifier,
    });
  });

  test("discuss mode returns no repo context even when a repository is attached", async () => {
    const ownerTokenIdentifier = "user|discuss-with-repo";
    const t = convexTest(schema, modules);

    const { threadId, userMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/discuss-mode",
        sourceRepoFullName: "acme/discuss-mode",
        sourceRepoOwner: "acme",
        sourceRepoName: "discuss-mode",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
        summary: "rich repository summary",
        readmeSummary: "readme",
        architectureSummary: "architecture",
      });

      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Discuss with repo",
        // discuss is "no repo, no sandbox" by design — even with a
        // repository attached the reply context must skip every
        // repo-scoped lookup so this conversation stays training-only.
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      const importJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/discuss-mode",
        branch: "main",
        adapterKind: "git_clone",
        status: "completed",
        jobId: importJobId,
      });
      const fileId = await ctx.db.insert("repoFiles", {
        repositoryId,
        ownerTokenIdentifier,
        importId,
        path: "src/engine.ts",
        parentPath: "src",
        fileType: "file",
        extension: "ts",
        language: "typescript",
        sizeBytes: 128,
        isEntryPoint: false,
        isConfig: false,
        isImportant: true,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        ownerTokenIdentifier,
        importId,
        fileId,
        path: "src/engine.ts",
        chunkIndex: 0,
        startLine: 1,
        endLine: 3,
        chunkKind: "code",
        summary: "engine internals",
        content: 'export const engine = () => "hot path";',
      });
      await ctx.db.insert("artifacts", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        kind: "architecture_diagram",
        title: "Architecture diagram",
        summary: "Module boundaries",
        contentMarkdown: "graph TD\nA-->B",
        version: 1,
      });
      const userMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "Let's brainstorm.",
      });

      await ctx.db.patch(repositoryId, {
        latestImportId: importId,
        latestImportJobId: importJobId,
      });

      return { threadId, userMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.grounding.repository).toBeNull();
    expect(context.grounding.artifactEvidence).toEqual({ kind: "none" });
    expect(context.grounding.liveSource).toEqual({ kind: "none" });
    expect(context).not.toHaveProperty("artifacts");
    expect(context).not.toHaveProperty("chunks");
    // Messages are still returned so the model can see the conversation.
    expect(context.messages.map((message) => message.content)).toEqual(["Let's brainstorm."]);
  });

  test("anchors effective mode to the queued user message, not the latest message in the window", async () => {
    // Race-condition guard: if a second user message lands between queueing
    // an assistant reply and running it, "the latest user message in the
    // window" would silently take over the mode (and the search query),
    // making the assistant answer message A's content with message B's
    // mode prompt. `getReplyContext` must instead anchor both to the
    // explicit `userMessageId` it receives.
    const ownerTokenIdentifier = "user|race-mode-anchor";
    const t = convexTest(schema, modules);

    const { threadId, queuedUserMessageId } = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Mode anchoring",
        // Thread default disagrees with both messages so the test can
        // distinguish "anchored to queued message" (`docs`) from "fell
        // back to thread.mode" (`discuss`).
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      const queuedUserMessageId = await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "library",
        content: "Question pinned to docs mode.",
      });

      // Newer user message lands after queueing, before generation runs.
      // Picking it would make the test fail with mode === "discuss".
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "Newer message, different mode.",
      });

      return { threadId, queuedUserMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, {
      threadId,
      userMessageId: queuedUserMessageId,
    });

    expect(context.mode).toBe("library");
  });

  // NOTE: there is no per-mode chunk-search code path (sandbox is
  // tool-driven, docs is artifact-only, discuss returns early). The
  // race-condition guard against "search query anchored to the wrong
  // user message" therefore has no code path to defend; the companion
  // mode-anchoring test above (`anchors effective mode to the queued
  // user message`) still covers the queue-anchor invariant for the
  // surviving mode/system-prompt derivation. If a future change adds
  // per-mode chunk pre-selection, this guard should be reinstated
  // against that code path.

  test("rejects a userMessageId that does not belong to the requested thread", async () => {
    // Cross-thread protection: even if a caller somehow constructs a
    // `userMessageId` from another thread, the query must refuse rather
    // than silently anchor to that foreign mode/content.
    const ownerTokenIdentifier = "user|cross-thread-reject";
    const t = convexTest(schema, modules);

    const { threadAId, threadBUserMessageId } = await t.run(async (ctx) => {
      const threadAId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Thread A",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const threadBId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Thread B",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const threadBUserMessageId = await ctx.db.insert("messages", {
        threadId: threadBId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "Belongs to thread B.",
      });
      return { threadAId, threadBUserMessageId };
    });

    await expect(
      t.query(internal.chat.context.getReplyContext, {
        threadId: threadAId,
        userMessageId: threadBUserMessageId,
      }),
    ).rejects.toThrow(/queued user message not found/i);
  });

  test("Library Ask anchors explicit artifact scope on pending retrieval", async () => {
    // Scoped Library Ask should carry the selected artifact ids as retrieval
    // intent. The query does not expose raw artifact documents; hydration
    // turns these ids into prompt evidence and a citation map later.
    const ownerTokenIdentifier = "user|docs-id-exposure";
    const t = convexTest(schema, modules);

    const { threadId, userMessageId, expectedArtifactId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/docs-id-exposure",
        sourceRepoFullName: "acme/docs-id-exposure",
        sourceRepoOwner: "acme",
        sourceRepoName: "docs-id-exposure",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });

      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Docs id thread",
        mode: "library",
        lastMessageAt: Date.now(),
      });

      const expectedArtifactId = await ctx.db.insert("artifacts", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        kind: "architecture_diagram",
        title: "Architecture diagram",
        summary: "Module boundaries",
        contentMarkdown: "graph TD\nA-->B",
        version: 1,
      });
      await ctx.db.patch(threadId, { artifactContext: [expectedArtifactId] });

      const userMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "library",
        content: "Where is the boundary between A and B?",
      });

      return { threadId, userMessageId, expectedArtifactId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, { threadId, userMessageId });

    expect(context.grounding.artifactEvidence).toEqual({
      kind: "pending_retrieval",
      artifactScope: [expectedArtifactId],
    });
    expect(context).not.toHaveProperty("artifacts");
  });

  test("rejects a userMessageId that points to an assistant message", async () => {
    // Role guard: assistant messages have a `mode` column too (the mode
    // they were produced under), but anchoring to one would mean
    // generating a "reply to a reply", which is meaningless.
    const ownerTokenIdentifier = "user|role-guard";
    const t = convexTest(schema, modules);

    const { threadId, assistantMessageId } = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Role guard",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      const assistantMessageId = await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "discuss",
        content: "Assistant text.",
      });
      return { threadId, assistantMessageId };
    });

    await expect(
      t.query(internal.chat.context.getReplyContext, {
        threadId,
        userMessageId: assistantMessageId,
      }),
    ).rejects.toThrow(/queued user message not found/i);
  });

  test("hides cross-mode assistant replies from the LLM context while keeping every user turn", async () => {
    // When the user switches modes mid-thread, the previous mode's
    // assistant answer (e.g. an unattached `discuss` hypothetical) must not
    // bleed into the new mode's prompt — the model would otherwise treat
    // that hypothetical as ground truth for the new mode's reply.
    // User turns (every role except `assistant`) are kept regardless of mode
    // so the conversational continuity the user expects ("you remember what
    // I asked before, right?") survives the switch.
    const ownerTokenIdentifier = "user|cross-mode-filter";
    const t = convexTest(schema, modules);

    const { threadId, libraryUserMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/cross-mode-filter",
        sourceRepoFullName: "acme/cross-mode-filter",
        sourceRepoOwner: "acme",
        sourceRepoName: "cross-mode-filter",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });
      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Cross-mode thread",
        // Thread default `discuss` is irrelevant once each row carries its
        // own `mode` — `getReplyContext` anchors `effectiveMode` to the
        // queued user message, not to the thread row.
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      // Round 1 — `discuss`: user asks, assistant answers from training.
      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "What is a design pattern?",
      });
      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "discuss",
        content: "Design patterns are reusable solutions to common problems.",
      });

      // Round 2 — `library`: user follows up under a new mode. This is the
      // queued reply.
      const libraryUserMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "library",
        content: "How do we implement the factory pattern in this repo?",
      });
      // A prior `library` reply from earlier in the thread (here we model it
      // as the same round; in practice it would be the previous turn). It
      // must survive the cross-mode filter because it shares the queued
      // mode.
      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "library",
        content: "Earlier library-mode answer.",
      });

      return { threadId, libraryUserMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, {
      threadId,
      userMessageId: libraryUserMessageId,
    });

    // User turns survive across the mode switch — both `discuss` and
    // `library` user messages remain visible to the model.
    const userMessages = context.messages.filter((message) => message.role === "user");
    expect(userMessages.map((message) => message.content)).toEqual([
      "What is a design pattern?",
      "How do we implement the factory pattern in this repo?",
    ]);

    // Assistant turns are mode-scoped: the `discuss` answer is dropped, the
    // `library` answer stays.
    const assistantMessages = context.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.map((message) => message.content)).toEqual(["Earlier library-mode answer."]);
  });

  test("keeps every assistant turn when the thread never switches modes", async () => {
    // Sanity check / regression guard: same-mode threads must not lose any
    // turn just because the cross-mode filter is now in the path. A
    // refactor that accidentally compares `effectiveMode` against
    // `thread.mode` instead of `message.mode` would still pass the
    // cross-mode test above, but would silently drop assistant rows here.
    const ownerTokenIdentifier = "user|same-mode-preserve";
    const t = convexTest(schema, modules);

    const { threadId, userMessageId } = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Same mode thread",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      const turns: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
        { role: "assistant", content: "Second answer" },
        { role: "user", content: "Third question" },
      ];
      let queuedId: Id<"messages"> | undefined;
      for (const turn of turns) {
        const messageId = await ctx.db.insert("messages", {
          threadId,
          ownerTokenIdentifier,
          role: turn.role,
          status: "completed",
          mode: "discuss",
          content: turn.content,
        });
        if (turn.role === "user") {
          queuedId = messageId;
        }
      }
      if (!queuedId) {
        throw new Error("seed produced no user message");
      }

      return { threadId, userMessageId: queuedId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, {
      threadId,
      userMessageId,
    });

    expect(context.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Second answer" },
      { role: "user", content: "Third question" },
    ]);
  });

  test("over-fetches past stale cross-mode rows to keep the LLM-context window near the cap", async () => {
    // Robustness boundary: when many recent rows are stale cross-mode
    // assistant replies, a naive `take(MAX_CONTEXT_MESSAGES)` followed by
    // filtering would shrink the LLM-context window to a handful of
    // messages. The bounded over-fetch in `loadReplyContextMessages` keeps
    // the post-filter survivor count at or near the cap by reading
    // `MAX_CONTEXT_MESSAGES * REPLY_CONTEXT_OVERFETCH_FACTOR` rows from
    // the index — invisible to callers, but the difference shows up here.
    //
    // Layout:
    //   - 18 stale `discuss` assistant rows (oldest)
    //   - 1 alternating user/assistant pair in `library` (so the queued
    //     mode has a non-trivial recent history of its own)
    //   - The queued `library` user message (newest)
    //
    // Total raw rows: 21. Naive `take(20)` would drop the oldest stale
    // row but keep 17 stale ones; after the cross-mode filter we'd have
    // ~4 messages. With over-fetch, all 21 raw rows are scanned, the 18
    // stale ones are dropped, and the 3 queued-mode rows survive — exactly
    // the conversational window the user expects to preserve.
    const ownerTokenIdentifier = "user|cross-mode-overfetch";
    const t = convexTest(schema, modules);

    const { threadId, queuedUserMessageId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/cross-mode-overfetch",
        sourceRepoFullName: "acme/cross-mode-overfetch",
        sourceRepoOwner: "acme",
        sourceRepoName: "cross-mode-overfetch",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });
      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Cross-mode over-fetch thread",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      // 18 stale `discuss` assistant rows. Raw rows alone would crowd out
      // the queued-mode history under naive `take(MAX_CONTEXT_MESSAGES)`.
      for (let index = 0; index < 18; index += 1) {
        await ctx.db.insert("messages", {
          repositoryId,
          threadId,
          ownerTokenIdentifier,
          role: "assistant",
          status: "completed",
          mode: "discuss",
          content: `Stale discuss reply ${index}`,
        });
      }

      // Earlier `library` round (user + assistant) before the queued one.
      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "library",
        content: "Earlier library question.",
      });
      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "library",
        content: "Earlier library answer.",
      });

      const queuedUserMessageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "library",
        content: "Queued library question.",
      });

      return { threadId, queuedUserMessageId };
    });

    const context = await t.query(internal.chat.context.getReplyContext, {
      threadId,
      userMessageId: queuedUserMessageId,
    });

    // The 18 stale `discuss` assistant rows are filtered out; the 3
    // library-mode rows remain, in ascending creation order.
    expect(context.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "Earlier library question." },
      { role: "assistant", content: "Earlier library answer." },
      { role: "user", content: "Queued library question." },
    ]);
  });
});
