// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { KeyboardEvent, RefObject } from "react";
import { useInlineRename } from "./use-inline-rename";

function makeKeyEvent<T extends HTMLElement>(key: string): KeyboardEvent<T> {
  const preventDefault = vi.fn();
  return { key, preventDefault } as unknown as KeyboardEvent<T>;
}

describe("useInlineRename", () => {
  test("Enter + blur race produces exactly one commit", async () => {
    // Regression guard for the double-commit race: the Enter keypress that
    // exits edit mode synchronously calls commit, then the input's
    // unmount-blur calls commit again. The `isCommittingRef` latch must
    // collapse them to one server call.
    const onCommit = vi.fn(async () => {});
    const { result } = renderHook(() => useInlineRename({ currentValue: "old", onCommit }));

    act(() => result.current.startEdit());
    act(() => result.current.setDraft("new"));

    await act(async () => {
      const p1 = result.current.commit();
      const p2 = result.current.commit();
      await Promise.all([p1, p2]);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("new");
  });

  test("Esc + blur race cancels with no commit and onCancel fires exactly once", async () => {
    const onCommit = vi.fn(async () => {});
    const onCancel = vi.fn();
    const { result } = renderHook(() => useInlineRename({ currentValue: "old", onCommit, onCancel }));

    act(() => result.current.startEdit());
    act(() => result.current.setDraft("new"));

    await act(async () => {
      result.current.cancel();
      await result.current.commit();
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("mid-edit currentValue change does not shift the no-op baseline", async () => {
    // The whole reason `originalValueRef` is a ref captured at edit-start —
    // not a live read of `currentValue`. If the parent's subscription lands
    // a server-side update mid-edit, a blur with no user input must NOT
    // commit the *new* live value to the server (clobbering the autogen /
    // sibling write) — and must NOT commit the *old* draft either. Both
    // are no-ops because the trimmed draft matches the snapshot.
    const onCommit = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      ({ currentValue }: { currentValue: string }) => useInlineRename({ currentValue, onCommit }),
      { initialProps: { currentValue: "alpha" } },
    );

    act(() => result.current.startEdit());
    expect(result.current.draft).toBe("alpha");

    rerender({ currentValue: "beta" });

    await act(async () => {
      await result.current.commit();
    });

    expect(onCommit).not.toHaveBeenCalled();
  });

  test("F2 on a focused row enters edit mode", () => {
    const onCommit = vi.fn(async () => {});
    const { result } = renderHook(() => useInlineRename({ currentValue: "old", onCommit }));

    expect(result.current.isEditing).toBe(false);

    act(() => {
      result.current.handleRowKeyDown(makeKeyEvent<HTMLElement>("F2"));
    });

    expect(result.current.isEditing).toBe(true);
    expect(result.current.draft).toBe("old");
  });

  test("onCancel fires on Esc, not on a no-op blur", async () => {
    // The folder fresh-create flow hangs the "discard the just-spawned
    // folder" side-effect off `onCancel`. A no-op blur (Enter with no
    // change, blur with empty draft after startEditEmpty) must NOT trigger
    // that destructive path — otherwise the user's just-created folder
    // would evaporate on the first idle blur.
    const onCommit = vi.fn(async () => {});
    const onCancel = vi.fn();
    const { result } = renderHook(() => useInlineRename({ currentValue: "old", onCommit, onCancel }));

    act(() => result.current.startEdit());
    await act(async () => {
      await result.current.commit();
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();

    act(() => result.current.startEdit());
    act(() => result.current.cancel());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("startEditEmpty seeds an empty draft and an empty-blur is a no-op", async () => {
    const onCommit = vi.fn(async () => {});
    const { result } = renderHook(() => useInlineRename({ currentValue: "New folder", onCommit }));

    act(() => result.current.startEditEmpty());
    expect(result.current.draft).toBe("");

    await act(async () => {
      await result.current.commit();
    });

    expect(onCommit).not.toHaveBeenCalled();
  });

  test("commit rejection clears isCommitting and onError is called; a subsequent commit runs again", async () => {
    const onCommit = vi
      .fn<(next: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({ currentValue: "old", onCommit, onError, errorFallback: "Rename failed." }),
    );

    act(() => result.current.startEdit());
    act(() => result.current.setDraft("new"));

    await act(async () => {
      await result.current.commit();
    });

    expect(result.current.isCommitting).toBe(false);
    expect(onError).toHaveBeenCalledWith("boom");
    expect(onCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.commit();
    });

    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  test("after a no-op commit, focus moves from input back to the row's first button", async () => {
    // End-to-end check for the focus-restoration effect: Enter on a no-op
    // edit blurs the input → activeElement falls back to <body> → the
    // effect should reclaim focus to the row's button so the keyboard user
    // stays in the same row.
    const rowDiv = document.createElement("div");
    const button = document.createElement("button");
    rowDiv.appendChild(button);
    document.body.appendChild(rowDiv);

    try {
      const onCommit = vi.fn(async () => {});
      const rowRef: RefObject<HTMLElement | null> = { current: rowDiv };
      const { result } = renderHook(() => useInlineRename({ currentValue: "old", onCommit, rowRef }));

      act(() => result.current.startEdit());
      // The effect's "is anything focused?" branch only kicks in when
      // activeElement === body. JSDOM defaults to that, but blur any
      // residual focus just in case a prior test left it elsewhere.
      (document.activeElement as HTMLElement | null)?.blur();

      await act(async () => {
        await result.current.commit();
      });

      expect(document.activeElement).toBe(button);
    } finally {
      document.body.removeChild(rowDiv);
    }
  });
});
