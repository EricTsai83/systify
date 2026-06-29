import { describe, expect, test } from "vitest";
import { resolveRepositorySelection } from "./repository-selection";
import type { RepositoryId } from "./types";

const repo = (id: string) => id as RepositoryId;

describe("resolveRepositorySelection", () => {
  test("DB preference wins when it points at a live repository", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        cachedRepositoryId: repo("local"),
        preferenceRepositoryId: repo("db"),
        switcherRepositoryIds: [repo("db"), repo("local")],
        ownerRepositoryIds: new Set([repo("db"), repo("local")]),
      }),
    ).toEqual({
      cachedRepositoryId: repo("db"),
      currentRepositoryId: repo("db"),
      commands: [{ kind: "setCachedRepository", repositoryId: repo("db") }],
    });
  });

  test("URL repository is canonical when present and live", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: repo("url"),
        cachedRepositoryId: repo("db"),
        preferenceRepositoryId: repo("db"),
        switcherRepositoryIds: [repo("db"), repo("url")],
        ownerRepositoryIds: new Set([repo("db"), repo("url")]),
      }).commands,
    ).toEqual([
      { kind: "setCachedRepository", repositoryId: repo("url") },
      { kind: "touchRepository", repositoryId: repo("url") },
    ]);
  });

  test("stale URL navigates to the default authenticated route", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: repo("gone"),
        cachedRepositoryId: repo("live"),
        preferenceRepositoryId: repo("live"),
        switcherRepositoryIds: [repo("live")],
        ownerRepositoryIds: new Set([repo("live")]),
      }),
    ).toEqual({
      cachedRepositoryId: repo("live"),
      currentRepositoryId: null,
      commands: [{ kind: "navigateDefault", replace: true }],
    });
  });

  test("fallback selection seeds DB preference", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        cachedRepositoryId: null,
        preferenceRepositoryId: null,
        switcherRepositoryIds: [repo("recent")],
        ownerRepositoryIds: new Set([repo("recent")]),
      }).commands,
    ).toEqual([
      { kind: "setCachedRepository", repositoryId: repo("recent") },
      { kind: "touchRepository", repositoryId: repo("recent") },
    ]);
  });

  test("deleted repository id clears cached state when there is no fallback", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        cachedRepositoryId: repo("gone"),
        preferenceRepositoryId: repo("gone"),
        switcherRepositoryIds: [],
        ownerRepositoryIds: new Set(),
      }).commands,
    ).toEqual([{ kind: "setCachedRepository", repositoryId: null }]);
  });

  test("live cached repo outside the switcher top page is not overwritten", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        cachedRepositoryId: repo("outside_top_20"),
        preferenceRepositoryId: null,
        switcherRepositoryIds: [repo("recent")],
        ownerRepositoryIds: new Set([repo("outside_top_20"), repo("recent")]),
      }),
    ).toEqual({
      cachedRepositoryId: repo("outside_top_20"),
      currentRepositoryId: repo("outside_top_20"),
      commands: [],
    });
  });
});
