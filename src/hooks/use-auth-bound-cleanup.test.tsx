// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

let mockAuthState: { user: { id: string } | null; isLoading: boolean } = {
  user: null,
  isLoading: false,
};

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockAuthState,
}));

import { useAuthBoundCleanup } from "./use-auth-bound-cleanup";

function seedDrafts() {
  window.localStorage.setItem("systify.composer.draft.thread.tid_a", "draft-A");
  window.localStorage.setItem("systify.composer.draft.repository.repo_a.discuss", "discuss-draft");
  window.localStorage.setItem("systify.composer.draft.repository.repo_a.library", "library-draft");
  // Unrelated key — must survive the sweep.
  window.localStorage.setItem("systify.library.tabs.repo_a", "{}");
}

function draftKeysRemain(): boolean {
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith("systify.composer.draft.")) return true;
  }
  return false;
}

describe("useAuthBoundCleanup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockAuthState = { user: null, isLoading: false };
  });

  test("does not clear drafts on initial mount with no prior user", () => {
    seedDrafts();
    mockAuthState = { user: { id: "user_one" }, isLoading: false };

    renderHook(() => useAuthBoundCleanup());
    expect(draftKeysRemain()).toBe(true);
  });

  test("clears all composer drafts when the user transitions to null (logout)", () => {
    seedDrafts();
    mockAuthState = { user: { id: "user_one" }, isLoading: false };

    const { rerender } = renderHook(() => useAuthBoundCleanup());
    expect(draftKeysRemain()).toBe(true);

    mockAuthState = { user: null, isLoading: false };
    rerender();

    expect(draftKeysRemain()).toBe(false);
    expect(window.localStorage.getItem("systify.library.tabs.repo_a")).toBe("{}");
  });

  test("clears all composer drafts when the user id changes (account switch)", () => {
    seedDrafts();
    mockAuthState = { user: { id: "user_one" }, isLoading: false };

    const { rerender } = renderHook(() => useAuthBoundCleanup());
    mockAuthState = { user: { id: "user_two" }, isLoading: false };
    rerender();

    expect(draftKeysRemain()).toBe(false);
  });

  test("does not clear when the user id is unchanged across renders", () => {
    seedDrafts();
    mockAuthState = { user: { id: "user_one" }, isLoading: false };

    const { rerender } = renderHook(() => useAuthBoundCleanup());
    rerender();

    expect(draftKeysRemain()).toBe(true);
  });

  test("ignores transitions during the isLoading window so silent refresh does not wipe drafts", () => {
    seedDrafts();
    mockAuthState = { user: { id: "user_one" }, isLoading: false };

    const { rerender } = renderHook(() => useAuthBoundCleanup());

    // Silent refresh: isLoading flips, user transiently null.
    mockAuthState = { user: null, isLoading: true };
    rerender();
    expect(draftKeysRemain()).toBe(true);

    // Refresh completes, same user returns.
    mockAuthState = { user: { id: "user_one" }, isLoading: false };
    rerender();
    expect(draftKeysRemain()).toBe(true);
  });
});
