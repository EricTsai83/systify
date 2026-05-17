// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useStorageGC } from "./use-storage-gc";

describe("useStorageGC", () => {
  test("does nothing while the live workspace set is null (query still loading)", () => {
    window.localStorage.setItem("systify.library.tabs.ws_a", "{}");
    window.localStorage.setItem("systify.library.askTabs.ws_b", "[]");

    renderHook(() =>
      useStorageGC({
        liveWorkspaceIds: null,
        liveRepositoryIds: null,
      }),
    );

    // No sweep: both keys must survive an initial `loading` snapshot or we'd
    // wipe a brand-new tab's entire cache before its first paint.
    expect(window.localStorage.getItem("systify.library.tabs.ws_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.askTabs.ws_b")).toBe("[]");
  });

  test("removes orphan workspace-scoped keys when their workspace is no longer live", () => {
    window.localStorage.setItem("systify.library.tabs.ws_alive", "{}");
    window.localStorage.setItem("systify.library.tabs.ws_gone", "{}");
    window.localStorage.setItem("systify.library.askTabs.ws_alive", "[]");
    window.localStorage.setItem("systify.library.askTabs.ws_gone", "[]");

    renderHook(() =>
      useStorageGC({
        liveWorkspaceIds: new Set(["ws_alive"]),
        liveRepositoryIds: null,
      }),
    );

    expect(window.localStorage.getItem("systify.library.tabs.ws_alive")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.askTabs.ws_alive")).toBe("[]");
    expect(window.localStorage.getItem("systify.library.tabs.ws_gone")).toBeNull();
    expect(window.localStorage.getItem("systify.library.askTabs.ws_gone")).toBeNull();
  });

  test("removes orphan repository-scoped keys, preserving live repo keys across multiple nodes", () => {
    window.localStorage.setItem("systify.folderNav.open.repo_alive.node1", "true");
    window.localStorage.setItem("systify.folderNav.open.repo_alive.node2", "false");
    window.localStorage.setItem("systify.folderNav.open.repo_gone.nodeX", "true");
    window.localStorage.setItem("systify.folderNav.open.repo_gone.nodeY", "true");

    renderHook(() =>
      useStorageGC({
        liveWorkspaceIds: null,
        liveRepositoryIds: new Set(["repo_alive"]),
      }),
    );

    expect(window.localStorage.getItem("systify.folderNav.open.repo_alive.node1")).toBe("true");
    expect(window.localStorage.getItem("systify.folderNav.open.repo_alive.node2")).toBe("false");
    expect(window.localStorage.getItem("systify.folderNav.open.repo_gone.nodeX")).toBeNull();
    expect(window.localStorage.getItem("systify.folderNav.open.repo_gone.nodeY")).toBeNull();
  });

  test("re-runs the sweep when the live set shrinks (cross-tab deletion path)", () => {
    window.localStorage.setItem("systify.library.tabs.ws_a", "{}");
    window.localStorage.setItem("systify.library.tabs.ws_b", "{}");

    const { rerender } = renderHook(
      ({ live }: { live: ReadonlySet<string> }) =>
        useStorageGC({
          liveWorkspaceIds: live,
          liveRepositoryIds: null,
        }),
      { initialProps: { live: new Set(["ws_a", "ws_b"]) } },
    );

    // Both alive → both kept.
    expect(window.localStorage.getItem("systify.library.tabs.ws_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.tabs.ws_b")).toBe("{}");

    // Live set shrinks (workspace deleted in another tab — the Convex
    // subscription pushes a new `listWorkspaces` snapshot here).
    rerender({ live: new Set(["ws_a"]) });

    expect(window.localStorage.getItem("systify.library.tabs.ws_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.tabs.ws_b")).toBeNull();
  });

  test("leaves unrelated keys untouched", () => {
    window.localStorage.setItem("systify.activeWorkspaceId", "ws_active");
    window.localStorage.setItem("systify.artifactPanel.open", "true");
    window.localStorage.setItem("vite-ui-theme", "dark");
    window.localStorage.setItem("systify.library.tabs.ws_gone", "{}");

    renderHook(() =>
      useStorageGC({
        liveWorkspaceIds: new Set<string>(),
        liveRepositoryIds: new Set<string>(),
      }),
    );

    expect(window.localStorage.getItem("systify.activeWorkspaceId")).toBe("ws_active");
    expect(window.localStorage.getItem("systify.artifactPanel.open")).toBe("true");
    expect(window.localStorage.getItem("vite-ui-theme")).toBe("dark");
    expect(window.localStorage.getItem("systify.library.tabs.ws_gone")).toBeNull();
  });
});
