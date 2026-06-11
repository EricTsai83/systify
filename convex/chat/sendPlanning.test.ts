import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { normalizeModelPreferences } from "../lib/userPreferences";
import { CHAT_MESSAGE_MAX_CHARS, completeChatTurnPlan, planChatTurnMode, trimChatMessageContent } from "./sendPlanning";

const repositoryId = "repository_send_planning" as unknown as Id<"repositories">;
const emptyModelPreferences = normalizeModelPreferences(null);

function expectConvexErrorCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ConvexError);
  expect((caught as { data?: { code?: string } }).data?.code).toBe(code);
}

describe("trimChatMessageContent", () => {
  test("trims content once for both send mutations", () => {
    expect(trimChatMessageContent("  hello  ")).toBe("hello");
  });

  test("rejects empty content", () => {
    expect(() => trimChatMessageContent(" \n\t ")).toThrow(/cannot be empty/i);
  });

  test("rejects oversized content before queueing", () => {
    expect(() => trimChatMessageContent("x".repeat(CHAT_MESSAGE_MAX_CHARS + 1))).toThrow(
      `Message content must be at most ${CHAT_MESSAGE_MAX_CHARS} characters.`,
    );
  });
});

describe("planChatTurnMode", () => {
  test("coerces stale grounding flags off for Library mode", () => {
    const plan = planChatTurnMode({
      repositoryId,
      mode: "library",
      requestedGrounding: { groundLibrary: true, groundSandbox: true },
    });

    expect(plan).toMatchObject({
      mode: "library",
      groundLibrary: false,
      groundSandbox: false,
      modelPreferenceScope: "library",
    });
  });

  test("uses the chat preference scope for repoless ungrounded Discuss", () => {
    const plan = planChatTurnMode({
      repositoryId: null,
      mode: "discuss",
      requestedGrounding: {},
    });

    expect(plan).toMatchObject({
      mode: "discuss",
      groundLibrary: false,
      groundSandbox: false,
      modelPreferenceScope: "chat",
    });
  });

  test("uses the sandbox preference scope when Discuss asks for sandbox grounding", () => {
    const plan = planChatTurnMode({
      repositoryId,
      mode: "discuss",
      requestedGrounding: { groundSandbox: true },
    });

    expect(plan).toMatchObject({
      mode: "discuss",
      groundLibrary: false,
      groundSandbox: true,
      modelPreferenceScope: "sandbox",
    });
  });
});

describe("completeChatTurnPlan", () => {
  test("resolves Library mode with stale grounding flags to the library model tier", () => {
    const modePlan = planChatTurnMode({
      repositoryId,
      mode: "library",
      requestedGrounding: { groundSandbox: true },
    });

    const plan = completeChatTurnPlan({
      modePlan,
      modelPreferences: emptyModelPreferences,
      picker: {},
    });

    expect(plan).toMatchObject({
      mode: "library",
      groundSandbox: false,
      provider: "openai",
      modelName: "gpt-5.4-mini",
      reasoningEffort: "low",
    });
  });

  test("resolves sandbox-grounded Discuss to the sandbox model tier", () => {
    const modePlan = planChatTurnMode({
      repositoryId,
      mode: "discuss",
      requestedGrounding: { groundSandbox: true },
    });

    const plan = completeChatTurnPlan({
      modePlan,
      modelPreferences: emptyModelPreferences,
      picker: {},
    });

    expect(plan).toMatchObject({
      mode: "discuss",
      groundSandbox: true,
      provider: "openai",
      modelName: "gpt-5.5",
      reasoningEffort: "medium",
    });
  });

  test("falls back to the first enabled scope model when the capability default is disabled", () => {
    const modePlan = planChatTurnMode({ repositoryId, mode: "discuss" });
    const modelPreferences = normalizeModelPreferences({
      scopedModelPreferences: {
        discuss: {
          disabledModels: [{ provider: "openai", modelName: "gpt-5.4-mini" }],
        },
      },
    });

    const plan = completeChatTurnPlan({
      modePlan,
      modelPreferences,
      picker: {},
    });

    expect(plan).toMatchObject({
      provider: "openai",
      modelName: "gpt-5.5",
    });
    expect(plan.reasoningEffort).toBe("medium");
  });

  test("respects the thread provider lock when falling back from a disabled default", () => {
    const modePlan = planChatTurnMode({ repositoryId, mode: "discuss" });
    const modelPreferences = normalizeModelPreferences({
      scopedModelPreferences: {
        discuss: {
          disabledModels: [{ provider: "openai", modelName: "gpt-5.4-mini" }],
        },
      },
    });

    const plan = completeChatTurnPlan({
      modePlan,
      modelPreferences,
      picker: {},
      threadDefaults: { lockedProvider: "openai" },
    });

    expect(plan).toMatchObject({
      provider: "openai",
      modelName: "gpt-5.5",
    });
  });

  test("rejects half-set picker pairs", () => {
    const modePlan = planChatTurnMode({ repositoryId, mode: "discuss" });

    expectConvexErrorCode(
      () =>
        completeChatTurnPlan({
          modePlan,
          modelPreferences: emptyModelPreferences,
          picker: { provider: "openai" },
        }),
      "incomplete_model_pick",
    );
  });

  test("rejects picker models disabled for the resolved preference scope", () => {
    const modePlan = planChatTurnMode({ repositoryId, mode: "library" });
    const modelPreferences = normalizeModelPreferences({
      scopedModelPreferences: {
        library: {
          disabledModels: [{ provider: "openai", modelName: "gpt-5.4-mini" }],
        },
      },
    });

    expectConvexErrorCode(
      () =>
        completeChatTurnPlan({
          modePlan,
          modelPreferences,
          picker: { provider: "openai", modelName: "gpt-5.4-mini" },
        }),
      "unsupported_model",
    );
  });

  test("accepts any enabled user-pickable model for the resolved preference scope", () => {
    const modePlan = planChatTurnMode({
      repositoryId,
      mode: "library",
    });

    const plan = completeChatTurnPlan({
      modePlan,
      modelPreferences: emptyModelPreferences,
      picker: { provider: "openai", modelName: "gpt-5.5" },
    });

    expect(plan).toMatchObject({
      mode: "library",
      provider: "openai",
      modelName: "gpt-5.5",
    });
  });

  test("rejects picks outside the thread provider lock", () => {
    const modePlan = planChatTurnMode({ repositoryId, mode: "discuss" });

    expectConvexErrorCode(
      () =>
        completeChatTurnPlan({
          modePlan,
          modelPreferences: emptyModelPreferences,
          picker: { provider: "anthropic", modelName: "claude-haiku-4-5" },
          threadDefaults: { lockedProvider: "openai" },
        }),
      "thread_provider_locked",
    );
  });

  test("rejects reasoning effort unsupported by the resolved picker model", () => {
    const modePlan = planChatTurnMode({ repositoryId, mode: "discuss" });

    expectConvexErrorCode(
      () =>
        completeChatTurnPlan({
          modePlan,
          modelPreferences: emptyModelPreferences,
          picker: { provider: "openai", modelName: "gpt-5.4-mini", reasoningEffort: "none" },
        }),
      "unsupported_reasoning_effort",
    );
  });
});
