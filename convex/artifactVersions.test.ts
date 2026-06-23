/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { insertTestArtifact, insertTestRepository } from "../test/convex/fixtures";
import { createRateLimitedTestConvex } from "../test/convex/harness";

const OWNER = "user|artifact-versions";

describe("artifactVersions", () => {
  test("listByArtifact returns bounded metadata in descending version order", async () => {
    const t = createRateLimitedTestConvex();
    const repositoryId = await insertTestRepository(t, { ownerTokenIdentifier: OWNER });
    const artifactId = await insertTestArtifact(t, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      version: 60,
    });

    await t.run(async (ctx) => {
      for (let version = 1; version <= 60; version += 1) {
        await ctx.db.insert("artifactVersions", {
          artifactId,
          version,
          ownerTokenIdentifier: OWNER,
          repositoryId,
          title: `Version ${version}`,
          summary: "Version summary",
          contentMarkdown: `# Version ${version}`,
          renderFormat: "markdown",
          createdAt: version,
        });
      }
    });

    const versions = await t.withIdentity({ tokenIdentifier: OWNER }).query(api.artifactVersions.listByArtifact, {
      artifactId,
    });

    expect(versions).toHaveLength(50);
    expect(versions[0]?.version).toBe(60);
    expect(versions[versions.length - 1]?.version).toBe(11);
    expect(versions[0]).not.toHaveProperty("contentMarkdown");
  });
});
