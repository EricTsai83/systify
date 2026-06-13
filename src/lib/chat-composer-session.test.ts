import { describe, expect, test } from "vitest";
import { buildChatSendRequest, resolveComposerModelRoute, resolveEffectiveGrounding } from "./chat-composer-session";
import type { ArtifactId, RepositoryId, ThreadId } from "@/lib/types";

const repositoryId = "repo_1" as RepositoryId;
const threadId = "thread_1" as ThreadId;
const artifactId = "artifact_1" as ArtifactId;

describe("resolveComposerModelRoute", () => {
  test("routes repository Discuss without Sandbox to discuss scope", () => {
    expect(resolveComposerModelRoute({ surface: "repository", mode: "discuss", groundSandbox: false })).toEqual({
      capability: "discuss",
      preferenceScope: "discuss",
    });
  });

  test("routes repository Discuss with Sandbox to sandbox scope", () => {
    expect(resolveComposerModelRoute({ surface: "repository", mode: "discuss", groundSandbox: true })).toEqual({
      capability: "sandbox",
      preferenceScope: "sandbox",
    });
  });

  test("routes repository Library to library scope", () => {
    expect(resolveComposerModelRoute({ surface: "repository", mode: "library", groundSandbox: true })).toEqual({
      capability: "library",
      preferenceScope: "library",
    });
  });

  test("routes repoless chat to chat preference scope", () => {
    expect(resolveComposerModelRoute({ surface: "repoless", mode: "discuss", groundSandbox: true })).toEqual({
      capability: "discuss",
      preferenceScope: "chat",
    });
  });
});

describe("buildChatSendRequest", () => {
  test("shapes an existing-thread request", () => {
    expect(
      buildChatSendRequest({
        selectedThreadId: threadId,
        repositoryId,
        mode: "discuss",
        content: "Explain the architecture",
        groundLibrary: true,
        groundSandbox: false,
        provider: "openai",
        modelName: "gpt-test",
        reasoningEffort: "high",
      }),
    ).toEqual({
      kind: "existingThread",
      args: {
        threadId,
        content: "Explain the architecture",
        mode: "discuss",
        groundLibrary: true,
        groundSandbox: false,
        provider: "openai",
        modelName: "gpt-test",
        reasoningEffort: "high",
      },
    });
  });

  test("shapes a new repository thread request", () => {
    expect(
      buildChatSendRequest({
        selectedThreadId: null,
        repositoryId,
        mode: "library",
        content: "Summarize the library",
        newThreadTitle: "Library Ask",
        newThreadArtifactContext: [artifactId],
      }),
    ).toEqual({
      kind: "newThread",
      args: {
        repositoryId,
        content: "Summarize the library",
        mode: "library",
        title: "Library Ask",
        artifactContext: [artifactId],
      },
    });
  });

  test("shapes a new repoless Agent thread request", () => {
    expect(
      buildChatSendRequest({
        selectedThreadId: null,
        repositoryId: null,
        mode: "discuss",
        content: "Translate this",
        newThreadSingleTurnEnabled: true,
        newThreadAgentEnabled: true,
        newThreadAgentRole: "Translator",
        newThreadAgentInstructions: "Translate Chinese into English.",
      }),
    ).toEqual({
      kind: "newThread",
      args: {
        content: "Translate this",
        mode: "discuss",
        groundLibrary: false,
        groundSandbox: false,
        singleTurnEnabled: true,
        agentEnabled: true,
        agentRole: "Translator",
        agentInstructions: "Translate Chinese into English.",
      },
    });
  });

  test("omits grounding outside Discuss", () => {
    const request = buildChatSendRequest({
      selectedThreadId: threadId,
      repositoryId,
      mode: "library",
      content: "Ask",
      groundLibrary: true,
      groundSandbox: true,
    });

    expect(request?.args).not.toHaveProperty("groundLibrary");
    expect(request?.args).not.toHaveProperty("groundSandbox");
  });

  test("omits incomplete model pairs and unset reasoning effort", () => {
    expect(
      buildChatSendRequest({
        selectedThreadId: threadId,
        repositoryId,
        mode: "discuss",
        content: "Ask",
        provider: "openai",
        modelName: null,
        reasoningEffort: null,
      })?.args,
    ).toEqual({
      threadId,
      content: "Ask",
      mode: "discuss",
      groundLibrary: false,
      groundSandbox: false,
    });
  });
});

describe("resolveEffectiveGrounding", () => {
  test("keeps activatable Sandbox selectable", () => {
    const grounding = resolveEffectiveGrounding({
      groundingAvailability: {
        library: { enabled: true },
        sandbox: {
          enabled: false,
          code: "sandbox_missing",
          message: "Live source will be prepared when needed.",
          isActivatable: true,
        },
      },
    });

    expect(grounding.sandbox).toMatchObject({ enabled: false, isActivatable: true });
  });

  test("applies viewer-access Sandbox lock", () => {
    const grounding = resolveEffectiveGrounding({
      groundingAvailability: {
        library: { enabled: true },
        sandbox: { enabled: true },
      },
      sandboxGroundingDisabledReason: "Sandbox is not available.",
    });

    expect(grounding.sandbox).toEqual({
      enabled: false,
      code: "feature_not_included",
      message: "Sandbox is not available.",
      isActivatable: false,
    });
  });
});
