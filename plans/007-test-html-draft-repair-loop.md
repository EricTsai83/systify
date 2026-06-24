# Plan 007: Add test coverage for the HTML draft validation-repair loop

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c7b6aac..HEAD -- convex/libraryArtifactDraftsNode.ts convex/libraryArtifactDraftsNode.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

When the LLM produces HTML for a Library report draft, the code validates it and,
if invalid, **retries the LLM up to twice** with a repair prompt
(`convex/libraryArtifactDraftsNode.ts:379-411`). Each repair attempt is a real,
paid LLM call. This is the most failure-prone path in the feature, yet it has
zero test coverage: the only HTML draft test mocks `generateObjectViaGateway` to
return valid HTML on the first call, so the repair branch (lines 380–407) and the
"still invalid after repairs" error (line 410) never execute. A regression in the
repair prompt, the attempt count, or the validator would ship silently. This plan
adds tests only — no production code changes.

## Current state

- `convex/libraryArtifactDraftsNode.ts`:
  - `HTML_DRAFT_REPAIR_ATTEMPTS = 2` (line 34).
  - The repair loop (lines 379–411):

    ```ts
    let validation = validateHtmlArtifact(output.html);
    for (let attempt = 0; !validation.valid && attempt < HTML_DRAFT_REPAIR_ATTEMPTS; attempt += 1) {
      const repair = await generateObjectViaGateway(ctx, { /* ... */ }, {
        system: buildHtmlRepairSystemPrompt(),
        prompt: buildHtmlRepairPrompt(output, validation.errors),
        schema: htmlDraftOutputSchema,
        schemaName: "library_html_report_repair",
        /* ... */
      });
      usage = combineSandboxLibraryGenerationUsage(usage, repair.usage);
      totalCostUsd = combineSandboxLibraryGenerationCost(totalCostUsd, repair.costUsd);
      output = normalizeHtmlDraftObject(repair.object);
      validation = validateHtmlArtifact(output.html);
    }
    if (!validation.valid) {
      throw new Error(`HTML report failed validation: ${validation.errors.join("; ")}`);
    }
    ```
  - Repair calls use `schemaName: "library_html_report_repair"`; the initial
    call uses `schemaName: "library_html_report_draft"` (line 361). This is how a
    test distinguishes initial vs repair calls.
  - On success, usage cost accumulates across the initial + repair calls.

- `convex/libraryArtifactDraftsNode.test.ts`:
  - Mocks the gateway: `vi.mock("./lib/llmGateway", ...)` with
    `generateObjectViaGateway: mocks.generateObjectViaGateway` (lines 46–49).
  - `beforeEach` sets a default `mocks.generateObjectViaGateway.mockReset().mockResolvedValue({...})` (line 147).
  - The existing HTML happy-path test (around lines 327–411) sets
    `mocks.generateObjectViaGateway.mockResolvedValueOnce({ object: { ..., html: "<valid html>" }, usage, costUsd, ... })`
    and asserts `state.draft?.status === "ready"`, `outputFormat === "html"`,
    `state.usageEvents[0].costUsd === 0.03`, etc.
  - `validateHtmlArtifact` (`convex/lib/htmlArtifacts.ts:35`) returns
    `{ valid: true, html, byteLength, errors: [] }` or `{ valid: false, html, byteLength, errors: string[] }`.
    HTML is **invalid** if it is missing the required `<head>` CSP meta tag,
    contains a `<script>`, has event-handler attributes, has an empty body, etc.
    A minimal **invalid** HTML for a test: a document with no required CSP meta /
    no `<main>` body content — confirm by reading `convex/lib/htmlArtifacts.test.ts`
    for an existing invalid example to copy verbatim.

Valid HTML example to reuse for the success call (from the existing test, lines 346–356):

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Executive report</title>
</head>
<body>
  <main><h1>Executive report</h1><p>Runtime evidence.</p><a href="#sources">Sources</a></main>
</body>
</html>
```

(Note: the real code injects the CSP meta during validation. Confirm this exact
block validates by checking that the existing happy-path test passes unchanged —
it does today. Use `convex/lib/htmlArtifacts.test.ts` to source a guaranteed
**invalid** sample.)

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Tests     | `bun run test -- libraryArtifactDraftsNode`          | all pass            |
| Tests     | `bun run test -- htmlArtifacts`                      | all pass (to copy an invalid sample) |
| Typecheck | `bun run typecheck:convex`                           | exit 0              |
| Lint      | `bun run lint`                                       | exit 0, 0 warnings  |
| Format    | `bun run format`                                     | rewrites, exit 0    |

## Scope

**In scope** (the only file you should modify):
- `convex/libraryArtifactDraftsNode.test.ts` — add new test cases.

**Out of scope** (do NOT touch):
- `convex/libraryArtifactDraftsNode.ts` — production code is correct; this plan
  is tests only. If you believe the repair logic has a bug, STOP and report it
  rather than changing it under a test plan.
- Any other `*.ts` file.

## Git workflow

- Branch: `advisor/007-test-html-draft-repair-loop`
- One commit; message style matches `git log` (imperative, e.g. "Test HTML draft validation repair loop").
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Source a guaranteed-invalid HTML sample

Read `convex/lib/htmlArtifacts.test.ts` and copy an HTML string that the test
suite already asserts is **invalid** (`valid: false`). This guarantees the first
gateway call in your new test triggers the repair branch.

**Verify**: `bun run test -- htmlArtifacts` → all pass (confirms your chosen
sample's expected validity).

### Step 2: Add a "repairs invalid HTML then succeeds" test

In the same `describe("runArtifactDraft", ...)` block as the existing HTML
happy-path test, add a test that:

1. Sets up an HTML-output draft exactly like the existing HTML test (reuse its
   `t.run` setup that inserts the draft/job with `outputFormat: "html"` and the
   `retrieveArtifactChunks` mock).
2. Queues two distinct gateway responses with `mockResolvedValueOnce`:
   - **First call** → `object.html` = the INVALID sample from Step 1; `usage`/`costUsd` set (e.g. `costUsd: 0.03`).
   - **Second call** → `object.html` = the VALID sample shown in Current state; `usage`/`costUsd` set (e.g. `costUsd: 0.02`).
3. Runs `t.action(internal.libraryArtifactDraftsNode.runArtifactDraft, { draftId, jobId, repositoryId, ownerTokenIdentifier: OWNER })`.
4. Asserts:
   - `mocks.generateObjectViaGateway` was called **twice**.
   - The first call used `schemaName: "library_html_report_draft"` and the second used `schemaName: "library_html_report_repair"` — assert via
     `mocks.generateObjectViaGateway.mock.calls[1]?.[2]` containing `{ schemaName: "library_html_report_repair" }`.
   - `state.draft?.status === "ready"` and `outputFormat === "html"`.
   - The recorded usage event's `costUsd` equals the **sum** of both calls
     (`0.03 + 0.02 = 0.05`), confirming repair usage is accumulated
     (`state.usageEvents[0].costUsd`).

**Verify**: `bun run test -- libraryArtifactDraftsNode` → all pass, new test included.

### Step 3: Add a "still invalid after max repairs fails the draft" test

Add a second test that:

1. Same HTML-output draft setup.
2. Mocks `generateObjectViaGateway` to return INVALID HTML on **every** call —
   use `mockResolvedValue` (not `...Once`) so the initial call plus both repair
   attempts all return invalid HTML.
3. Runs the action.
4. Asserts:
   - `mocks.generateObjectViaGateway` was called `1 + HTML_DRAFT_REPAIR_ATTEMPTS`
     = **3** times (initial + 2 repairs).
   - The draft/job ends in a failed state. Confirm the exact failure shape by
     reading how other failure tests in this file assert it (search the file for
     `status).toBe("failed")` or a job-error assertion) and match that shape —
     the action throws `"HTML report failed validation: ..."` at line 410, which
     the draft runner converts to a failed draft/job. If the failure assertion
     shape is unclear, assert at minimum that `state.draft?.status` is NOT
     `"ready"`.

**Verify**: `bun run test -- libraryArtifactDraftsNode` → all pass.

### Step 4: Format and full gate

Run `bun run format`, then `bun run lint` and `bun run test`.

**Verify**: all "Commands you will need" pass.

## Test plan

Two new tests in `convex/libraryArtifactDraftsNode.test.ts`, modeled structurally
on the existing HTML happy-path test in the same file:

- `"repairs invalid HTML and succeeds, accumulating repair usage"` — covers the
  repair branch (lines 380–407) and usage accumulation.
- `"fails the draft when HTML is still invalid after max repair attempts"` —
  covers the loop bound and the throw at line 410.

Verification: `bun run test -- libraryArtifactDraftsNode` → all pass; exactly two
new tests added.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck:convex` exits 0
- [ ] `bun run lint` exits 0, 0 warnings
- [ ] `bun run test` exits 0
- [ ] `grep -c "library_html_report_repair" convex/libraryArtifactDraftsNode.test.ts` returns ≥ 1 (the repair branch is now asserted)
- [ ] Only `convex/libraryArtifactDraftsNode.test.ts` is modified (`git status`)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The repair loop at `convex/libraryArtifactDraftsNode.ts:379-411` no longer
  matches the "Current state" excerpt (logic drifted — the test would assert
  stale behavior).
- You cannot produce HTML that `validateHtmlArtifact` rejects on the first call
  (e.g. the validator auto-repairs everything) — without an invalid input the
  repair branch can't be exercised; report this.
- A new test fails twice after a reasonable fix attempt, AND the failure looks
  like a real production bug (not a test-setup issue) — report the suspected bug
  rather than weakening the assertion.

## Maintenance notes

- If `HTML_DRAFT_REPAIR_ATTEMPTS` changes, the "called 3 times" assertion in
  Step 3 must be updated to `1 + HTML_DRAFT_REPAIR_ATTEMPTS`. Consider importing
  or referencing the constant rather than hardcoding `3` if the test file can
  access it.
- A reviewer should confirm the tests assert the repair *prompt* path
  (`schemaName: "library_html_report_repair"`), not just call counts — call
  counts alone would pass even if the wrong prompt were sent.
