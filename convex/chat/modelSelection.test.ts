/**
 * Plan 11 — model resolver behavior tests.
 *
 * Pin the three resolution layers (mode-specific override → legacy
 * `OPENAI_MODEL` → hard-coded default) plus a contract guard that the
 * defaults stay paired with the pricing table — without that guard a
 * default that drifts off the pricing table silently bypasses Plan 10's
 * daily cap.
 *
 * Env handling follows the existing convention (e.g. `daytona.test.ts`,
 * `rateLimit.test.ts`): explicit save / restore around each test. Vitest's
 * `vi.stubEnv` would also work, but the in-tree convention is direct
 * assignment so this file matches the rest.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveModelForMode } from "./modelSelection";
import { estimateCostUsd } from "../lib/openaiPricing";
import type { ChatMode } from "../chatModeResolver";

const MODE_ENV_VARS = ["OPENAI_MODEL_SANDBOX", "OPENAI_MODEL_DOCS", "OPENAI_MODEL_DISCUSS"] as const;
const ALL_ENV_VARS = [...MODE_ENV_VARS, "OPENAI_MODEL"] as const;

describe("resolveModelForMode", () => {
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

  test("falls back to gpt-5 for sandbox when no env vars are set", () => {
    expect(resolveModelForMode("sandbox")).toBe("gpt-5");
  });

  test("falls back to gpt-5-mini for docs and discuss when no env vars are set", () => {
    // Docs and discuss are text-only single-step replies; the mini tier
    // is the cheaper / lower-latency choice and matches the rollout
    // narrative documented in the resolver itself.
    expect(resolveModelForMode("docs")).toBe("gpt-5-mini");
    expect(resolveModelForMode("discuss")).toBe("gpt-5-mini");
  });

  test("uses the mode-specific override when set", () => {
    process.env.OPENAI_MODEL_SANDBOX = "gpt-5-nano";
    process.env.OPENAI_MODEL_DOCS = "gpt-4o-mini";
    process.env.OPENAI_MODEL_DISCUSS = "gpt-4.1-mini";

    expect(resolveModelForMode("sandbox")).toBe("gpt-5-nano");
    expect(resolveModelForMode("docs")).toBe("gpt-4o-mini");
    expect(resolveModelForMode("discuss")).toBe("gpt-4.1-mini");
  });

  test("falls back to legacy OPENAI_MODEL when mode-specific override is unset", () => {
    // Backward-compat path for operators who pinned `OPENAI_MODEL`
    // during the Plan 04-10 window. The resolver must use that value
    // for every mode (the operator's intent was a global pin, not a
    // per-mode choice).
    process.env.OPENAI_MODEL = "gpt-4.1";

    expect(resolveModelForMode("sandbox")).toBe("gpt-4.1");
    expect(resolveModelForMode("docs")).toBe("gpt-4.1");
    expect(resolveModelForMode("discuss")).toBe("gpt-4.1");
  });

  test("mode-specific override takes precedence over legacy OPENAI_MODEL", () => {
    process.env.OPENAI_MODEL = "gpt-4.1";
    process.env.OPENAI_MODEL_SANDBOX = "gpt-5";

    expect(resolveModelForMode("sandbox")).toBe("gpt-5");
    // Modes without their own override still see the legacy var; the
    // override is per-mode, not all-or-nothing.
    expect(resolveModelForMode("docs")).toBe("gpt-4.1");
    expect(resolveModelForMode("discuss")).toBe("gpt-4.1");
  });

  test("ignores empty strings and whitespace-only env values", () => {
    // An empty value (or one accidentally set to whitespace via shell
    // copy-paste) must fall through to the next layer rather than
    // route the model to a literal empty string — that would fail at
    // the AI SDK boundary with a confusing error.
    process.env.OPENAI_MODEL_SANDBOX = "";
    process.env.OPENAI_MODEL = "   \t  ";
    expect(resolveModelForMode("sandbox")).toBe("gpt-5");
  });

  test("trims surrounding whitespace from env values", () => {
    process.env.OPENAI_MODEL_SANDBOX = "  gpt-5-nano  ";
    expect(resolveModelForMode("sandbox")).toBe("gpt-5-nano");
  });

  test("each mode default exists in the pricing table (Plan 10 cap accuracy)", () => {
    // `estimateCostUsd` returns `undefined` for unknown models, which
    // `settleSandboxReplyCost` treats as "no cost recorded". A default
    // that drifts off the pricing table would silently let users
    // overspend — pinning the pairing as a test invariant catches the
    // drift the moment a default is bumped without a pricing entry.
    const modes: ChatMode[] = ["sandbox", "docs", "discuss"];
    for (const mode of modes) {
      const model = resolveModelForMode(mode);
      const cost = estimateCostUsd(model, 1, 1);
      expect(cost, `pricing missing for default model ${model} (mode: ${mode})`).not.toBeUndefined();
    }
  });
});
