# System Design Eval Harness

This directory holds the offline eval harness for the System Design generator. It is **operator-driven** — it runs from the CLI, against a SHA-pinned corpus of real GitHub repositories, and produces local JSONL files. It is intentionally separate from production telemetry (`convex/eval/systemDesign/report.ts`) — eval iteration cadence should not be coupled to live data.

## What this harness measures

For each `(corpus × kind × stepBudget × provider × model)` trial:

- Did the LLM call succeed against the provider?
- Did the output pass the kind's structural validators (sections present, Mermaid block present for `architecture_diagram`)?
- How did an LLM judge score the output across four axes (faithfulness, completeness, specificity, citation quality)?
- What did the trial cost in tokens, dollars, and wall-clock?

Records are written to `eval-results/<UTC-timestamp>.jsonl` (gitignored). The `report` and `diff` CLIs aggregate those files.

## When to run

Run the harness:

- Before merging any change to `LLM_PROMPTS`, `SYSTEM_DESIGN_PROMPT_VERSIONS`, or `STEP_BUDGET_BY_KIND` in `convex/lib/systemDesignPrompts.ts`.
- Before bumping `DEFAULT_SYSTEM_DESIGN_PROVIDER` / `DEFAULT_SYSTEM_DESIGN_MODEL` in `convex/systemDesign.ts`.
- After adding a new corpus entry (to baseline the new repo's behaviour across kinds).
- Roughly weekly during active tuning; otherwise on-demand.

**Do not run from CI.** Each trial is a sandbox-backed LLM call — the cost is real, the wall-clock is minutes per kind. CI should run the unit tests in `convex/lib/systemDesignPrompts.test.ts` and the snapshot test in `convex/systemDesignNode.test.ts`; those are deterministic and cheap.

## Prerequisites

The eval action provisions a Daytona sandbox for each corpus entry. The repos must be **pre-imported** into your Convex deployment:

1. Look at `corpus.ts` for the `sourceRepoFullName` of each corpus entry.
2. Replace every `pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE"` with the actual commit SHA you intend to pin (and import the repo at exactly that SHA).
3. Import each repo through the normal app flow (sign in, connect GitHub, add the repo).
4. Note each corpus entry's resulting `repositoryId` (visible in the Convex dashboard under the `repositories` table).
5. Pass them via `--repos=slug:repoId,slug:repoId` when invoking the eval CLI.

## Running an eval

Full sweep across all kinds at the default budget (20), using the catalog's default `(openai, gpt-5)`:

```
bun run eval:system-design \
  --repos=py-click:k57abc...,py-fastapi:k58def...,ts-chalk:k59ghi...,ts-swr:k60jkl...,go-cobra:k61mno...,go-grafana:k62pqr...
```

Single kind, budget sweep (cheap iteration loop when tuning one prompt):

```
bun run eval:system-design \
  --repos=ts-swr:k60jkl...,go-cobra:k61mno... \
  --kinds=architecture_diagram \
  --budgets=10,15,20,25
```

Cross-provider comparison:

```
bun run eval:system-design --repos=... --provider=anthropic --model=claude-sonnet-4-6 \
  --output=eval-results/2026-06-01-anthropic-sonnet.jsonl
```

Smoke run with no judge (validates the prompt + sandbox pipeline without paying for judge tokens):

```
bun run eval:system-design --repos=py-click:k57abc... --no-judge
```

## Reading a report

```
bun run eval:report eval-results/2026-06-01.jsonl
```

The report prints:

- **Headline** — total trials, success rate, mean judge score, total cost, mean cost per trial, mean wall-clock per trial.
- **By kind** — same shape, per `SystemDesignKind`. Spot kinds whose success rate or judge score lag the others.
- **By corpus** — per-repo difficulty. If `go-grafana` drags every judge score down, the prompt may need adjustment for monorepo-scale code.
- **By provider:model** — cost / score / success comparison across models.
- **By kind@budget** — surfaces the budget tipping point: if `architecture_overview@20` scores the same as `architecture_overview@15` at 30% more cost, drop the budget.

## Diffing two runs

```
bun run eval:diff eval-results/before.jsonl eval-results/after.jsonl
```

Prints per-`(kind × provider:model)` deltas, sorted by `|judge score delta|` descending. Flags:

- `▲` in the judge column = score improved by ≥ 0.30.
- `▼` = score regressed by ≥ 0.30.
- `▲` in the success column = success rate up ≥ 10 percentage points.
- `▲` in the cost-per-success column = cheaper per success by ≥ $0.001.

**Regression playbook**: if any `(kind × providerModel)` cell shows a judge-score regression of ≥ 0.30, do NOT merge the change. Open the JSONL, find one failing trial, read `judgeComments` and `missingSections`, and decide:

- The judge is right → revert or revise the prompt.
- The judge is wrong → the rubric needs sharpening; update `rubrics/<kind>.md` and re-run.

## Target metrics

Initial seeds (tune as data accumulates):

| Metric | Target |
| --- | --- |
| Mean judge score per kind | ≥ 3.5 / 5 |
| Success rate per kind | ≥ 80% (succeeded / total trials) |
| Mean cost per kind on `gpt-5` | ≤ $0.15 per trial |
| Mean cost per kind on `claude-sonnet-4-6` | ≤ $0.10 per trial |

Beat the table by 0.3+ on judge → consider promoting the change. Miss the table by 0.3+ → block the merge.

## Prompt version bumps

Editing a prompt in `convex/lib/systemDesignPrompts.ts`:

1. Edit the relevant string in `LLM_PROMPTS[kind]`.
2. Bump `SYSTEM_DESIGN_PROMPT_VERSIONS[kind]` by 1.
3. Update `convex/systemDesignNode.test.ts` — the snapshot test stores the FNV-1a hash of each prompt. Run `bun run test convex/systemDesignNode.test.ts` once; the failure message reports the new hash; update the snapshot entry to the new hash and the new version.
4. Run the eval harness to baseline the new prompt. Use `eval:diff` to compare against the prior `pinnedSha`'s baseline.

The snapshot test exists so a prompt edit cannot land silently without invalidating the production artifact cache (which keys on `promptVersion`). Forgetting to bump the version would leave production serving stale cached artifacts.

## Fixture refresh flow

The fixtures under `fixtures/<kind>.md` are *known-good* outputs that pass the prompt's structural validators. They guard the validator contract via `convex/systemDesignNode.promptShape.test.ts`.

If you change `EXPECTED_SECTIONS[kind]` or the prompt's "Write a Markdown document titled … with these sections in order: …" line, also update the matching fixture so the section names line up. The fixture test fails fast otherwise.

## Adding a corpus entry

1. Append a new entry to `EVAL_CORPUS` in `corpus.ts` — pick a slug, the GitHub `owner/repo`, a stable `pinnedSha`, language, complexity.
2. Import that repo into your Convex deployment at the pinned SHA.
3. Run `bun run eval:system-design --repos=...` including the new slug. The harness picks it up; no other code change needed.

Prefer adding entries that exercise a *new* failure mode the current corpus misses — a monorepo with multiple services, a project in a language not yet covered, a repo with sparse documentation that stresses the README prompt. Diversity-for-its-own-sake adds eval cost without insight.
