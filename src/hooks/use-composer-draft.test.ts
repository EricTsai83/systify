// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { useComposerDraft } from "./use-composer-draft";
import type { ThreadId, WorkspaceId } from "@/lib/types";

const WS_A = "ws_alpha" as unknown as WorkspaceId;
const WS_B = "ws_beta" as unknown as WorkspaceId;
const TID_A = "tid_alpha" as unknown as ThreadId;
const TID_B = "tid_beta" as unknown as ThreadId;

describe("useComposerDraft", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("initial mount reads the workspace+mode draft from localStorage", () => {
    window.localStorage.setItem(`systify.composer.draft.workspace.${WS_A}.discuss`, "hello");

    const { result } = renderHook(() => useComposerDraft({ workspaceId: WS_A, threadId: null, mode: "discuss" }));
    expect(result.current[0]).toBe("hello");
  });

  test("initial mount reads the thread-scoped draft from localStorage", () => {
    window.localStorage.setItem(`systify.composer.draft.thread.${TID_A}`, "draft for A");

    const { result } = renderHook(() => useComposerDraft({ workspaceId: WS_A, threadId: TID_A, mode: null }));
    expect(result.current[0]).toBe("draft for A");
  });

  test("writes are mirrored to localStorage synchronously (no debounce)", () => {
    const { result } = renderHook(() => useComposerDraft({ workspaceId: WS_A, threadId: null, mode: "discuss" }));

    act(() => result.current[1]("partial"));
    expect(window.localStorage.getItem(`systify.composer.draft.workspace.${WS_A}.discuss`)).toBe("partial");

    act(() => result.current[1]("partial typed more"));
    expect(window.localStorage.getItem(`systify.composer.draft.workspace.${WS_A}.discuss`)).toBe("partial typed more");
  });

  test("setting an empty value removes the key instead of storing an empty string", () => {
    window.localStorage.setItem(`systify.composer.draft.workspace.${WS_A}.discuss`, "non-empty");

    const { result } = renderHook(() => useComposerDraft({ workspaceId: WS_A, threadId: null, mode: "discuss" }));

    act(() => result.current[1](""));
    expect(window.localStorage.getItem(`systify.composer.draft.workspace.${WS_A}.discuss`)).toBeNull();
  });

  test("clear() blanks the value and removes the key", () => {
    window.localStorage.setItem(`systify.composer.draft.thread.${TID_A}`, "abc");

    const { result } = renderHook(() => useComposerDraft({ workspaceId: WS_A, threadId: TID_A, mode: null }));

    expect(result.current[0]).toBe("abc");
    act(() => result.current[2]());
    expect(result.current[0]).toBe("");
    expect(window.localStorage.getItem(`systify.composer.draft.thread.${TID_A}`)).toBeNull();
  });

  test("changing threadId re-reads the new thread's draft", () => {
    window.localStorage.setItem(`systify.composer.draft.thread.${TID_A}`, "from A");
    window.localStorage.setItem(`systify.composer.draft.thread.${TID_B}`, "from B");

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: ThreadId }) => useComposerDraft({ workspaceId: WS_A, threadId, mode: null }),
      { initialProps: { threadId: TID_A } },
    );
    expect(result.current[0]).toBe("from A");

    rerender({ threadId: TID_B });
    expect(result.current[0]).toBe("from B");
  });

  test("changing mode re-reads the per-mode draft for the workspace", () => {
    window.localStorage.setItem(`systify.composer.draft.workspace.${WS_A}.discuss`, "discuss draft");
    window.localStorage.setItem(`systify.composer.draft.workspace.${WS_A}.lab`, "lab draft");

    const { result, rerender } = renderHook(
      ({ mode }: { mode: "discuss" | "lab" }) => useComposerDraft({ workspaceId: WS_A, threadId: null, mode }),
      { initialProps: { mode: "discuss" } },
    );
    expect(result.current[0]).toBe("discuss draft");

    rerender({ mode: "lab" });
    expect(result.current[0]).toBe("lab draft");
  });

  test("changing workspaceId re-reads the new workspace's draft", () => {
    window.localStorage.setItem(`systify.composer.draft.workspace.${WS_A}.discuss`, "ws-A");
    window.localStorage.setItem(`systify.composer.draft.workspace.${WS_B}.discuss`, "ws-B");

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: WorkspaceId }) =>
        useComposerDraft({ workspaceId, threadId: null, mode: "discuss" }),
      { initialProps: { workspaceId: WS_A } },
    );
    expect(result.current[0]).toBe("ws-A");

    rerender({ workspaceId: WS_B });
    expect(result.current[0]).toBe("ws-B");
  });

  test("when the workspace+mode lookup is not derivable, the hook reads/writes nothing", () => {
    const { result } = renderHook(() => useComposerDraft({ workspaceId: null, threadId: null, mode: null }));

    expect(result.current[0]).toBe("");
    act(() => result.current[1]("typed"));
    // No key derivable → no storage write.
    expect(window.localStorage.length).toBe(0);
  });

  test("library mode does not derive a draft key (LibraryAskPanel owns its own state)", () => {
    const { result } = renderHook(() => useComposerDraft({ workspaceId: WS_A, threadId: null, mode: "library" }));
    act(() => result.current[1]("library typing"));
    expect(window.localStorage.length).toBe(0);
    expect(result.current[0]).toBe("library typing");
  });
});
