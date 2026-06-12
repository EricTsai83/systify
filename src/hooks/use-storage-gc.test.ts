// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from "vitest";
import {
  collectStorageGCRepositoryIds,
  collectStorageGCThreadIds,
  sweepRepositoryStorage,
  sweepThreadStorage,
} from "./use-storage-gc";

describe("useStorageGC", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("collects only repository ids present in localStorage cache keys", () => {
    window.localStorage.setItem("systify.library.tabs.repo_a", "{}");
    window.localStorage.setItem("systify.library.askTabs.repo_b", "[]");
    window.localStorage.setItem("systify.composer.draft.repository.repo_c.discuss", "draft");
    window.localStorage.setItem("systify.folderNav.open.repo_d.node", "true");
    window.localStorage.setItem("systify.activeRepositoryId", "repo_e");
    window.localStorage.setItem("vite-ui-theme", "dark");

    expect(collectStorageGCRepositoryIds()).toEqual(["repo_a", "repo_b", "repo_c", "repo_d", "repo_e"]);
  });

  test("collects only thread ids present in localStorage cache keys", () => {
    window.localStorage.setItem("systify.composer.draft.thread.tid_a", "A");
    window.localStorage.setItem("systify.composer.draft.thread.tid_b", "B");
    window.localStorage.setItem("systify.composer.draft.repository.repo_a.discuss", "repo draft");

    expect(collectStorageGCThreadIds()).toEqual(["tid_a", "tid_b"]);
  });

  test("removes orphan repository-scoped keys when their repository is no longer live", () => {
    window.localStorage.setItem("systify.library.tabs.repo_alive", "{}");
    window.localStorage.setItem("systify.library.tabs.repo_gone", "{}");
    window.localStorage.setItem("systify.library.askTabs.repo_alive", "[]");
    window.localStorage.setItem("systify.library.askTabs.repo_gone", "[]");

    sweepRepositoryStorage(new Set(["repo_alive"]));

    expect(window.localStorage.getItem("systify.library.tabs.repo_alive")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.askTabs.repo_alive")).toBe("[]");
    expect(window.localStorage.getItem("systify.library.tabs.repo_gone")).toBeNull();
    expect(window.localStorage.getItem("systify.library.askTabs.repo_gone")).toBeNull();
  });

  test("removes orphan composer-draft repository keys for any mode segment", () => {
    window.localStorage.setItem("systify.composer.draft.repository.repo_alive.discuss", "live discuss");
    window.localStorage.setItem("systify.composer.draft.repository.repo_gone.discuss", "dead discuss");

    sweepRepositoryStorage(new Set(["repo_alive"]));

    expect(window.localStorage.getItem("systify.composer.draft.repository.repo_alive.discuss")).toBe("live discuss");
    expect(window.localStorage.getItem("systify.composer.draft.repository.repo_gone.discuss")).toBeNull();
  });

  test("removes orphan folder-nav repository-scoped keys, preserving live repo keys across multiple nodes", () => {
    window.localStorage.setItem("systify.folderNav.open.repo_alive.node1", "true");
    window.localStorage.setItem("systify.folderNav.open.repo_alive.node2", "false");
    window.localStorage.setItem("systify.folderNav.open.repo_gone.nodeX", "true");
    window.localStorage.setItem("systify.folderNav.open.repo_gone.nodeY", "true");

    sweepRepositoryStorage(new Set(["repo_alive"]));

    expect(window.localStorage.getItem("systify.folderNav.open.repo_alive.node1")).toBe("true");
    expect(window.localStorage.getItem("systify.folderNav.open.repo_alive.node2")).toBe("false");
    expect(window.localStorage.getItem("systify.folderNav.open.repo_gone.nodeX")).toBeNull();
    expect(window.localStorage.getItem("systify.folderNav.open.repo_gone.nodeY")).toBeNull();
  });

  test("removes orphan thread-scoped composer draft keys when the thread is no longer live", () => {
    window.localStorage.setItem("systify.composer.draft.thread.tid_alive", "live draft");
    window.localStorage.setItem("systify.composer.draft.thread.tid_gone", "gone draft");

    sweepThreadStorage(new Set(["tid_alive"]));

    expect(window.localStorage.getItem("systify.composer.draft.thread.tid_alive")).toBe("live draft");
    expect(window.localStorage.getItem("systify.composer.draft.thread.tid_gone")).toBeNull();
  });

  test("re-runs the sweep when the live set shrinks (cross-tab deletion path)", () => {
    window.localStorage.setItem("systify.library.tabs.repo_a", "{}");
    window.localStorage.setItem("systify.library.tabs.repo_b", "{}");

    sweepRepositoryStorage(new Set(["repo_a", "repo_b"]));

    expect(window.localStorage.getItem("systify.library.tabs.repo_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.tabs.repo_b")).toBe("{}");

    sweepRepositoryStorage(new Set(["repo_a"]));

    expect(window.localStorage.getItem("systify.library.tabs.repo_a")).toBe("{}");
    expect(window.localStorage.getItem("systify.library.tabs.repo_b")).toBeNull();
  });

  test("clears stale active repository cache and leaves unrelated keys untouched", () => {
    window.localStorage.setItem("systify.activeRepositoryId", "repo_active");
    window.localStorage.setItem("systify.artifactPanel.open", "true");
    window.localStorage.setItem("vite-ui-theme", "dark");
    window.localStorage.setItem("systify.library.tabs.repo_gone", "{}");

    sweepRepositoryStorage(new Set<string>());

    expect(window.localStorage.getItem("systify.activeRepositoryId")).toBeNull();
    expect(window.localStorage.getItem("systify.artifactPanel.open")).toBe("true");
    expect(window.localStorage.getItem("vite-ui-theme")).toBe("dark");
    expect(window.localStorage.getItem("systify.library.tabs.repo_gone")).toBeNull();
  });
});
