/**
 * Model resolver behavior tests.
 *
 * Pin the three resolution layers (per-message override → thread default
 * → capability default) plus a contract guard that the defaults stay
 * paired with the pricing table — without that guard a default that
 * drifts off the pricing table silently bypasses the daily cost cap.
 */

import { describe, expect, test } from "vitest";
import { pickCapability, resolveModelForReply, type ModelCapability } from "./modelSelection";
import { estimateCostUsd } from "../lib/llmPricing";

describe("pickCapability", () => {
  test("maps sandbox-grounded Discuss onto the sandbox tier", () => {
    expect(pickCapability({ mode: "discuss", groundSandbox: true })).toBe("sandbox");
  });

  test("maps ungrounded Discuss onto the discuss tier", () => {
    expect(pickCapability({ mode: "discuss", groundSandbox: false })).toBe("discuss");
  });

  test("maps Library mode onto the library tier", () => {
    expect(pickCapability({ mode: "library", groundSandbox: false })).toBe("library");
  });

  test("sandbox grounding wins over Library mode (defensive — write paths coerce sandbox=false for library, but the resolver stays explicit)", () => {
    expect(pickCapability({ mode: "library", groundSandbox: true })).toBe("sandbox");
  });
});

describe("resolveModelForReply", () => {
  test("falls back to gpt-5.5 for sandbox-grounded Discuss when no override / thread default is provided", () => {
    const choice = resolveModelForReply({ mode: "discuss", groundSandbox: true });
    expect(choice.provider).toBe("openai");
    expect(choice.modelName).toBe("gpt-5.5");
    expect(choice.capability).toBe("sandbox");
  });

  test("falls back to gpt-5.4-mini for library and ungrounded discuss when no override / thread default is provided", () => {
    // Library and ungrounded Discuss are text-only single-step replies;
    // the mini tier is the cheaper / lower-latency choice and matches
    // the rollout narrative documented in the resolver itself.
    expect(resolveModelForReply({ mode: "library", groundSandbox: false }).modelName).toBe("gpt-5.4-mini");
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: false }).modelName).toBe("gpt-5.4-mini");
  });

  test("explicit per-message override wins over thread default and capability default", () => {
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      overrideProvider: "anthropic",
      overrideModelName: "claude-haiku-4-5",
      threadDefaultModelName: "gpt-5.5",
    });
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelName).toBe("claude-haiku-4-5");
  });

  test("sandbox-tier explicit picks can serve Library replies when the user selects them", () => {
    const choice = resolveModelForReply({
      mode: "library",
      groundSandbox: false,
      overrideProvider: "openai",
      overrideModelName: "gpt-5.5",
    });
    expect(choice.provider).toBe("openai");
    expect(choice.modelName).toBe("gpt-5.5");
    expect(choice.capability).toBe("sandbox");
  });

  test("library mode honors lockedProvider over overrideProvider fallback", () => {
    const choice = resolveModelForReply({
      mode: "library",
      groundSandbox: false,
      lockedProvider: "openai",
      overrideProvider: "anthropic",
      overrideModelName: "unknown-override-model",
    });
    expect(choice.provider).toBe("openai");
    expect(choice.capability).toBe("discuss");
  });

  test("half-set override (model name only, no provider) is ignored and falls through", () => {
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      overrideModelName: "claude-haiku-4-5",
    });
    expect(choice.provider).toBe("openai");
    expect(choice.modelName).toBe("gpt-5.4-mini");
  });

  test("override that is not in the catalog falls through to the next layer", () => {
    // Out-of-band catalog narrowing while a thread is running could leave
    // a persisted picker pick that no longer matches; the resolver
    // degrades to the thread default rather than handing the gateway a
    // bad pair.
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      overrideProvider: "openai",
      overrideModelName: "gpt-3.5-imaginary",
      threadDefaultModelName: "claude-haiku-4-5",
    });
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelName).toBe("claude-haiku-4-5");
  });

  test("thread default inferred via catalog lookup when no override is set", () => {
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      threadDefaultModelName: "claude-haiku-4-5",
    });
    expect(choice.provider).toBe("anthropic");
    expect(choice.modelName).toBe("claude-haiku-4-5");
  });

  test("thread default with unknown model name falls through to capability default", () => {
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      threadDefaultModelName: "deprecated-model-name",
    });
    expect(choice.provider).toBe("openai");
    expect(choice.modelName).toBe("gpt-5.4-mini");
  });

  test("each capability default exists in the pricing table (cost cap accuracy)", () => {
    // `estimateCostUsd` returns `undefined` for unknown models, which
    // `settleSandboxReplyCost` treats as "no cost recorded". A default
    // that drifts off the pricing table would silently let users
    // overspend — pinning the pairing as a test invariant catches the
    // drift the moment a default is bumped without a pricing entry.
    const cases: Array<{ capability: ModelCapability; args: { mode: "discuss" | "library"; groundSandbox: boolean } }> =
      [
        { capability: "sandbox", args: { mode: "discuss", groundSandbox: true } },
        { capability: "library", args: { mode: "library", groundSandbox: false } },
        { capability: "discuss", args: { mode: "discuss", groundSandbox: false } },
      ];
    for (const { capability, args } of cases) {
      const choice = resolveModelForReply(args);
      const cost = estimateCostUsd(choice.provider, choice.modelName, { inputTokens: 1, outputTokens: 1 });
      expect(
        cost,
        `pricing missing for default model ${choice.provider}:${choice.modelName} (capability: ${capability})`,
      ).not.toBeUndefined();
    }
  });

  test("attaches per-model reasoning effort to the default gpt-5.5 / gpt-5.4-mini choices", () => {
    // The catalog keys reasoning effort by model entry, not capability
    // tier. Sandbox-grounded Discuss (gpt-5.5) should get "medium" —
    // matching OpenAI's API default — while library / ungrounded discuss
    // (gpt-5.4-mini) should get the lighter "low".
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).reasoningEffort).toBe("medium");
    expect(resolveModelForReply({ mode: "library", groundSandbox: false }).reasoningEffort).toBe("low");
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: false }).reasoningEffort).toBe("low");
  });

  test("returns reasoningEffort=undefined when a reasoning model has no catalog default and no override", () => {
    // Anthropic reasoning models expose the user-facing override but
    // do not carry an OpenAI-shaped catalog default. Without an
    // explicit user pick, the gateway should omit provider options.
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      overrideProvider: "anthropic",
      overrideModelName: "claude-haiku-4-5",
    });
    expect(choice.reasoningEffort).toBeUndefined();
  });

  test("per-message reasoning override wins over the catalog default on a supportsReasoning model", () => {
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      overrideProvider: "openai",
      overrideModelName: "gpt-5.4-mini",
      overrideReasoningEffort: "high",
    });
    expect(choice.reasoningEffort).toBe("high");
  });

  test("per-message reasoning override applies on Anthropic reasoning models", () => {
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      overrideProvider: "anthropic",
      overrideModelName: "claude-haiku-4-5",
      overrideReasoningEffort: "high",
    });
    expect(choice.reasoningEffort).toBe("high");
  });

  test("unsupported per-message reasoning override falls back to the model default", () => {
    const choice = resolveModelForReply({
      mode: "discuss",
      groundSandbox: false,
      overrideReasoningEffort: "none",
    });
    expect(choice.provider).toBe("openai");
    expect(choice.modelName).toBe("gpt-5.4-mini");
    expect(choice.reasoningEffort).toBe("low");
  });
});
