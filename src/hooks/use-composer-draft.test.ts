// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { useComposerDraft } from "./use-composer-draft";
import type { RepositoryId, ThreadId } from "@/lib/types";

const REPO_A = "repo_alpha" as unknown as RepositoryId;
const REPO_B = "repo_beta" as unknown as RepositoryId;
const TID_A = "tid_alpha" as unknown as ThreadId;
const TID_B = "tid_beta" as unknown as ThreadId;
const USER_A = "user_alpha";
const USER_B = "user_beta";

function repositoryDraftKey(userId: string, repositoryId: RepositoryId, mode = "discuss"): string {
  return `systify.composer.draft.user.${encodeURIComponent(userId)}.repository.${repositoryId}.${mode}`;
}

function threadDraftKey(userId: string, threadId: ThreadId): string {
  return `systify.composer.draft.user.${encodeURIComponent(userId)}.thread.${threadId}`;
}

function repolessDraftKey(userId: string): string {
  return `systify.composer.draft.user.${encodeURIComponent(userId)}.chat`;
}

describe("useComposerDraft", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("initial mount reads the repository+mode draft from localStorage", () => {
    window.localStorage.setItem(repositoryDraftKey(USER_A, REPO_A), "hello");

    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId: null, mode: "discuss" }),
    );
    expect(result.current[0]).toBe("hello");
  });

  test("initial mount reads the thread-scoped draft from localStorage", () => {
    window.localStorage.setItem(threadDraftKey(USER_A, TID_A), "draft for A");

    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId: TID_A, mode: null }),
    );
    expect(result.current[0]).toBe("draft for A");
  });

  test("writes are mirrored to localStorage synchronously (no debounce)", () => {
    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId: null, mode: "discuss" }),
    );

    act(() => result.current[1]("partial"));
    expect(window.localStorage.getItem(repositoryDraftKey(USER_A, REPO_A))).toBe("partial");

    act(() => result.current[1]("partial typed more"));
    expect(window.localStorage.getItem(repositoryDraftKey(USER_A, REPO_A))).toBe("partial typed more");
  });

  test("setting an empty value removes the key instead of storing an empty string", () => {
    window.localStorage.setItem(repositoryDraftKey(USER_A, REPO_A), "non-empty");

    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId: null, mode: "discuss" }),
    );

    act(() => result.current[1](""));
    expect(window.localStorage.getItem(repositoryDraftKey(USER_A, REPO_A))).toBeNull();
  });

  test("clear() blanks the value and removes the key", () => {
    window.localStorage.setItem(threadDraftKey(USER_A, TID_A), "abc");

    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId: TID_A, mode: null }),
    );

    expect(result.current[0]).toBe("abc");
    act(() => result.current[2]());
    expect(result.current[0]).toBe("");
    expect(window.localStorage.getItem(threadDraftKey(USER_A, TID_A))).toBeNull();
  });

  test("changing threadId re-reads the new thread's draft", () => {
    window.localStorage.setItem(threadDraftKey(USER_A, TID_A), "from A");
    window.localStorage.setItem(threadDraftKey(USER_A, TID_B), "from B");

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: ThreadId }) =>
        useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId, mode: null }),
      { initialProps: { threadId: TID_A } },
    );
    expect(result.current[0]).toBe("from A");

    rerender({ threadId: TID_B });
    expect(result.current[0]).toBe("from B");
  });

  test("changing mode to library drops the repository draft key (Library has its own panel)", () => {
    window.localStorage.setItem(repositoryDraftKey(USER_A, REPO_A), "discuss draft");

    const { result, rerender } = renderHook(
      ({ mode }: { mode: "discuss" | "library" }) =>
        useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId: null, mode }),
      { initialProps: { mode: "discuss" } },
    );
    expect(result.current[0]).toBe("discuss draft");

    rerender({ mode: "library" });
    expect(result.current[0]).toBe("");
    act(() => result.current[1]("library typing"));
    expect(window.localStorage.getItem(repositoryDraftKey(USER_A, REPO_A, "library"))).toBeNull();
  });

  test("changing repositoryId re-reads the new repository's draft", () => {
    window.localStorage.setItem(repositoryDraftKey(USER_A, REPO_A), "repo-A");
    window.localStorage.setItem(repositoryDraftKey(USER_A, REPO_B), "repo-B");

    const { result, rerender } = renderHook(
      ({ repositoryId }: { repositoryId: RepositoryId }) =>
        useComposerDraft({ authUserId: USER_A, repositoryId, threadId: null, mode: "discuss" }),
      { initialProps: { repositoryId: REPO_A } },
    );
    expect(result.current[0]).toBe("repo-A");

    rerender({ repositoryId: REPO_B });
    expect(result.current[0]).toBe("repo-B");
  });

  test("repoless + no thread derives the dedicated `/chat` draft bucket", () => {
    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: null, threadId: null, mode: null }),
    );

    expect(result.current[0]).toBe("");
    act(() => result.current[1]("typed"));
    expect(window.localStorage.getItem(repolessDraftKey(USER_A))).toBe("typed");
  });

  test("repoless draft survives the lazy thread switch by reading the existing chat bucket", () => {
    window.localStorage.setItem(repolessDraftKey(USER_A), "hello repoless");
    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: null, threadId: null, mode: null }),
    );
    expect(result.current[0]).toBe("hello repoless");
  });

  test("library mode does not derive a draft key (LibraryAskPanel owns its own state)", () => {
    const { result } = renderHook(() =>
      useComposerDraft({ authUserId: USER_A, repositoryId: REPO_A, threadId: null, mode: "library" }),
    );
    act(() => result.current[1]("library typing"));
    expect(window.localStorage.length).toBe(0);
    expect(result.current[0]).toBe("library typing");
  });

  test("draft keys are isolated by authenticated user id", () => {
    window.localStorage.setItem(repositoryDraftKey(USER_A, REPO_A), "user A draft");
    window.localStorage.setItem(repositoryDraftKey(USER_B, REPO_A), "user B draft");

    const { result, rerender } = renderHook(
      ({ authUserId }: { authUserId: string | null }) =>
        useComposerDraft({ authUserId, repositoryId: REPO_A, threadId: null, mode: "discuss" }),
      { initialProps: { authUserId: USER_A as string | null } },
    );
    expect(result.current[0]).toBe("user A draft");

    rerender({ authUserId: null });
    expect(result.current[0]).toBe("");

    rerender({ authUserId: USER_B });
    expect(result.current[0]).toBe("user B draft");
  });
});
