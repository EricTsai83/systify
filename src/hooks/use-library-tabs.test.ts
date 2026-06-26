// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArtifactId, RepositoryId } from "@/lib/types";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useSearchParams: () => [new URLSearchParams(window.location.search), vi.fn()],
  };
});

import { useLibraryTabs } from "./use-library-tabs";

const repositoryId = "repo_libtabs" as RepositoryId;
const artifactA = "artifact_a" as ArtifactId;
const artifactB = "artifact_b" as ArtifactId;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  navigateMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLibraryTabs — URL writer", () => {
  test("preserves the page-owned ?ask= param when it writes ?open=", () => {
    window.history.replaceState({}, "", `/r/${repositoryId}/library?ask=thread_x`);

    const { result } = renderHook(() => useLibraryTabs(repositoryId, null));

    act(() => {
      result.current.openTab(artifactA);
      result.current.openTab(artifactB);
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(navigateMock).toHaveBeenCalled();
    const calls = navigateMock.mock.calls;
    const target = calls[calls.length - 1]?.[0] as string;
    expect(target).toContain("ask=thread_x");
    expect(target).toContain(`open=${artifactA}%2C${artifactB}`);
    expect(target.startsWith(`/r/${repositoryId}/library/a/${artifactB}`)).toBe(true);
  });

  test("clears a stale ?open= when the open set drops to one tab, keeping ?ask=", () => {
    window.history.replaceState(
      {},
      "",
      `/r/${repositoryId}/library/a/${artifactA}?ask=thread_x&open=${artifactA}%2C${artifactB}`,
    );

    const { result } = renderHook(() => useLibraryTabs(repositoryId, artifactA));

    act(() => {
      result.current.closeTab(artifactB);
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const calls = navigateMock.mock.calls;
    const target = calls[calls.length - 1]?.[0] as string;
    expect(target).toContain("ask=thread_x");
    expect(target).not.toContain("open=");
  });

  test("drops state.activeArtifactId when the URL transitions to the library landing", () => {
    window.history.replaceState({}, "", `/r/${repositoryId}/library/a/${artifactA}`);

    const { result, rerender } = renderHook(({ active }) => useLibraryTabs(repositoryId, active), {
      initialProps: { active: artifactA as ArtifactId | null },
    });

    expect(result.current.activeArtifactId).toBe(artifactA);
    expect(result.current.openArtifactIds).toContain(artifactA);

    window.history.replaceState({}, "", `/r/${repositoryId}/library`);
    rerender({ active: null });

    expect(result.current.activeArtifactId).toBe(null);
    expect(result.current.openArtifactIds).toContain(artifactA);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const target = navigateMock.mock.calls[navigateMock.mock.calls.length - 1]?.[0] as string;
    expect(target).toBe(`/r/${repositoryId}/library`);
  });

  test("preserves a cached navigator selection when reseeding for a repository", () => {
    const nextRepositoryId = "repo_libtabs_next" as RepositoryId;
    const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.localStorage.setItem(
      `systify.library.tabs.${nextRepositoryId}`,
      JSON.stringify({
        openArtifactIds: [artifactB],
        activeArtifactId: null,
      }),
    );

    try {
      window.history.replaceState({}, "", `/r/${repositoryId}/library/a/${artifactA}`);

      const { result, rerender, unmount } = renderHook(({ repo, active }) => useLibraryTabs(repo, active), {
        initialProps: {
          repo: repositoryId,
          active: artifactA as ArtifactId | null,
        },
      });

      expect(result.current.activeArtifactId).toBe(artifactA);

      window.history.replaceState({}, "", `/r/${nextRepositoryId}/library`);
      rerender({ repo: nextRepositoryId, active: null });

      expect(result.current.openArtifactIds).toEqual([artifactB]);
      expect(result.current.activeArtifactId).toBe(null);
      unmount();
    } finally {
      window.history.replaceState({}, "", previousUrl);
    }
  });
});
