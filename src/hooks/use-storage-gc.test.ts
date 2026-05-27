// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { useStorageGC } from "./use-storage-gc";

describe("useStorageGC", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("does nothing while the live repository set is null (query still loading)", () => {
    window.localStorage.setItem("systify.library.tabs.repo_a", "{}");
    window.localStorage.setItem("systify.library.askTabs.repo_b", "[]");

    renderHook(() =>
      useStorageGC({
        liveRepositoryIds: null,
      }),
    );

    expect(window.localStorage.getItem("systify.library.tabs.repo_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.askTabs.repo_b")).toBe("[]");
  });

  test("removes orphan repository-scoped keys when their repository is no longer live", () => {
    window.localStorage.setItem("systify.library.tabs.repo_alive", "{}");
    window.localStorage.setItem("systify.library.tabs.repo_gone", "{}");
    window.localStorage.setItem("systify.library.askTabs.repo_alive", "[]");
    window.localStorage.setItem("systify.library.askTabs.repo_gone", "[]");

    renderHook(() =>
      useStorageGC({
        liveRepositoryIds: new Set(["repo_alive"]),
      }),
    );

    expect(window.localStorage.getItem("systify.library.tabs.repo_alive")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.askTabs.repo_alive")).toBe("[]");
    expect(window.localStorage.getItem("systify.library.tabs.repo_gone")).toBeNull();
    expect(window.localStorage.getItem("systify.library.askTabs.repo_gone")).toBeNull();
  });

  test("removes orphan composer-draft repository keys for any mode segment", () => {
    window.localStorage.setItem("systify.composer.draft.repository.repo_alive.discuss", "live discuss");
    window.localStorage.setItem("systify.composer.draft.repository.repo_gone.discuss", "dead discuss");

    renderHook(() =>
      useStorageGC({
        liveRepositoryIds: new Set(["repo_alive"]),
      }),
    );

    expect(window.localStorage.getItem("systify.composer.draft.repository.repo_alive.discuss")).toBe("live discuss");
    expect(window.localStorage.getItem("systify.composer.draft.repository.repo_gone.discuss")).toBeNull();
  });

  test("removes orphan folder-nav repository-scoped keys, preserving live repo keys across multiple nodes", () => {
    window.localStorage.setItem("systify.folderNav.open.repo_alive.node1", "true");
    window.localStorage.setItem("systify.folderNav.open.repo_alive.node2", "false");
    window.localStorage.setItem("systify.folderNav.open.repo_gone.nodeX", "true");
    window.localStorage.setItem("systify.folderNav.open.repo_gone.nodeY", "true");

    renderHook(() =>
      useStorageGC({
        liveRepositoryIds: new Set(["repo_alive"]),
      }),
    );

    expect(window.localStorage.getItem("systify.folderNav.open.repo_alive.node1")).toBe("true");
    expect(window.localStorage.getItem("systify.folderNav.open.repo_alive.node2")).toBe("false");
    expect(window.localStorage.getItem("systify.folderNav.open.repo_gone.nodeX")).toBeNull();
    expect(window.localStorage.getItem("systify.folderNav.open.repo_gone.nodeY")).toBeNull();
  });

  test("removes orphan thread-scoped composer draft keys when the thread is no longer live", () => {
    window.localStorage.setItem("systify.composer.draft.thread.tid_alive", "live draft");
    window.localStorage.setItem("systify.composer.draft.thread.tid_gone", "gone draft");

    renderHook(() =>
      useStorageGC({
        liveRepositoryIds: null,
        liveThreadIds: new Set(["tid_alive"]),
      }),
    );

    expect(window.localStorage.getItem("systify.composer.draft.thread.tid_alive")).toBe("live draft");
    expect(window.localStorage.getItem("systify.composer.draft.thread.tid_gone")).toBeNull();
  });

  test("does not sweep thread-scoped keys when liveThreadIds is null (query loading or not subscribed)", () => {
    window.localStorage.setItem("systify.composer.draft.thread.tid_anything", "x");

    renderHook(() =>
      useStorageGC({
        liveRepositoryIds: null,
      }),
    );

    expect(window.localStorage.getItem("systify.composer.draft.thread.tid_anything")).toBe("x");
  });

  test("re-runs the sweep when the live set shrinks (cross-tab deletion path)", () => {
    window.localStorage.setItem("systify.library.tabs.repo_a", "{}");
    window.localStorage.setItem("systify.library.tabs.repo_b", "{}");

    const { rerender } = renderHook(
      ({ live }: { live: ReadonlySet<string> }) =>
        useStorageGC({
          liveRepositoryIds: live,
        }),
      { initialProps: { live: new Set(["repo_a", "repo_b"]) } },
    );

    expect(window.localStorage.getItem("systify.library.tabs.repo_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.tabs.repo_b")).toBe("{}");

    rerender({ live: new Set(["repo_a"]) });

    expect(window.localStorage.getItem("systify.library.tabs.repo_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.tabs.repo_b")).toBeNull();
  });

  test("leaves unrelated keys untouched", () => {
    window.localStorage.setItem("systify.activeRepositoryId", "repo_active");
    window.localStorage.setItem("systify.artifactPanel.open", "true");
    window.localStorage.setItem("vite-ui-theme", "dark");
    window.localStorage.setItem("systify.library.tabs.repo_gone", "{}");

    renderHook(() =>
      useStorageGC({
        liveRepositoryIds: new Set<string>(),
      }),
    );

    expect(window.localStorage.getItem("systify.activeRepositoryId")).toBe("repo_active");
    expect(window.localStorage.getItem("systify.artifactPanel.open")).toBe("true");
    expect(window.localStorage.getItem("vite-ui-theme")).toBe("dark");
    expect(window.localStorage.getItem("systify.library.tabs.repo_gone")).toBeNull();
  });
});
