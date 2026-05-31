# System Design Eval Workflow

## Why this exists

Tuning prompts, step budgets, and model picks by gut feel is theatre. Once a
generator is producing artifacts users actually read, "this prompt feels
better" is not a defensible reason to change it. The eval harness in
`convex/eval/systemDesign/` runs the same `SystemDesignKind` against a
SHA-pinned corpus of real GitHub repositories, scores the outputs through an
LLM judge against a per-kind rubric, and writes structured records the
operator can aggregate and diff. Prompt changes ship with data.

The harness doubles as a prompt-regression safety net. Each prompt edit in
`convex/lib/systemDesignPrompts.ts` must bump the corresponding
`SYSTEM_DESIGN_PROMPT_VERSIONS` entry, because the artifact cache key
includes `promptVersion`. A snapshot test
(`convex/systemDesignNode.test.ts`) hashes every prompt at test time and
fails CI when the hash drifts without a version bump — so the bump cannot
be forgotten and the production cache cannot serve stale outputs after an
edit.

It deliberately does NOT live in CI. Each trial is a sandbox-backed LLM
call. The cost is real, the wall-clock is minutes per kind. The harness is
operator-driven: invoked from the CLI, written to local JSONL,
gitignored.

## How it works

### End-to-end tuning loop

1. Edit a prompt in `convex/lib/systemDesignPrompts.ts:40` (`LLM_PROMPTS`).
2. Run `bun run test convex/systemDesignNode.test.ts`. The snapshot test
   in `convex/systemDesignNode.test.ts:46` fails and prints the new FNV-1a
   hash for the changed kind. Bump
   `SYSTEM_DESIGN_PROMPT_VERSIONS[kind]` in
   `convex/lib/systemDesignPrompts.ts:212` AND update the snapshot entry
   for that kind in `PROMPT_SNAPSHOTS`. The two must move together — a
   second test asserts the snapshot version matches the live constant
   (`convex/systemDesignNode.test.ts:74`).
3. Run the harness. The CLI lives in `scripts/evalSystemDesign.ts` and
   wraps the `runEval` internal action at `convex/eval/systemDesign/runner.ts:62`:

   ```
   bun run eval:system-design \
     --repos=py-click:k57abc...,ts-swr:k60jkl...,go-cobra:k61mno... \
     [--corpus=py-click,ts-swr] \
     [--kinds=architecture_overview,security_overview] \
     [--budgets=10,20,30] \
     [--provider=openai] \
     [--model=gpt-5] \
     [--output=eval-results/<custom>.jsonl] \
     [--no-judge]
   ```

   The runner sweeps `(corpus × kind × stepBudget)` for the chosen
   `(provider, modelName)` pair and returns `EvalRunRecord` rows.
4. Inspect the aggregated rollup with `bun run eval:report
   eval-results/<file>.jsonl`. The aggregation is pure TypeScript in
   `convex/eval/systemDesign/aggregate.ts:175` and produces buckets
   keyed by `total`, `byKind`, `byCorpus`, `byProviderModel`, and
   `byKindBudget` (the `kind@stepBudget` key surfaces the
   budget-tipping point).
5. Compare against a baseline run with `bun run eval:diff
   eval-results/before.jsonl eval-results/after.jsonl`. The diff in
   `convex/eval/systemDesign/aggregate.ts:238` groups by
   `(kind, providerModel)` and sorts deltas by absolute judge-score
   change. The README playbook gates merge on no cell regressing
   judge score by 0.30 or more.

### Production-bypass invariants

The runner deliberately bypasses production machinery
(`convex/eval/systemDesign/runner.ts:1-29`):

- No `jobs` row — eval traffic does not pollute job dashboards.
- No `artifacts` row — eval output is throwaway markdown.
- No `systemDesignKindRuns` row — eval lives in local JSONL on the
  operator's machine, separate from production telemetry.

It DOES go through `generateViaGateway` so cost, retries, and rate-limit
telemetry flow through the same pipeline. Eval calls show up tagged
`feature: "system_design"`; judge calls show up tagged `feature:
"eval_judge"`.

### Corpus design

`EVAL_CORPUS` in `convex/eval/systemDesign/corpus.ts:40` is a small set
spanning simple|medium|complex × Python|TypeScript|Go. SHA pinning is
mandatory: every entry ships with `pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE"`.
The operator replaces the placeholder with the SHA they actually imported.
This forces an explicit step that doubles as a "did you actually import
this repo?" check and prevents hallucinated SHAs at write time.

The operator pre-imports each repo into their Convex deployment, then
passes the resolved IDs at invocation time via `--repos=slug:repoId,...`.
The runner takes a `repositoryIds: Record<slug, Id<"repositories">>`
argument (`convex/eval/systemDesign/runner.ts:77`); slugs absent from the
map appear in the `skipped` section of the run output.

Adding a corpus entry is a deliberate act. The corpus comment explicitly
warns against diversity-for-its-own-sake: add an entry when a real
regression slips past the current set, not for breadth.

### Judge model pinning

The judge model is pinned in code at
`convex/eval/systemDesign/judge.ts:38-39`:

```typescript
const JUDGE_PROVIDER = "openai" as const;
const JUDGE_MODEL = "gpt-5-nano";
```

The judge is part of the eval contract — bumping it invalidates every
prior score, because score drift would no longer be subject drift. Living
in code (not env) forces a deliberate edit and a re-baseline of every
checked-in JSONL artifact you want to keep comparable.

The judge does NOT use the AI SDK's `output: object({...})` schema
binding — `gpt-5-nano` cannot reliably round-trip tool-call shaped
output. Instead the judge asks for raw JSON in the prompt, then
`parseJudgeOutput` (`convex/eval/systemDesign/judge.ts:104`) tries direct
parse, falls back to extracting the first balanced `{...}` block, and
returns a `parseError` on failure rather than throwing — the failing
trial still records.

### Rubrics

One rubric markdown per kind lives in
`convex/eval/systemDesign/rubrics/<kind>.md`. The bun CLI loads them
from disk and passes the markdown into the runner via the `rubrics`
argument (`convex/eval/systemDesign/runner.ts:83`); the runner forwards
the markdown verbatim into the judge prompt
(`convex/eval/systemDesign/judge.ts:67-75`). The action itself does NOT
read the filesystem — keeps the Convex bundle self-contained.

The four axes the judge scores are pinned in
`convex/eval/systemDesign/aggregate.ts:29` and
`convex/eval/systemDesign/judge.ts:130-135`:

```typescript
interface JudgeAxisScores {
  faithfulness: number;
  completeness: number;
  specificity: number;
  citationQuality: number;
}
```

Each axis is clamped to 1–5; overall score is the four-axis mean to two
decimal places.

### Result storage

Records serialise as one `EvalRunRecord` per line into JSONL files under
`eval-results/`, written by `scripts/evalSystemDesign.ts`. The directory
is gitignored — eval results are operator-local, not a shared artifact.
The aggregate and diff CLIs read the JSONL back via
`parseEvalRecordsJsonl` (`convex/eval/systemDesign/aggregate.ts:290`).

### Regression gate

The diff CLI surfaces per-`(kind × providerModel)` deltas sorted by
absolute judge-score change (`convex/eval/systemDesign/aggregate.ts:286`).
The README playbook treats a 0.30 judge-score drop on any cell as a
no-merge signal. Use it before merging a prompt change — pick the latest
known-good JSONL as `before`, run the new prompt to produce `after`,
diff.

### Prompt-hash snapshot test

`convex/systemDesignNode.test.ts:37` hashes every prompt with FNV-1a 32-bit
at test time. The expected hashes and versions live inline in
`PROMPT_SNAPSHOTS` (`convex/systemDesignNode.test.ts:46`). When a prompt
edit lands without the matching snapshot + version update, the test fails
with a message that prints the new hash and instructs the editor to bump
both. FNV-1a is deterministic, dependency-free, and works in vitest's
`edge-runtime` environment. No `.snap` file to sync — assertions live
with their data.

A second test in the same file
(`convex/systemDesignNode.test.ts:74`) asserts that
`PROMPT_SNAPSHOTS[kind].version === SYSTEM_DESIGN_PROMPT_VERSIONS[kind]`.
Hash and version always move together.

### Fixture refresh

Fixtures live in `convex/eval/systemDesign/fixtures/<kind>.md`. The
`promptShape` test
(`convex/systemDesignNode.promptShape.test.ts:37`) loads each fixture and
asserts:

- `validateRequiredSections(fixture, EXPECTED_SECTIONS[kind]).ok === true`
- For `architecture_diagram`: `validateMermaidBlock(fixture) === true`

Fixtures are *known-good* outputs that guard the validator contract: if a
regex tweak in `validateRequiredSections`
(`convex/lib/systemDesignPrompts.ts:352`) accidentally rejects valid
output, this test fails before shipping. When `EXPECTED_SECTIONS[kind]`
or the "Write a Markdown document titled … with these sections in
order: …" line in a prompt changes, the matching fixture must update too
— refresh by regenerating from a known-good kind run and pasting the
result.

### Cache bypass during eval

The artifact cache keys on `(repositoryId, kind,
alignedImportCommitSha, generatedByProvider, generatedByModel,
promptVersion)`. The production mutation
`requestSystemDesignGeneration` in `convex/systemDesign.ts:93` exposes a
`forceRegenerate` flag (`convex/systemDesign.ts:113`) that bypasses the
cache when an operator needs a fresh run for ad-hoc inspection. The eval
runner does not write artifacts at all so the cache is structurally
out-of-band; bumping the prompt version naturally invalidates the cache
for subsequent production reads.

## Failure modes & recovery

- **Snapshot test fails after intentional prompt edit.** Read the
  failure message, bump `SYSTEM_DESIGN_PROMPT_VERSIONS[kind]` by 1 in
  `convex/lib/systemDesignPrompts.ts:212`, paste the new hash and the
  new version into `PROMPT_SNAPSHOTS[kind]` in
  `convex/systemDesignNode.test.ts:46`, re-run. Skipping this step
  leaves production cached artifacts stale.

- **Eval score regresses on an unrelated PR.** Someone bumped the judge
  model or shifted the corpus without re-baselining. Diff
  `convex/eval/systemDesign/judge.ts:38-39` and
  `convex/eval/systemDesign/corpus.ts` against the SHA the baseline was
  taken at. Re-baseline if the change was intentional; revert if not.

- **Judge output unparseable.** The runner records the trial with
  `judgeParseError` set and `judgeAxes` left undefined
  (`convex/eval/systemDesign/runner.ts:236`). The trial counts toward
  total trials but not toward `judgeScoredTrials` in the rollup
  (`convex/eval/systemDesign/aggregate.ts:154-157`). If parse errors
  spike for a specific judge model, sharpen the "Return ONLY a JSON
  object" instruction in `convex/eval/systemDesign/judge.ts:58-64` or
  switch to a judge model that round-trips JSON more reliably (and
  re-baseline).

- **Corpus slug missing from `--repos`.** Reported in the `skipped`
  section as `missing_repository_id`
  (`convex/eval/systemDesign/runner.ts:101-106`). Import the repo at
  the pinned SHA and rerun with the resolved ID.

- **Sandbox preparation fails for a corpus repo.** Reported in `skipped`
  with `reason: "sandbox_preparation_failed"` and the original
  `SandboxPreparationError.reason`
  (`convex/eval/systemDesign/runner.ts:114-124`). Re-import the repo if
  the live source has expired; check Daytona status if every entry
  skips.

- **Production-side regression with no eval evidence.** The eval
  harness exercises a fixed corpus; production sees long-tail repos.
  When users report a bad System Design output that the eval did not
  catch, add the offending repo to `EVAL_CORPUS` (with the SHA the
  user was on), re-run, and use the resulting score as the baseline
  for the next prompt iteration. The README's "add entries when a real
  regression slips past" instruction codifies this loop.

- **Production telemetry reads stale after cache invalidation.** Cache
  invalidation happens automatically on `promptVersion` bump; if an
  operator wants to force a re-run without bumping the version (e.g.
  validating a model swap), use `forceRegenerate: true` on
  `requestSystemDesignGeneration` (`convex/systemDesign.ts:207`).

## Future evolution

- **Per-kind step budget tuning.** Today `STEP_BUDGET_BY_KIND` ships
  uniform 20 (`convex/lib/systemDesignPrompts.ts:293`). The `--budgets`
  CLI sweep and the `byKindBudget` rollup
  (`convex/eval/systemDesign/aggregate.ts:189`) are built for the
  tipping-point analysis: once a kind shows the same judge score at 15
  steps and 20 steps with 30% cost savings, drop its budget. Once
  another kind hits the 20-step ceiling repeatedly without converging,
  raise its budget. The harness is the gate.

- **Cross-provider eval.** `--provider` / `--model` flags on the runner
  already allow running the same corpus against OpenAI and Anthropic
  (`convex/eval/systemDesign/runner.ts:69-70`). The `byProviderModel`
  rollup surfaces cost / score / success-rate per pick. Today the
  default-model choice for the production generator is set by
  `DEFAULT_SYSTEM_DESIGN_PROVIDER` / `DEFAULT_SYSTEM_DESIGN_MODEL` in
  `convex/systemDesign.ts`; the eval data is what justifies bumping
  those.

- **Continuous eval gate in CI.** The current harness is too expensive
  to run on every PR (minutes per kind, real LLM cost). When eval cost
  drops enough — cheaper judge model, smaller corpus subset for the
  "smoke" gate, parallelism — the diff CLI is already shaped to gate a
  prompt-changing PR on "no cell regresses judge by ≥ 0.30". Wire
  `bun run eval:diff` into a GitHub Actions job that runs only when
  `convex/lib/systemDesignPrompts.ts` changes.

- **Validator strengthening for `architecture_diagram`.**
  `validateMermaidBlock` (`convex/lib/systemDesignPrompts.ts:393`) only
  checks that a fenced ` ```mermaid ` block exists; bad syntax surfaces
  as a broken render in the artifact reader rather than a quality
  reject. A future iteration can shell out to `mermaid-cli` to parse
  the block during generation; the eval harness will then catch
  syntactic drift before it ships.
