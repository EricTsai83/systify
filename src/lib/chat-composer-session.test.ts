import { describe, expect, test } from "vitest";
import {
  buildChatSendRequest,
  createComposerSessionState,
  getComposerSessionSnapshot,
  reduceComposerSession,
  resolveComposerModelRoute,
  resolveEffectiveGrounding,
  type ComposerGroundingAvailability,
  type ComposerSessionInputs,
} from "./chat-composer-session";
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

describe("composer session reducer", () => {
  test("seeds existing-thread grounding defaults after capabilities settle", () => {
    const loadingInputs = composerInputs({
      threadId,
      capabilitiesLoading: true,
      defaultGroundLibrary: true,
      defaultGroundSandbox: true,
    });
    const state = createComposerSessionState(loadingInputs);
    expect(getComposerSessionSnapshot({ state, inputs: loadingInputs })).toMatchObject({
      groundLibrary: false,
      groundSandbox: false,
    });

    const settledInputs = composerInputs({
      threadId,
      defaultGroundLibrary: true,
      defaultGroundSandbox: true,
    });
    const settled = reduceComposerSession(state, { type: "sync", inputs: settledInputs });
    expect(getComposerSessionSnapshot({ state: settled, inputs: settledInputs })).toMatchObject({
      groundLibrary: false,
      groundSandbox: true,
    });
  });

  test("keeps new-thread grounding mutually exclusive and does not carry it across repository switches", () => {
    const firstRepositoryInputs = composerInputs({ threadId: null });
    const selected = reduceComposerSession(
      reduceComposerSession(createComposerSessionState(firstRepositoryInputs), {
        type: "setGroundLibrary",
        value: true,
      }),
      {
        type: "setGroundSandbox",
        value: true,
      },
    );
    expect(getComposerSessionSnapshot({ state: selected, inputs: firstRepositoryInputs })).toMatchObject({
      groundLibrary: false,
      groundSandbox: true,
    });

    const nextRepositoryInputs = composerInputs({
      threadId: null,
      repositoryId: "repo_2" as RepositoryId,
    });
    const switched = reduceComposerSession(selected, { type: "sync", inputs: nextRepositoryInputs });
    expect(getComposerSessionSnapshot({ state: switched, inputs: nextRepositoryInputs })).toMatchObject({
      groundLibrary: false,
      groundSandbox: false,
    });
  });

  test("auto-clears disabled Library grounding", () => {
    const inputs = composerInputs({ threadId });
    const selected = reduceComposerSession(createComposerSessionState(inputs), {
      type: "setGroundLibrary",
      value: true,
    });
    const nextInputs = composerInputs({
      threadId,
      groundingAvailability: {
        library: { enabled: false, code: "library_no_artifact", message: "Generate at least one Design Doc first." },
        sandbox: { enabled: true },
      },
    });

    const state = reduceComposerSession(selected, { type: "sync", inputs: nextInputs });
    expect(getComposerSessionSnapshot({ state, inputs: nextInputs }).groundLibrary).toBe(false);
  });

  test("keeps activatable Sandbox selected and routes to sandbox scope", () => {
    const inputs = composerInputs({ threadId });
    const selected = reduceComposerSession(createComposerSessionState(inputs), {
      type: "setGroundSandbox",
      value: true,
    });
    const nextInputs = composerInputs({
      threadId,
      groundingAvailability: {
        library: { enabled: true },
        sandbox: {
          enabled: false,
          code: "sandbox_missing",
          message: "Sandbox will be prepared on send.",
          isActivatable: true,
        },
      },
    });

    const state = reduceComposerSession(selected, { type: "sync", inputs: nextInputs });
    expect(getComposerSessionSnapshot({ state, inputs: nextInputs })).toMatchObject({
      groundSandbox: true,
      route: { capability: "sandbox", preferenceScope: "sandbox" },
    });
  });

  test("auto-clears Sandbox only after viewer access resolves", () => {
    const inputs = composerInputs({ threadId });
    const selected = reduceComposerSession(createComposerSessionState(inputs), {
      type: "setGroundSandbox",
      value: true,
    });

    const loadingAccess = reduceComposerSession(selected, {
      type: "sync",
      inputs: composerInputs({
        threadId,
        accessResolved: false,
        sandboxGroundingDisabledReason: "Sandbox is not available.",
      }),
    });
    expect(getComposerSessionSnapshot({ state: loadingAccess, inputs }).groundSandbox).toBe(true);

    const resolvedInputs = composerInputs({
      threadId,
      accessResolved: true,
      sandboxGroundingDisabledReason: "Sandbox is not available.",
    });
    const resolvedAccess = reduceComposerSession(loadingAccess, { type: "sync", inputs: resolvedInputs });
    expect(getComposerSessionSnapshot({ state: resolvedAccess, inputs: resolvedInputs }).groundSandbox).toBe(false);
  });
});

function composerInputs(overrides: Partial<ComposerSessionInputs> = {}): ComposerSessionInputs {
  return {
    threadId: null,
    repositoryId,
    surface: "repository",
    mode: "discuss",
    capabilitiesLoading: false,
    defaultGroundLibrary: false,
    defaultGroundSandbox: false,
    groundingAvailability: enabledGrounding(),
    accessResolved: true,
    ...overrides,
  };
}

function enabledGrounding(): ComposerGroundingAvailability {
  return {
    library: { enabled: true },
    sandbox: { enabled: true },
  };
}
