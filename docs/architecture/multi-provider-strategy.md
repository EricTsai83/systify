# Multi-Provider LLM Strategy

## Why this exists

Systify lets a user pick the model on every send (GPT family vs Claude family).
Picking per message is a product feature — different surfaces favour different
tradeoffs (Claude for prose, GPT for cheap reasoning), and the same conversation
may want to ratchet up the tier for a hard question. Free choice within a
provider is intentional.

Switching provider mid-thread is not. Reasoning blocks, prompt-caching keys, and
tool-call envelopes all differ across providers; replaying an OpenAI assistant
turn back into Anthropic on the next round corrupts the running context.
Hiding the wrong option in the picker is not enough — a determined dev-tools
user, or any bug in the composer wiring, can submit a mismatched pair. The
contract has to live in the backend mutation.

This doc covers the rules: the catalog is the single source of truth, the
thread's `lockedProvider` is the gate, and adding a third provider is bounded
to a fixed list of files.

## How it works

### The catalog is the source of truth

`convex/lib/llmCatalog.ts` enumerates every supported `(provider, modelName)`
pair as `ModelCatalogEntry` rows carrying `displayName`, `capability` tier,
`reasoningEffort`, `supportsTools`, `contextWindow`, and `userPickable`. The
catalog drives four downstream consumers, listed in the file header:

1. The composer's model picker (frontend filters `userPickable: true`).
2. The `chat.send` mutations that validate a user-picked pair before queueing.
3. The `llmGateway` dispatcher (asserts validity before acquiring rate limits
   or invoking the SDK).
4. The pricing-table coverage test — every catalog entry must have a row in
   `convex/lib/llmPricing.ts` or CI fails.

Adding a model is a one-line addition to `MODEL_CATALOG`; the four consumers
pick it up automatically. `userPickable: false` is reserved for internal-only
models (the eval judge, future utility flows) — the picker filters them out,
the gateway still accepts them.

### Thread provider lock — enforced in the backend

The `threads.lockedProvider` column (`convex/schema.ts:760`) is unset on a
brand-new thread and patched to the resolved provider the first time
`insertChatTurn` writes a turn (`convex/chat/send.ts:144-146`). Once set, it
is immutable for the lifetime of the thread.

`chat.send.sendMessage` enforces the lock before any side-effect lands
(`convex/chat/send.ts:404-411`):

```ts
if (thread.lockedProvider !== undefined && thread.lockedProvider !== resolved.provider) {
  throw new ConvexError({
    code: "thread_provider_locked",
    lockedProvider: thread.lockedProvider,
    attemptedProvider: resolved.provider,
    message: `This thread is locked to ${thread.lockedProvider}. Start a new chat to use ${resolved.provider}.`,
  });
}
```

The resolver (`convex/chat/modelSelection.ts`) is a thin three-layer cascade:
per-message override → `threads.defaultModelName` → capability default. It
runs *after* `sendMessage` has validated the half-pair shape and catalog
membership (`convex/chat/send.ts:379-385`), so its only job is to collapse
the triple into a single `ModelChoice`. When `lockedProvider` is set, the
capability-default layer prefers the locked provider's tier entry instead of
the global OpenAI default — otherwise a stale `defaultModelName` on a
lock-Anthropic thread would land on the OpenAI fallback and bounce off the
lock check the user never picked
(`convex/chat/modelSelection.ts:184-197`).

Within the locked provider the user freely switches model tier (gpt-5 ↔
gpt-5-mini); only the provider literal is immutable. `defaultModelName` is
patched on every send so reopening the thread restores the last pick
(`convex/chat/send.ts:150`).

### Picker UI mirrors the lock, but the backend is the contract

`src/components/ai-elements/prompt-input-model-picker.tsx` reads the catalog
through `useQuery(api.llmCatalog.listPickableModels, ...)` and hides the
locked-out provider's group when `threadLockedProvider` is set. It renders a
`<ProviderLockPill>` next to the trigger so the user sees why the choice
narrowed. The picker is UX — the picker forming a pair that the backend
would reject is just a code bug; correctness still comes from `sendMessage`.

### System Design jobs

System Design picks `(provider, modelName)` at job creation time and bakes
both onto the `jobs` row (`convex/schema.ts:378-379`). Different jobs may
use different providers; within a single job every kind uses the same pair —
the artifact cache key `(repositoryId, kind, alignedImportCommitSha,
generatedByProvider, generatedByModel, promptVersion)`
(`convex/schema.ts:535-537`) relies on that immutability so a resume after
action timeout picks up exactly where the original attempt left off.

### Pre-existing threads

Threads created before the multi-provider rollout have no `lockedProvider`.
The composer renders the full picker for them on first visit; the next send
sets the lock through the same `insertChatTurn` path as a brand-new thread.
The optional column means no migration is needed.

## Failure modes & recovery

**Two messages to a brand-new thread within the same tick.** Convex serializes
mutations that write the same document, so the second `sendMessage` reads the
`lockedProvider` written by the first. If the second pick disagrees, the lock
check throws `thread_provider_locked` and the frontend surfaces the error.
No explicit fix needed — the per-document serialization is the mechanism.

**Dev-tools bypass of the picker.** The picker is UX; the backend mutation
is the contract. A fabricated `(provider, modelName)` either fails
`isValidPick` with `unsupported_model` (`convex/chat/send.ts:380-385`) or
fails the lock check with `thread_provider_locked`. Either way no message is
queued and no LLM call is made.

**Half-set picker pair.** Sending only `provider` or only `modelName` rejects
with `incomplete_model_pick` (`convex/chat/send.ts:462-470`). The resolver
never has to distinguish "intentional half-pick" from "missing arg" — the
mutation refuses the request up front.

**Catalog entry without a pricing row.** The pricing-coverage test
(`llmPricing.test.ts` / `llmCatalog.test.ts`) fails CI. There are no silent
zero-cost models — the test is the gate.

**Stale `defaultModelName` (catalog narrowed mid-thread).** The resolver's
per-message-override layer re-validates against the catalog and degrades to
the capability default rather than handing the gateway an unknown pair
(`convex/chat/modelSelection.ts:151-163`). When `lockedProvider` is set, the
fallback uses the locked provider's tier entry so the resolved pick survives
the lock check.

**Operator escape hatch.** None. Operator changes ship through `MODEL_CATALOG`
additions, not through env vars at the resolver layer
(`convex/chat/modelSelection.ts:13-15`).

## Future evolution

**Adding a third provider** (e.g. Gemini). The plan and the code both bound
this to a fixed list of files:

1. Extend the `llmProviderValidator` literal union in
   `convex/lib/llmProvider.ts`. Every persisted column and consumer surfaces
   as a compile error.
2. Add catalog rows in `convex/lib/llmCatalog.ts`.
3. Add pricing rows in `convex/lib/llmPricing.ts` (CI gate).
4. Add a new `case` to the `getSdkModel` switch in
   `convex/lib/llmGateway.ts:449-455`.
5. Handle provider-specific options mapping inside the gateway's
   `buildProviderOptions` (`convex/lib/llmGateway.ts:464+`) — Anthropic
   already needs its own thinking-budget knob; Gemini would need the same.

Zero call site changes anywhere else. The picker, the resolver, the lock
enforcement, and every persistence path read the union and the catalog.

**Forked thread.** `threads.forkedFromThreadId` (`convex/schema.ts:776`) is
unwired today. It reserves space for a "Fork to new model" workflow that
clones a locked thread into a new thread that can pick a different provider
while keeping a back-pointer to the original. Lands without a second
migration.

**Per-user model preference.** Today the picker's last pick rides on
`threads.defaultModelName`. When the product needs a default model per user
(rather than per thread), the `userPreferences` table
(`convex/schema.ts:223-227`) is the natural home for a `defaultModelName`
column. Until then thread-level state is enough.

## Non-decisions

These are choices the design explicitly does not make:

- **No automatic provider fallback.** Per-message model choice is a product
  feature; surfacing the failure to the user is correct UX. A silent fallback
  would hide cost / quality regressions.
- **No mid-thread provider switch.** Reasoning blocks, prompt-caching keys,
  and tool envelopes all differ — the running context would corrupt. The
  user starts a new chat (or, eventually, forks the thread) to switch
  providers.
- **No env-driven operator override of the resolver.** Operator changes land
  as catalog additions; the resolver stays pure.
