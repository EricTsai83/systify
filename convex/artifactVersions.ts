import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { loadOwnedDoc } from "./lib/ownedDocs";

export type ArtifactVersionMetadata = Omit<Doc<"artifactVersions">, "contentMarkdown">;

export const listByArtifact = query({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args): Promise<ArtifactVersionMetadata[]> => {
    const { doc: artifact } = await loadOwnedDoc(ctx, args.artifactId);
    if (!artifact) {
      return [];
    }
    const versions = await ctx.db
      .query("artifactVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifact._id))
      .order("desc")
      .collect();
    return versions.map(toVersionMetadata);
  },
});

export const getVersion = query({
  args: {
    artifactId: v.id("artifacts"),
    version: v.number(),
  },
  handler: async (ctx, args): Promise<Doc<"artifactVersions"> | null> => {
    const { doc: artifact } = await loadOwnedDoc(ctx, args.artifactId);
    if (!artifact) {
      return null;
    }
    const version = await ctx.db
      .query("artifactVersions")
      .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", artifact._id).eq("version", args.version))
      .unique();
    if (!version || version.ownerTokenIdentifier !== artifact.ownerTokenIdentifier) {
      return null;
    }
    return version;
  },
});

function toVersionMetadata(version: Doc<"artifactVersions">): ArtifactVersionMetadata {
  const { contentMarkdown: _contentMarkdown, ...metadata } = version;
  return metadata;
}
