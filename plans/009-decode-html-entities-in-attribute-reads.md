# Plan 009: Decode HTML entities fully when reading attributes in the validator

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c7b6aac..HEAD -- convex/lib/htmlArtifacts.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (defense-in-depth hardening)
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

This is **hardening, not a vulnerability fix** — state that plainly in the PR.
HTML artifacts are rendered in a `sandbox=""` iframe (no `allow-scripts`) behind a
strict `script-src 'none'` CSP that the validator force-injects, so the regex
validator in `htmlArtifacts.ts` is explicitly defense-in-depth (see its own
header comment) and is not the security boundary. No known input executes script.

Within that secondary layer, `decodeAttributeValue` decodes only five entity
forms before comparing attribute values. It is used to read a meta tag's
`http-equiv` and `content` when detecting Content-Security-Policy tags. An author
(or a model emitting odd HTML) could entity-encode those attributes so the
CSP-tag detection misreads them. This cannot weaken the actual policy (the strict
CSP is injected regardless and the sandbox blocks scripts), but it makes the
validator's own checks unreliable and could let a confusingly-encoded duplicate
CSP tag slip past the "CSP must be inside <head>" check. Making entity decoding
complete keeps the defense-in-depth layer honest and the validation messages
trustworthy.

## Current state

File: `convex/lib/htmlArtifacts.ts`. The decoder
(`convex/lib/htmlArtifacts.ts:276-283`):

```ts
function decodeAttributeValue(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
}
```

It is called only from `readAttribute` (`convex/lib/htmlArtifacts.ts:267-274`),
which in turn is used by `isCspMetaTag` and `isRequiredCspMetaTag`
(`convex/lib/htmlArtifacts.ts:153-159`) to compare a meta tag's `http-equiv`
(against `"content-security-policy"`) and `content` (against `HTML_ARTIFACT_CSP`).

Note for scope: the `href`/`src`/`srcset` checks in `validateAttributes`
(`convex/lib/htmlArtifacts.ts:196-220`) do **not** call `decodeAttributeValue`;
they enforce a positive allowlist (fragment-only `#…` for links, `data:` for
sources). That allowlist is what rejects `javascript:` URLs, so this plan does
**not** need to touch `validateAttributes`. Do not change the allowlist behavior.

## Commands you will need

| Purpose          | Command                                   | Expected on success |
|------------------|-------------------------------------------|---------------------|
| Typecheck convex | `bun run typecheck:convex`                | exit 0, no errors   |
| Lint             | `bun run lint`                            | exit 0              |
| Tests (focused)  | `bun run test -- htmlArtifacts`           | all pass            |
| Tests (full)     | `bun run test`                            | all pass            |
| Format           | `bun run format`                          | writes, exit 0      |

## Scope

**In scope** (the only files you should modify):
- `convex/lib/htmlArtifacts.ts`
- `convex/lib/htmlArtifacts.test.ts` (extend — it already exists)

**Out of scope** (do NOT touch):
- `validateAttributes` / the `href`/`src`/`srcset` allowlist — already safe and
  not entity-decoded by design.
- The CSP constants (`HTML_ARTIFACT_CSP`, `HTML_ARTIFACT_CSP_META`) and the
  injection behavior.
- Any new dependency. Implement the decoder inline; do **not** add an entities
  library to `package.json`.

## Git workflow

- Branch: `advisor/009-decode-html-entities-in-attribute-reads`
- Commit message style matches `git log` (imperative, capitalized, no trailing
  period — e.g. "Decode HTML entities fully in attribute reads").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `decodeAttributeValue` handle numeric and common named entities

Rewrite `decodeAttributeValue` so it:

1. Replaces decimal numeric entities `&#DDD;` and hex numeric entities
   `&#xHHH;` / `&#XHHH;` with the corresponding character via
   `String.fromCodePoint`, guarding against invalid/out-of-range code points
   (wrap in a check; on `RangeError` leave the original text).
2. Replaces a small map of common named entities case-insensitively:
   `&quot;` → `"`, `&apos;` → `'`, `&lt;` → `<`, `&gt;` → `>`, `&nbsp;` → space,
   and `&amp;` → `&` **last** (so an already-decoded `&` is not re-processed).
3. Returns the decoded string.

Order matters: decode numeric and the non-`amp` named entities first, then decode
`&amp;` last. Do **not** loop-decode repeatedly (no recursive entity expansion) —
a single pass is the intended, predictable behavior; note this in a code comment.

Target shape:

```ts
const NAMED_ENTITIES: ReadonlyArray<[RegExp, string]> = [
  [/&quot;/gi, '"'],
  [/&apos;/gi, "'"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&nbsp;/gi, " "],
];

// Single-pass decode of the entity forms a browser would resolve in an attribute
// value. Deliberately non-recursive: &amp; is decoded last so prior output is not
// reinterpreted. This validator is defense-in-depth; the CSP + sandboxed iframe
// is the security boundary.
function decodeAttributeValue(value: string): string {
  let decoded = value.replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return decodeCodePoint(code, match);
  });
  decoded = decoded.replace(/&#(\d+);/g, (match, dec: string) => {
    const code = Number.parseInt(dec, 10);
    return decodeCodePoint(code, match);
  });
  for (const [pattern, replacement] of NAMED_ENTITIES) {
    decoded = decoded.replace(pattern, replacement);
  }
  return decoded.replace(/&amp;/gi, "&");
}

function decodeCodePoint(code: number, original: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return original;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}
```

**Verify**: `bun run typecheck:convex` → exit 0, no errors.

### Step 2: Add tests in `htmlArtifacts.test.ts`

Add a focused `describe` (or cases) that exercises entity-encoded CSP meta-tag
detection through the public `validateHtmlArtifact`. Model the construction on the
existing `VALID_HTML` template and the existing CSP tests
(`convex/lib/htmlArtifacts.test.ts:35-61`). Cases:

1. **Entity-encoded required CSP in head is recognized as satisfying policy.**
   Build HTML whose first head element is the required CSP meta tag but with the
   `content` value containing an entity form of a character it already includes
   (e.g. encode a single quote in the policy as `&#39;`), and assert the document
   is still recognized (validates without the "missing CSP meta" error, given the
   rest is valid). Confirm the intent: a faithfully-decoded `content` matches
   `HTML_ARTIFACT_CSP`.
2. **Entity-encoded `http-equiv` on a body CSP tag is still detected as a CSP tag
   outside head.** Place a meta tag in the body whose `http-equiv` is written with
   an entity (e.g. `Content-Security-Polic&#121;` → `Content-Security-Policy`) and
   assert the validator flags "CSP meta tags must be inside <head>" — i.e. the
   decoder lets `isCspMetaTag` recognize it. **If, after reading the surrounding
   code, you determine this exact assertion does not hold because `content`
   comparison is also required, adjust the case to target whichever CSP check
   `readAttribute` feeds, and document your reasoning in the test name.**
3. **Invalid numeric entity is left intact (no crash).** A `content` value with an
   out-of-range entity like `&#xFFFFFFFF;` does not throw and yields a
   non-matching policy (validator does not treat it as the required CSP).

Keep the existing tests passing unchanged.

**Verify**: `bun run test -- htmlArtifacts` → all pass, including the new cases.

### Step 3: Full gates

**Verify**: run in order, each exit 0 / all pass:
- `bun run format`
- `bun run lint`
- `bun run test`

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck:convex` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` passes; `htmlArtifacts.test.ts` includes the new
      entity-decoding cases and passes
- [ ] `grep -n "fromCodePoint" convex/lib/htmlArtifacts.ts` returns a match
      (numeric entity decoding is implemented)
- [ ] `grep -c "import" package.json` is unchanged from before this plan (no new
      dependency added) — or simply confirm `git diff package.json` is empty
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The decoder at `convex/lib/htmlArtifacts.ts:276-283` does not match the
  "Current state" excerpt (the file has drifted).
- Implementing complete decoding tempts you to add a library or to make the
  decoder recursive/multi-pass — stop; single-pass, dependency-free is the
  intended scope. Report if you believe multi-pass is genuinely required.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- This change does not alter the security boundary (CSP + sandboxed iframe). Do
  not let a reviewer or follow-up treat the regex validator as a sanitizer it is
  not; the header comment in `htmlArtifacts.ts` documents this and must stay.
- Decoding is intentionally single-pass and non-recursive to avoid
  entity-expansion ambiguity; if a future need arises to decode nested entities,
  that is a deliberate behavior change requiring its own review.
- Reviewer should confirm `&amp;` is decoded last and that invalid code points
  fall back to the original text rather than throwing.
