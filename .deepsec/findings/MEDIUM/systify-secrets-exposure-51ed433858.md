# [MEDIUM] Sandbox redaction misses common credential formats

**File:** [`convex/chat/redaction.ts`](https://github.com/EricTsai83/systify/blob/main/convex/chat/redaction.ts#L34-L75) (lines 34, 53, 58, 63, 66, 69, 75)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `secrets-exposure`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

redact() is documented as the chokepoint before sandbox tool output reaches the LLM or durable message storage, but the registry only covers GitHub tokens, JWTs, AWS access key ids, Slack tokens, and generic Bearer headers. Common committed secrets such as OpenAI sk-/sk-proj- keys, Anthropic sk-ant- keys, Google AI/API keys, AWS secret access keys, database URLs with passwords, and PEM private keys would pass through unchanged. A sandbox-grounded reply that reads or greps such a file can expose the secret to the model and persist it in chat/tool-call state.

## Recommendation

Expand the registry and tests for common provider keys, private-key blocks, credential URLs, and assignment-based secret patterns. Consider refusing or heavily summarizing known secret-bearing files before persistence, not only regex-redacting their contents.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-28)
