# Plan 007: Clear the copy-feedback timeout in the library editor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c7b6aac..HEAD -- src/components/library-editor.tsx`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `c7b6aac`, 2026-06-24

## Why this matters

The "Copy" affordance in the library editor sets a 1600ms `setTimeout` to reset
its "Copied" state, with no cleanup. Clicking copy repeatedly stacks multiple
timers (each resets the flag independently, so the visual feedback flickers /
ends early), and a timer that fires after the component unmounts calls
`setCopied` on a gone component. React 19 no longer warns on post-unmount
`setState`, so this is low-severity and mostly cosmetic — but it is a textbook
uncancelled-timer leak and a one-line-class fix that makes the affordance behave
predictably under rapid clicks and navigation.

## Current state

File: `src/components/library-editor.tsx` — the artifact reader/editor component.
It already imports `useEffect`, `useState`, `useCallback` from `react`
(`src/components/library-editor.tsx:1`).

The copy handler today (`src/components/library-editor.tsx:75-87`):

```tsx
  const [copied, setCopied] = useState(false);
  const [, runCopy] = useAsyncCallback(async () => {
    if (!artifact) return;
    const copySource = selectedVersion !== null && selectedVersion !== artifact.version ? historicalVersion : artifact;
    if (!copySource) return;
    try {
      await navigator.clipboard.writeText(copySource.contentMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Browsers without clipboard API support — leave the affordance idle.
    }
  });
```

`useAsyncCallback` is imported from `@/hooks/use-async-callback`
(`src/components/library-editor.tsx:12`). `runCopy` is wired to the copy button
elsewhere in the component's JSX (search for `runCopy`).

## Commands you will need

| Purpose          | Command                                   | Expected on success |
|------------------|-------------------------------------------|---------------------|
| Typecheck        | `bun run typecheck`                       | exit 0, no errors   |
| Lint             | `bun run lint`                            | exit 0              |
| Tests (focused)  | `bun run test -- library-editor`          | all pass            |
| Tests (full)     | `bun run test`                            | all pass            |
| Format           | `bun run format`                          | writes, exit 0      |

## Scope

**In scope** (the only file you should modify):
- `src/components/library-editor.tsx`
- `src/components/library-editor.test.tsx` (extend — it already exists)

**Out of scope** (do NOT touch):
- `@/hooks/use-async-callback` — do not change the shared hook.
- Any other component using the copy pattern; this plan is the editor only.

## Git workflow

- Branch: `advisor/007-clear-copy-feedback-timeout`
- Commit message style matches `git log` (imperative, capitalized, no trailing
  period — e.g. "Clear copy-feedback timeout on unmount").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Track the timeout id in a ref and clear it before re-arming and on unmount

Add a `useRef<ReturnType<typeof window.setTimeout> | null>(null)` near the
`copied` state. Update `runCopy` to clear any existing timer before setting a new
one, and add a `useEffect` cleanup that clears the timer on unmount.

Target shape:

```tsx
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
    };
  }, []);
  const [, runCopy] = useAsyncCallback(async () => {
    if (!artifact) return;
    const copySource = selectedVersion !== null && selectedVersion !== artifact.version ? historicalVersion : artifact;
    if (!copySource) return;
    try {
      await navigator.clipboard.writeText(copySource.contentMarkdown);
      setCopied(true);
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
      copyResetTimer.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimer.current = null;
      }, 1600);
    } catch {
      // Browsers without clipboard API support — leave the affordance idle.
    }
  });
```

Add `useRef` to the existing `react` import on line 1
(`import { useCallback, useEffect, useRef, useState } from "react";`).

**Verify**: `bun run typecheck` → exit 0, no errors.

### Step 2: Extend the editor test

In `src/components/library-editor.test.tsx`, add a test that asserts the copy
affordance shows "Copied" after a click and resets after the timeout, using fake
timers, and — most importantly — that unmounting before the timer fires does not
throw and does not call `setCopied` after unmount. Follow the existing test
file's setup/mocking conventions (it already renders the editor; reuse its
fixtures and any clipboard mock present, or add one with
`vi.spyOn(navigator.clipboard, "writeText")`).

Minimum assertions:
- After clicking copy, the button label/state reflects "Copied".
- With `vi.useFakeTimers()`, advancing 1600ms resets it.
- Unmounting immediately after a copy click, then advancing timers, produces no
  thrown error (the cleanup ran).

**Verify**: `bun run test -- library-editor` → all pass, including the new test.

### Step 3: Full gates

**Verify**: run in order, each exit 0 / all pass:
- `bun run format`
- `bun run lint`
- `bun run test`

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` passes; `library-editor.test.tsx` includes the new
      copy-timeout test and passes
- [ ] `grep -n "clearTimeout" src/components/library-editor.tsx` returns at least
      one match
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The copy handler at `src/components/library-editor.tsx:75-87` does not match
  the "Current state" excerpt (the file has drifted).
- The existing `library-editor.test.tsx` cannot render the editor without a live
  Convex backend / unmockable dependency for this case — report what blocks it.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- This is the canonical pattern for the editor's transient feedback. If other
  transient timers are added to this component, route them through the same
  ref-and-cleanup approach.
- A reviewer should confirm the cleanup effect has an empty dependency array (it
  guards a ref, not state) and that the timer ref is nulled inside the callback
  so a fired timer leaves a clean slate.
