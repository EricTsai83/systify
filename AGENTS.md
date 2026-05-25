# AGENTS.md

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Project Snapshot

Systify is an open source repository analysis app. Users sign in with WorkOS, connect a GitHub App, import repository metadata + knowledge through the GitHub API into Convex (no sandbox involved), and explore the result through (a) a two-mode chat — `discuss` (free-form, with per-message Library and Sandbox grounding toggles the composer surfaces) and `library` (artifact reader + Ask panel) — and (b) `Generate System Design`, a background job that writes reusable System Design artifacts (README summary, architecture / data model / API / deployment / security / operations overviews) into the Library for later chat replies to cite. The chat mode literal, the URL segment, and the user-facing label all use the same vocabulary. Daytona sandboxes are provisioned lazily by the Discuss-mode Sandbox grounding toggle and by LLM-backed System Design kinds — repository import never provisions one.

This is an early-access Bun project. Prefer direct, maintainable changes that improve correctness, reliability, and operability.

## Task Completion Requirements

- Run `bun run format`, `bun run lint`, and `bun run typecheck` before considering code changes complete.
- Run `bun run test` when changing behavior, shared logic, Convex functions, hooks, or tested UI flows.
- Do not run dev servers or builds unless explicitly asked.

## Maintainability

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial
   streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## TypeScript

- Never use `any` unless 100% necessary or specifically instructed.

## Commands

- Don't run dev server commands (e.g., `bun run dev`) - assume it's already running.
- Don't run build commands unless specifically told to.
- Focus on checking commands like `bun run lint`, `bun run format`, and `bun run typecheck` to ensure code is consistent and correct.

## Workflow

- If asked to do too much work at once, stop and state that clearly.
