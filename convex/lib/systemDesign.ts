import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Default folder tree seeded for every repository. Each entry's `systemKey`
 * is the stable identifier the System Design generator uses to find the
 * destination folder when writing an artifact — the user can rename a folder
 * freely and the generator will still target the right row.
 *
 * `name` is the *initial* label. Adding new keys here is safe (idempotent
 * seeder); removing a key is a breaking change — existing folders keep their
 * data but become un-targetable by the generator until reseeded or moved.
 */
export const SYSTEM_DESIGN_FOLDERS = [
  { systemKey: "overview", name: "01. Overview", sortOrder: 1 },
  { systemKey: "architecture", name: "02. Architecture", sortOrder: 2 },
  { systemKey: "data_model", name: "03. Data Model", sortOrder: 3 },
  { systemKey: "api", name: "04. API & Interfaces", sortOrder: 4 },
  { systemKey: "infrastructure", name: "05. Infrastructure & Deployment", sortOrder: 5 },
  { systemKey: "security", name: "06. Security & Auth", sortOrder: 6 },
  { systemKey: "operations", name: "07. Operations & Observability", sortOrder: 7 },
] as const;

export type SystemDesignFolderKey = (typeof SYSTEM_DESIGN_FOLDERS)[number]["systemKey"];

/**
 * Idempotently ensure the System Design folder tree exists for a repository.
 * Returns a `systemKey → folderId` map for callers that want to immediately
 * write artifacts into the seeded folders.
 *
 * Idempotency is via `artifactFolders.systemKey + repositoryId`: a folder
 * that already exists for a given key is reused, even if the user renamed
 * it. Folders the user created without a `systemKey` are left untouched.
 */
export async function ensureSystemDesignFolders(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
  },
): Promise<Map<SystemDesignFolderKey, Id<"artifactFolders">>> {
  const existing = await ctx.db
    .query("artifactFolders")
    .withIndex("by_repositoryId_and_systemKey", (q) => q.eq("repositoryId", args.repositoryId))
    .collect();

  const existingBySystemKey = new Map<string, Id<"artifactFolders">>();
  for (const folder of existing) {
    if (folder.systemKey) {
      existingBySystemKey.set(folder.systemKey, folder._id);
    }
  }

  const result = new Map<SystemDesignFolderKey, Id<"artifactFolders">>();
  for (const seed of SYSTEM_DESIGN_FOLDERS) {
    const existingId = existingBySystemKey.get(seed.systemKey);
    if (existingId) {
      result.set(seed.systemKey, existingId);
      continue;
    }
    const created = await ctx.db.insert("artifactFolders", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      name: seed.name,
      sortOrder: seed.sortOrder,
      systemKey: seed.systemKey,
    });
    result.set(seed.systemKey, created);
  }

  return result;
}
