/**
 * Provider environment helpers.
 *
 * Each provider needs its own API key env var to be reachable; the
 * gateway dispatch doesn't probe for those (it would fail late, inside
 * the SDK call). Call sites that decide between the LLM path and the
 * heuristic fallback (chat's free-form Discuss reply when no key is
 * configured) use {@link hasProviderApiKey} to make that decision up
 * front.
 *
 * Centralised so adding a third provider lands in one place: every
 * site that branches on "do we have credentials for this pick?" reads
 * through this module rather than peeking at `process.env` directly.
 */

import type { LlmProvider } from "./llmProvider";

const ENV_VAR_BY_PROVIDER: Record<LlmProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export function providerApiKeyEnvVar(provider: LlmProvider): string {
  return ENV_VAR_BY_PROVIDER[provider];
}

/**
 * Return `true` iff the env var that powers `provider` is set to a
 * non-empty, non-whitespace value.
 *
 * Empty / whitespace-only values are treated as "missing" so an
 * accidentally-empty env var in a `.env` file doesn't fool the chat
 * action into invoking the SDK against an empty token.
 */
export function hasProviderApiKey(provider: LlmProvider): boolean {
  const name = providerApiKeyEnvVar(provider);
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return false;
  }
  return raw.trim().length > 0;
}

/**
 * Test-only export — the canonical env var name per provider. Used by
 * unit tests to set / clear the right var for a provider under test
 * without re-encoding the mapping.
 */
export const TEST_INTERNALS = {
  envVarFor: providerApiKeyEnvVar,
} as const;
