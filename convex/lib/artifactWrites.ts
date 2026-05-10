import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function replaceArtifactFolder(
  ctx: MutationCtx,
  artifact: Doc<"artifacts">,
  folderId: Id<"artifactFolders"> | undefined,
) {
  await ctx.db.patch(artifact._id, { folderId });
}
