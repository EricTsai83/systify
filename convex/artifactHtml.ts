import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { loadOwnedDoc } from "./lib/ownedDocs";

export type ArtifactHtmlPreview = {
  url: string;
  version: number;
  htmlHash?: string;
  htmlByteLength?: number;
  createdAt: number;
};

export type DraftHtmlPreview = {
  url: string;
  htmlHash?: string;
  htmlByteLength?: number;
  validationErrors?: string[];
};

export const getPreviewUrl = query({
  args: {
    artifactId: v.id("artifacts"),
    version: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ArtifactHtmlPreview | null> => {
    const { doc: artifact } = await loadOwnedDoc(ctx, args.artifactId);
    if (!artifact) {
      return null;
    }
    const version =
      args.version !== undefined
        ? await getArtifactVersion(ctx, artifact, args.version)
        : await getCurrentArtifactVersion(ctx, artifact);
    if (!version || version.renderFormat !== "html" || !version.htmlStorageId) {
      return null;
    }
    const url = await ctx.storage.getUrl(version.htmlStorageId);
    if (!url) {
      return null;
    }
    return {
      url,
      version: version.version,
      htmlHash: version.htmlHash,
      htmlByteLength: version.htmlByteLength,
      createdAt: version.createdAt,
    };
  },
});

export const getDraftPreviewUrl = query({
  args: { draftId: v.id("artifactDrafts") },
  handler: async (ctx, args): Promise<DraftHtmlPreview | null> => {
    const { doc: draft } = await loadOwnedDoc(ctx, args.draftId);
    if (!draft || draft.outputFormat !== "html" || !draft.htmlStorageId) {
      return null;
    }
    const url = await ctx.storage.getUrl(draft.htmlStorageId);
    if (!url) {
      return null;
    }
    return {
      url,
      htmlHash: draft.htmlHash,
      htmlByteLength: draft.htmlByteLength,
      validationErrors: draft.htmlValidationErrors,
    };
  },
});

async function getCurrentArtifactVersion(
  ctx: QueryCtx,
  artifact: Doc<"artifacts">,
): Promise<Doc<"artifactVersions"> | null> {
  if (artifact.currentVersionId) {
    const current = await ctx.db.get(artifact.currentVersionId);
    if (current?.artifactId === artifact._id) {
      return current;
    }
  }
  return await getArtifactVersion(ctx, artifact, artifact.version);
}

async function getArtifactVersion(
  ctx: QueryCtx,
  artifact: Doc<"artifacts">,
  version: number,
): Promise<Doc<"artifactVersions"> | null> {
  const row = await ctx.db
    .query("artifactVersions")
    .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", artifact._id).eq("version", version))
    .unique();
  if (!row || row.ownerTokenIdentifier !== artifact.ownerTokenIdentifier) {
    return null;
  }
  return row;
}
