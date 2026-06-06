import { describe, expect, test } from "vitest";
import { resolveComposerModelPick, type ThreadScopedModelPick } from "./use-composer-model-pick";
import type { LlmProvider, ThreadId } from "@/lib/types";

const thread = (id: string) => id as ThreadId;

const explicitPick = (
  threadId: ThreadId | null,
  provider: LlmProvider | null,
  modelName: string | null,
): ThreadScopedModelPick => ({
  threadId,
  provider,
  modelName,
});

describe("resolveComposerModelPick", () => {
  test("thread-scoped explicit pick wins over defaults", () => {
    expect(
      resolveComposerModelPick({
        threadId: thread("tid1"),
        explicitPick: explicitPick(thread("tid1"), "anthropic", "claude-sonnet-4-6"),
        defaultModelPick: { provider: "openai", modelName: "gpt-5.5" },
        threadLockedProvider: "openai",
        threadDefaultModelName: "gpt-5.5",
      }),
    ).toEqual({
      selectedProvider: "anthropic",
      selectedModelName: "claude-sonnet-4-6",
    });
  });

  test("stale explicit pick is ignored after a thread switch", () => {
    expect(
      resolveComposerModelPick({
        threadId: thread("tid2"),
        explicitPick: explicitPick(thread("tid1"), "anthropic", "claude-sonnet-4-6"),
        defaultModelPick: { provider: "openai", modelName: "gpt-5.5" },
        threadLockedProvider: null,
        threadDefaultModelName: null,
      }),
    ).toEqual({
      selectedProvider: "openai",
      selectedModelName: "gpt-5.5",
    });
  });

  test("locked provider and thread default fill the loading fallback", () => {
    expect(
      resolveComposerModelPick({
        threadId: thread("tid1"),
        explicitPick: explicitPick(null, null, null),
        defaultModelPick: undefined,
        threadLockedProvider: "anthropic",
        threadDefaultModelName: "claude-sonnet-4-6",
      }),
    ).toEqual({
      selectedProvider: "anthropic",
      selectedModelName: "claude-sonnet-4-6",
    });
  });

  test("returns null halves when no explicit, default, or lock is available", () => {
    expect(
      resolveComposerModelPick({
        threadId: null,
        explicitPick: explicitPick(thread("tid1"), "openai", "gpt-5.5"),
        defaultModelPick: undefined,
        threadLockedProvider: null,
        threadDefaultModelName: null,
      }),
    ).toEqual({
      selectedProvider: null,
      selectedModelName: null,
    });
  });
});
