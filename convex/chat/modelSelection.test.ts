/**
 * Model resolver behavior tests.
 *
 * Pin the three resolution layers (capability-specific override →
 * `OPENAI_MODEL` → hard-coded default) plus a contract guard that the
 * defaults stay paired with the pricing table — without that guard a
 * default that drifts off the pricing table silently bypasses the daily
 * cost cap.
 *
 * Env handling follows the existing convention (e.g. `daytona.test.ts`,
 * `rateLimit.test.ts`): explicit save / restore around each test. Vitest's
 * `vi.stubEnv` would also work, but the in-tree convention is direct
 * assignment so this file matches the rest.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pickCapability, resolveModelForReply, type ModelCapability } from "./modelSelection";
import { estimateCostUsd } from "../lib/openaiPricing";

const CAPABILITY_ENV_VARS = ["OPENAI_MODEL_SANDBOX", "OPENAI_MODEL_LIBRARY", "OPENAI_MODEL_DISCUSS"] as const;
const ALL_ENV_VARS = [...CAPABILITY_ENV_VARS, "OPENAI_MODEL"] as const;

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
  // Snapshot the env vars the resolver consults so tests can mutate
  // freely and we restore the operator's actual values after the suite.
  // Saving once in `beforeEach` (not at module load) keeps the snapshot
  // valid even when the tests run interleaved with other suites that
  // mutate `process.env`.
  const original: Partial<Record<(typeof ALL_ENV_VARS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ALL_ENV_VARS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ALL_ENV_VARS) {
      const value = original[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("falls back to gpt-5 for sandbox-grounded Discuss when no env vars are set", () => {
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).name).toBe("gpt-5");
  });

  test("falls back to gpt-5-mini for library and ungrounded discuss when no env vars are set", () => {
    // Library and ungrounded Discuss are text-only single-step replies;
    // the mini tier is the cheaper / lower-latency choice and matches
    // the rollout narrative documented in the resolver itself.
    expect(resolveModelForReply({ mode: "library", groundSandbox: false }).name).toBe("gpt-5-mini");
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: false }).name).toBe("gpt-5-mini");
  });

  test("uses the capability-specific override when set", () => {
    process.env.OPENAI_MODEL_SANDBOX = "gpt-5-nano";
    process.env.OPENAI_MODEL_LIBRARY = "gpt-4o-mini";
    process.env.OPENAI_MODEL_DISCUSS = "gpt-4.1-mini";

    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).name).toBe("gpt-5-nano");
    expect(resolveModelForReply({ mode: "library", groundSandbox: false }).name).toBe("gpt-4o-mini");
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: false }).name).toBe("gpt-4.1-mini");
  });

  test("falls back to OPENAI_MODEL when capability-specific override is unset", () => {
    // Global pin path for operators who set `OPENAI_MODEL` instead of the
    // capability-specific variables. The resolver must use that value
    // for every capability (the operator's intent was a global pin, not
    // a per-capability choice).
    process.env.OPENAI_MODEL = "gpt-4.1";

    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).name).toBe("gpt-4.1");
    expect(resolveModelForReply({ mode: "library", groundSandbox: false }).name).toBe("gpt-4.1");
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: false }).name).toBe("gpt-4.1");
  });

  test("capability-specific override takes precedence over the global OPENAI_MODEL", () => {
    process.env.OPENAI_MODEL = "gpt-4.1";
    process.env.OPENAI_MODEL_SANDBOX = "gpt-5";

    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).name).toBe("gpt-5");
    // Capabilities without their own override fall through to the global
    // var; the override is per-capability, not all-or-nothing.
    expect(resolveModelForReply({ mode: "library", groundSandbox: false }).name).toBe("gpt-4.1");
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: false }).name).toBe("gpt-4.1");
  });

  test("ignores empty strings and whitespace-only env values", () => {
    // An empty value (or one accidentally set to whitespace via shell
    // copy-paste) must fall through to the next layer rather than
    // route the model to a literal empty string — that would fail at
    // the AI SDK boundary with a confusing error.
    process.env.OPENAI_MODEL_SANDBOX = "";
    process.env.OPENAI_MODEL = "   \t  ";
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).name).toBe("gpt-5");
  });

  test("trims surrounding whitespace from env values", () => {
    process.env.OPENAI_MODEL_SANDBOX = "  gpt-5-nano  ";
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).name).toBe("gpt-5-nano");
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
      const cost = estimateCostUsd(choice.name, 1, 1);
      expect(cost, `pricing missing for default model ${choice.name} (capability: ${capability})`).not.toBeUndefined();
    }
  });

  test("attaches per-model reasoning effort to the default gpt-5 / gpt-5-mini choices", () => {
    // `MODEL_REASONING_DEFAULT` keys reasoning effort by *model*, not by
    // capability tier. Sandbox-grounded Discuss (gpt-5) should get
    // "medium" — matching OpenAI's API default — while library /
    // ungrounded discuss (gpt-5-mini) should get the lighter "low".
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: true }).reasoningEffort).toBe("medium");
    expect(resolveModelForReply({ mode: "library", groundSandbox: false }).reasoningEffort).toBe("low");
    expect(resolveModelForReply({ mode: "discuss", groundSandbox: false }).reasoningEffort).toBe("low");
  });

  test("returns reasoningEffort=undefined when the model isn't in the reasoning table", () => {
    // Pointing a tier at a non-reasoning model (gpt-4o) is the documented
    // way operators turn reasoning off at runtime — the resolver must
    // surface `undefined` so `providerOptions` stays unset and OpenAI
    // runs without `reasoningEffort`. Confirms the env-override path is
    // the canonical "off switch" the plan describes.
    process.env.OPENAI_MODEL_DISCUSS = "gpt-4o";
    const choice = resolveModelForReply({ mode: "discuss", groundSandbox: false });
    expect(choice.name).toBe("gpt-4o");
    expect(choice.reasoningEffort).toBeUndefined();
  });
});
