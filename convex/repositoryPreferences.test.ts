/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { insertTestRepository } from "../test/convex/fixtures";
import { createTestConvex } from "../test/convex/harness";

describe("listOwnedRepositoryIdsById", () => {
  test("returns only normalized repository ids owned by the viewer", async () => {
    const ownerTokenIdentifier = "user|repository-probe-owner";
    const intruderTokenIdentifier = "user|repository-probe-intruder";
    const t = createTestConvex();
    const ownedRepositoryId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/owned-probe",
      sourceRepoName: "owned-probe",
      sourceUrl: "https://github.com/acme/owned-probe",
    });
    const foreignRepositoryId = await insertTestRepository(t, {
      ownerTokenIdentifier: intruderTokenIdentifier,
      sourceRepoFullName: "acme/foreign-probe",
      sourceRepoName: "foreign-probe",
      sourceUrl: "https://github.com/acme/foreign-probe",
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.repositoryPreferences.listOwnedRepositoryIdsById, {
      repositoryIds: [ownedRepositoryId, foreignRepositoryId, "not-a-convex-id", ownedRepositoryId],
    });

    expect(result).toEqual([ownedRepositoryId]);
  });

  test("excludes archived repository ids from active ownership probe", async () => {
    const ownerTokenIdentifier = "user|repo-probe-archive";
    const t = createTestConvex();
    const activeId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/probe-active",
      sourceRepoName: "probe-active",
      sourceUrl: "https://github.com/acme/probe-active",
    });
    const archivedId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/probe-archived",
      sourceRepoName: "probe-archived",
      sourceUrl: "https://github.com/acme/probe-archived",
      archivedAt: Date.now(),
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.repositoryPreferences.listOwnedRepositoryIdsById, {
      repositoryIds: [activeId, archivedId],
    });

    expect(result).toEqual([activeId]);
  });

  test("excludes deletion-requested repository ids from active ownership probe", async () => {
    const ownerTokenIdentifier = "user|repo-probe-deleting";
    const t = createTestConvex();
    const activeId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/probe-active-del",
      sourceRepoName: "probe-active-del",
      sourceUrl: "https://github.com/acme/probe-active-del",
    });
    const deletingId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/probe-deleting",
      sourceRepoName: "probe-deleting",
      sourceUrl: "https://github.com/acme/probe-deleting",
      deletionRequestedAt: Date.now(),
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.repositoryPreferences.listOwnedRepositoryIdsById, {
      repositoryIds: [activeId, deletingId],
    });

    expect(result).toEqual([activeId]);
  });

  test("excludes a foreign owner's active repository from probe results", async () => {
    const ownerTokenIdentifier = "user|repo-probe-foreign-active";
    const foreignTokenIdentifier = "user|repo-probe-foreign-other";
    const t = createTestConvex();
    const ownedActiveId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/my-active",
      sourceRepoName: "my-active",
      sourceUrl: "https://github.com/acme/my-active",
    });
    const foreignActiveId = await insertTestRepository(t, {
      ownerTokenIdentifier: foreignTokenIdentifier,
      sourceRepoFullName: "acme/foreign-active",
      sourceRepoName: "foreign-active",
      sourceUrl: "https://github.com/acme/foreign-active",
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.repositoryPreferences.listOwnedRepositoryIdsById, {
      repositoryIds: [ownedActiveId, foreignActiveId],
    });

    expect(result).toEqual([ownedActiveId]);
  });
});

describe("listRepositoriesForSwitcher", () => {
  test("returns active repositories ordered by lastAccessedAt desc", async () => {
    const ownerTokenIdentifier = "user|switcher-active";
    const t = createTestConvex();
    const now = Date.now();
    const olderActiveId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/switcher-older",
      sourceRepoName: "switcher-older",
      sourceUrl: "https://github.com/acme/switcher-older",
      lastAccessedAt: now - 2000,
    });
    const newerActiveId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/switcher-newer",
      sourceRepoName: "switcher-newer",
      sourceUrl: "https://github.com/acme/switcher-newer",
      lastAccessedAt: now - 1000,
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.repositoryPreferences.listRepositoriesForSwitcher, {});

    const ids = result.map((r) => r._id);
    expect(ids).toEqual([newerActiveId, olderActiveId]);
  });

  test("excludes archived repositories from switcher list", async () => {
    const ownerTokenIdentifier = "user|switcher-exclude-archived";
    const t = createTestConvex();
    const now = Date.now();
    const activeId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/switcher-live",
      sourceRepoName: "switcher-live",
      sourceUrl: "https://github.com/acme/switcher-live",
      lastAccessedAt: now,
    });
    await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/switcher-archived",
      sourceRepoName: "switcher-archived",
      sourceUrl: "https://github.com/acme/switcher-archived",
      lastAccessedAt: now - 1000,
      archivedAt: now - 500,
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.repositoryPreferences.listRepositoriesForSwitcher, {});

    expect(result.map((r) => r._id)).toEqual([activeId]);
  });

  test("excludes deletion-requested repositories from switcher list", async () => {
    const ownerTokenIdentifier = "user|switcher-exclude-deleting";
    const t = createTestConvex();
    const now = Date.now();
    const activeId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/switcher-nodeletion",
      sourceRepoName: "switcher-nodeletion",
      sourceUrl: "https://github.com/acme/switcher-nodeletion",
      lastAccessedAt: now,
    });
    await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "acme/switcher-deleting",
      sourceRepoName: "switcher-deleting",
      sourceUrl: "https://github.com/acme/switcher-deleting",
      lastAccessedAt: now - 1000,
      deletionRequestedAt: now - 500,
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.repositoryPreferences.listRepositoriesForSwitcher, {});

    expect(result.map((r) => r._id)).toEqual([activeId]);
  });
});
