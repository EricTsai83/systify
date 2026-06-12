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
});
