/**
 * Plan 13 — Percentage-based sandbox rollout.
 *
 * Plans 04 / 05 ran sandbox mode behind an explicit allowlist
 * (`SANDBOX_BETA_ALLOWLIST`). That is a fine state for the closed-beta
 * portion of the rollout, but it does not scale to a graduated rollout
 * (10% → 50% → 100%) where listing every viewer's `tokenIdentifier` by
 * hand is impractical.
 *
 * The percentage rollout assigns each viewer to a stable bucket in
 * `[0, 100)` derived from a deterministic hash of their `tokenIdentifier`.
 * A viewer is "in the rollout cohort" iff their bucket is strictly less
 * than `SANDBOX_ROLLOUT_PERCENT`. The two key invariants:
 *
 *   1. **Stability under operator churn.** A viewer's bucket does not
 *      depend on time, on the current rollout percentage, or on any
 *      mutable state — only on their `tokenIdentifier`. So an operator
 *      raising the percentage from 10 → 50 strictly *expands* the cohort:
 *      anyone who already had access keeps it, and 40% additional viewers
 *      gain access. Never the reverse. The same property holds when
 *      bringing it back down — the people who lose access are those at
 *      the high end, not a random reshuffle.
 *
 *   2. **Allowlist-rollout independence.** The bucket calculation does
 *      not consult the allowlist. The composing module
 *      (`sandboxFeatureFlag.ts`) layers them: a viewer in the allowlist
 *      OR in the rollout cohort is admitted. This separation lets us
 *      keep "VIP testers + targeted rollout" and "broad rollout to all
 *      hashed users" as two orthogonal knobs.
 *
 * **Choice of hash function.** FNV-1a 32-bit. Three reasons:
 *
 *   - **Synchronous.** Convex queries / actions can call this from any
 *     runtime without `await`, which matters because
 *     `evaluateSandboxFeatureGate` and the resolver are pure synchronous
 *     functions and we don't want to drag every call site (and the
 *     resolver tests) into async territory just for a non-cryptographic
 *     bucket hash. `crypto.subtle.digest` is async-only.
 *   - **Adequate distribution.** FNV-1a passes basic chi-squared
 *     uniformity for the kind of `user|...` / WorkOS-issued identifiers
 *     we hash. We are bucketing humans, not building a Bloom filter —
 *     ±1 percentage point of bucket-count drift is fine. The colocated
 *     test pins the distribution as a regression guard.
 *   - **Not a security boundary.** A bucket assignment is not a secret.
 *     A viewer who guesses they're in the cohort gains nothing because
 *     the master switch + allowlist + cost cap + Daytona auth still
 *     gate every actually-privileged action. So the cryptographic
 *     properties of the hash are irrelevant.
 *
 * **Stability across clients/runtimes.** FNV-1a's per-byte loop is
 * straightforward enough that this implementation reproduces bit-for-bit
 * on any runtime that supports `String.prototype.charCodeAt` and
 * `Math.imul` (both ES2017+). We rely on `Math.imul` for the modular 32-
 * bit multiply because plain `*` would silently lose the upper bits as
 * doubles round.
 *
 * **Bucket comparison.** The cohort is `[0, percent)`, exclusive on
 * the right. So `percent=10` admits buckets 0..9 (10 buckets out of
 * 100 = 10%); `percent=0` admits nobody; `percent=100` admits everybody.
 * This matches what an operator intuitively expects from "10 percent."
 */

/**
 * Hash a string to a 32-bit unsigned integer using FNV-1a. Pure;
 * deterministic across environments that support ES2017's `Math.imul`.
 *
 * Exposed for tests so the rollout-bucket invariants can be asserted at
 * the hash layer (deterministic, surjective onto `[0, 2^32)`) without
 * coupling to the bucket function's modulo arithmetic.
 */
export function fnv1a32(input: string): number {
  // Offset basis (`2166136261` = `0x811c9dc5`). The `>>> 0` coercion
  // forces a 32-bit unsigned representation; without it, the XOR / shift
  // operations would let the value drift into the 64-bit double range and
  // break determinism across runtimes that round differently.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime: `16777619` = `0x01000193`. `Math.imul` performs the
    // multiplication in 32-bit two's-complement space; the trailing
    // `>>> 0` reinterprets the result as unsigned 32-bit so the next
    // iteration's `^=` operates on a non-negative number.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Map an arbitrary token identifier to a bucket in `[0, 100)`. Used by
 * the rollout decision in `sandboxFeatureFlag.ts` and by the metric
 * emitter in `generation.ts` (which tags session telemetry with the
 * viewer's bucket so dashboards can slice "completed sessions in the
 * 0–10% cohort").
 *
 * `tokenIdentifier` is whatever value `requireViewerIdentity` returns
 * from `convex/lib/auth.ts` — currently the WorkOS-issued
 * `identity.tokenIdentifier`, stable for the lifetime of an account.
 */
export function bucketForTokenIdentifier(tokenIdentifier: string): number {
  return fnv1a32(tokenIdentifier) % 100;
}

/**
 * Decide whether a viewer is in the rollout cohort for a given
 * percentage.
 *
 * Pure function over the inputs — separated from
 * `bucketForTokenIdentifier` so callers that already know the bucket
 * (for example, after computing it once for a metric tag) don't have
 * to recompute the hash. Most callers should use
 * {@link isViewerInRollout} below, which composes the two.
 *
 * Validation rules:
 *   - `rolloutPercent` is clamped to `[0, 100]`. A negative or NaN value
 *     is treated as 0 (rollout off). Above 100 is treated as 100
 *     (rollout to everyone). This makes operator typos fail in the
 *     direction the surrounding gates already protect against —
 *     a 0 fallback never widens access; a clamped-to-100 fallback only
 *     applies when the operator explicitly asked for ≥100% and the
 *     other gates (master switch, cost cap) still apply.
 *   - `bucket` is asserted to live in `[0, 100)` via a runtime guard;
 *     a malformed bucket (out-of-range, fractional, NaN) is treated as
 *     "out of rollout" so a bug in the hashing layer cannot accidentally
 *     promote everybody.
 */
export function bucketIsInRollout(bucket: number, rolloutPercent: number): boolean {
  if (!Number.isFinite(bucket) || !Number.isInteger(bucket) || bucket < 0 || bucket >= 100) {
    return false;
  }
  const clamped = clampRolloutPercent(rolloutPercent);
  return bucket < clamped;
}

/**
 * Convenience composition of {@link bucketForTokenIdentifier} and
 * {@link bucketIsInRollout}. Use this from the gate evaluator; use the
 * two underlying helpers when you also need the bucket value separately
 * (for telemetry tags, for example).
 */
export function isViewerInRollout(tokenIdentifier: string, rolloutPercent: number): boolean {
  return bucketIsInRollout(bucketForTokenIdentifier(tokenIdentifier), rolloutPercent);
}

/**
 * Parse a raw env-var string into a normalized rollout percent in
 * `[0, 100]`. Returns 0 (rollout off) for any unparsable input —
 * "fail closed" matches the rest of the sandbox feature-flag module's
 * defensive defaults.
 */
export function parseRolloutPercent(rawValue: string | undefined): number {
  if (typeof rawValue !== "string") {
    return 0;
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return clampRolloutPercent(parsed);
}

/**
 * Clamp a (possibly user-supplied) rollout percent into `[0, 100]`.
 * Rounded to the nearest integer so a value like `33.5` produces a
 * deterministic 34-bucket cohort rather than depending on float
 * comparison semantics. Negative / NaN / above-100 fall to 0 / 100
 * respectively.
 */
function clampRolloutPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return Math.round(value);
}
