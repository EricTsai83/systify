import { describe, expect, test } from "vitest";
import { resolveRepositorySelection } from "./repository-selection";
import type { RepositoryId } from "./types";

const repo = (id: string) => id as RepositoryId;

describe("resolveRepositorySelection", () => {
  test("DB preference wins when it points at a live repository", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        activeRepositoryId: repo("local"),
        dbRepositoryId: repo("db"),
        switcherRepositoryIds: [repo("db"), repo("local")],
        ownerRepositoryIds: new Set([repo("db"), repo("local")]),
      }),
    ).toEqual({
      activeRepositoryId: repo("db"),
      currentRepositoryId: repo("db"),
      commands: [{ kind: "setActiveRepository", repositoryId: repo("db") }],
    });
  });

  test("URL repository is canonical when present and live", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: repo("url"),
        activeRepositoryId: repo("db"),
        dbRepositoryId: repo("db"),
        switcherRepositoryIds: [repo("db"), repo("url")],
        ownerRepositoryIds: new Set([repo("db"), repo("url")]),
      }).commands,
    ).toEqual([
      { kind: "setActiveRepository", repositoryId: repo("url") },
      { kind: "touchRepository", repositoryId: repo("url") },
    ]);
  });

  test("stale URL navigates to the default authenticated route", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: repo("gone"),
        activeRepositoryId: repo("live"),
        dbRepositoryId: repo("live"),
        switcherRepositoryIds: [repo("live")],
        ownerRepositoryIds: new Set([repo("live")]),
      }),
    ).toEqual({
      activeRepositoryId: repo("live"),
      currentRepositoryId: null,
      commands: [{ kind: "navigateDefault", replace: true }],
    });
  });

  test("fallback selection seeds DB preference", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        activeRepositoryId: null,
        dbRepositoryId: null,
        switcherRepositoryIds: [repo("recent")],
        ownerRepositoryIds: new Set([repo("recent")]),
      }).commands,
    ).toEqual([
      { kind: "setActiveRepository", repositoryId: repo("recent") },
      { kind: "touchRepository", repositoryId: repo("recent") },
    ]);
  });

  test("deleted repository id clears active state when there is no fallback", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        activeRepositoryId: repo("gone"),
        dbRepositoryId: repo("gone"),
        switcherRepositoryIds: [],
        ownerRepositoryIds: new Set(),
      }).commands,
    ).toEqual([{ kind: "setActiveRepository", repositoryId: null }]);
  });

  test("live active repo outside the switcher top page is not overwritten", () => {
    expect(
      resolveRepositorySelection({
        urlRepositoryId: null,
        activeRepositoryId: repo("outside_top_20"),
        dbRepositoryId: null,
        switcherRepositoryIds: [repo("recent")],
        ownerRepositoryIds: new Set([repo("outside_top_20"), repo("recent")]),
      }),
    ).toEqual({
      activeRepositoryId: repo("outside_top_20"),
      currentRepositoryId: repo("outside_top_20"),
      commands: [],
    });
  });
});
