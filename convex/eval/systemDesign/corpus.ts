/**
 * SHA-pinned eval corpus.
 *
 * Lists the GitHub repositories the System Design eval harness exercises
 * against. Each entry pins a `pinnedSha` so a re-run weeks later compares
 * apples-to-apples — drifting `main` would let prompt-quality regressions
 * hide behind upstream content changes.
 *
 * The corpus is deliberately small: enough to span simple|medium|complex
 * × Python|TS|Go without ballooning eval cost. Add entries when a real
 * regression slips past the existing set; never as bulk diversity.
 *
 * The operator must pre-import each corpus repo into their Convex
 * deployment before running `bun run eval:system-design`. The runner
 * takes a slug→repositoryId map at invocation time (see
 * `convex/eval/systemDesign/README.md`).
 *
 * **SHA placeholder policy.** Every `pinnedSha` ships as a placeholder
 * (`PLACEHOLDER_*`). The operator replaces them with the SHA matching
 * the snapshot they imported. This avoids hallucinated SHAs at write
 * time and forces an explicit operator step that doubles as a
 * "did you actually import this repo?" check.
 */

export type CorpusLanguage = "python" | "typescript" | "go";
export type CorpusComplexity = "simple" | "medium" | "complex";

export interface EvalCorpusEntry {
  /** Stable kebab-case key. Used by CLI `--corpus=` filter and as the
   *  key in the operator-provided slug→repositoryId map. Never rename
   *  a value — historical JSONL records carry the slug verbatim. */
  slug: string;
  description: string;
  sourceRepoFullName: string;
  pinnedSha: string;
  language: CorpusLanguage;
  complexity: CorpusComplexity;
}

export const EVAL_CORPUS: readonly EvalCorpusEntry[] = [
  {
    slug: "py-click",
    description: "Small Python CLI library (single package, no DB, no service surface).",
    sourceRepoFullName: "pallets/click",
    pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE",
    language: "python",
    complexity: "simple",
  },
  {
    slug: "py-fastapi",
    description: "Medium Python web framework with extensive routing, deps, and docs.",
    sourceRepoFullName: "tiangolo/fastapi",
    pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE",
    language: "python",
    complexity: "medium",
  },
  {
    slug: "ts-chalk",
    description: "Small TypeScript terminal-styling library (single module, no async, no IO).",
    sourceRepoFullName: "chalk/chalk",
    pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE",
    language: "typescript",
    complexity: "simple",
  },
  {
    slug: "ts-swr",
    description: "Medium TS React data-fetching library with provider context and middleware.",
    sourceRepoFullName: "vercel/swr",
    pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE",
    language: "typescript",
    complexity: "medium",
  },
  {
    slug: "go-cobra",
    description: "Small Go CLI framework, exemplary for command/subcommand routing analysis.",
    sourceRepoFullName: "spf13/cobra",
    pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE",
    language: "go",
    complexity: "simple",
  },
  {
    slug: "go-grafana",
    description: "Complex Go monorepo with services, frontends, plugins, deployment configs.",
    sourceRepoFullName: "grafana/grafana",
    pinnedSha: "PLACEHOLDER_REPLACE_BEFORE_USE",
    language: "go",
    complexity: "complex",
  },
];

export interface FilterCorpusOptions {
  slugs?: readonly string[];
  languages?: readonly CorpusLanguage[];
  complexities?: readonly CorpusComplexity[];
}

export function filterCorpus(corpus: readonly EvalCorpusEntry[], opts: FilterCorpusOptions = {}): EvalCorpusEntry[] {
  return corpus.filter((entry) => {
    if (opts.slugs && opts.slugs.length > 0 && !opts.slugs.includes(entry.slug)) return false;
    if (opts.languages && opts.languages.length > 0 && !opts.languages.includes(entry.language)) return false;
    if (opts.complexities && opts.complexities.length > 0 && !opts.complexities.includes(entry.complexity))
      return false;
    return true;
  });
}

export function getCorpusEntry(slug: string): EvalCorpusEntry | undefined {
  return EVAL_CORPUS.find((entry) => entry.slug === slug);
}
