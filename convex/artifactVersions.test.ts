/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { insertTestArtifact, insertTestRepository } from "../test/convex/fixtures";
import { createRateLimitedTestConvex } from "../test/convex/harness";
import { createArtifactVersionWrite } from "./lib/artifactWrites";

const OWNER = "user|artifact-versions";

describe("artifactVersions", () => {
  test("createArtifactVersionWrite stores html validation status from render format and errors", async () => {
    const t = createRateLimitedTestConvex();
    const repositoryId = await insertTestRepository(t, { ownerTokenIdentifier: OWNER });
    const artifactId = await insertTestArtifact(t, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      version: 3,
    });

    const [validHtmlVersionId, invalidHtmlVersionId, markdownVersionId] = await t.run(async (ctx) => {
      const validHtmlId = await createArtifactVersionWrite(ctx, {
        artifactId,
        version: 1,
        ownerTokenIdentifier: OWNER,
        repositoryId,
        title: "Valid HTML",
        summary: "No validation errors",
        contentMarkdown: "# Valid",
        renderFormat: "html",
        htmlValidationErrors: [],
        createdAt: 1,
      });
      const invalidHtmlId = await createArtifactVersionWrite(ctx, {
        artifactId,
        version: 2,
        ownerTokenIdentifier: OWNER,
        repositoryId,
        title: "Invalid HTML",
        summary: "Has validation errors",
        contentMarkdown: "# Invalid",
        renderFormat: "html",
        htmlValidationErrors: ["Missing closing tag"],
        createdAt: 2,
      });
      const markdownId = await createArtifactVersionWrite(ctx, {
        artifactId,
        version: 3,
        ownerTokenIdentifier: OWNER,
        repositoryId,
        title: "Markdown",
        summary: "Markdown version",
        contentMarkdown: "# Markdown",
        renderFormat: "markdown",
        createdAt: 3,
      });

      return [validHtmlId, invalidHtmlId, markdownId];
    });

    await t.run(async (ctx) => {
      const validHtmlVersion = await ctx.db.get(validHtmlVersionId);
      const invalidHtmlVersion = await ctx.db.get(invalidHtmlVersionId);
      const markdownVersion = await ctx.db.get(markdownVersionId);

      expect(validHtmlVersion?.htmlValidationStatus).toBe("valid");
      expect(invalidHtmlVersion?.htmlValidationStatus).toBe("invalid");
      expect(markdownVersion?.htmlValidationStatus).toBeUndefined();
    });
  });

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
