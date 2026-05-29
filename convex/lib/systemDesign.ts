import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
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
  { systemKey: "overview", name: "Overview" },
  { systemKey: "architecture", name: "Architecture" },
  { systemKey: "data_model", name: "Data Model" },
  { systemKey: "api", name: "API & Interfaces" },
  { systemKey: "infrastructure", name: "Infrastructure & Deployment" },
  { systemKey: "security", name: "Security & Auth" },
  { systemKey: "operations", name: "Operations & Observability" },
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
      systemKey: seed.systemKey,
    });
    result.set(seed.systemKey, created);
  }

  return result;
}

/**
 * The 8 artifact kinds that the Library System Design publication can produce.
 * Every kind is LLM-backed: the generator opens a Daytona sandbox and reads
 * the repository's live source through sandbox tools, so each document tracks
 * the current code state rather than a stale import snapshot.
 */
export const SYSTEM_DESIGN_KINDS = [
  "readme_summary",
  "architecture_overview",
  "architecture_diagram",
  "data_model_overview",
  "api_surface_overview",
  "deployment_overview",
  "security_overview",
  "operations_overview",
] as const satisfies ReadonlyArray<Doc<"artifacts">["kind"]>;

export type SystemDesignKind = (typeof SYSTEM_DESIGN_KINDS)[number];

export function isSystemDesignKind(kind: Doc<"artifacts">["kind"]): kind is SystemDesignKind {
  return (SYSTEM_DESIGN_KINDS as ReadonlyArray<Doc<"artifacts">["kind"]>).includes(kind);
}

/**
 * Convex validator for a System Design kind, used by `schema.ts` for the
 * `jobs.selections` and `jobs.kindFailures` columns. Stays 1:1 with
 * {@link SYSTEM_DESIGN_KINDS}; `requestSystemDesignGeneration` additionally
 * filters incoming selections through {@link isSystemDesignKind} as
 * defense-in-depth at the request boundary.
 *
 * The retired `manifest` literal is NOT retained here — see the note on
 * `artifactKind` in `schema.ts` for the assumption that no historical
 * `jobs.selections` or `jobs.kindFailures` array contains it.
 *
 * Lives in `lib/` (not `convex/systemDesign.ts`) so `schema.ts` can import it
 * without dragging the mutation module's `lib/rateLimit` dependency into
 * schema evaluation — `process.env` reads in that module are forbidden at
 * schema-eval time.
 */
export const systemDesignKindValidator = v.union(
  v.literal("readme_summary"),
  v.literal("architecture_overview"),
  v.literal("architecture_diagram"),
  v.literal("data_model_overview"),
  v.literal("api_surface_overview"),
  v.literal("deployment_overview"),
  v.literal("security_overview"),
  v.literal("operations_overview"),
);

/**
 * Static mapping from artifact kind → destination folder `systemKey`. Used by
 * the generator to drop each new artifact into the right seeded folder, even
 * after the user has renamed the folder.
 */
export const SYSTEM_DESIGN_KIND_TO_FOLDER: Record<SystemDesignKind, SystemDesignFolderKey> = {
  readme_summary: "overview",
  architecture_overview: "architecture",
  architecture_diagram: "architecture",
  data_model_overview: "data_model",
  api_surface_overview: "api",
  deployment_overview: "infrastructure",
  security_overview: "security",
  operations_overview: "operations",
};

/**
 * Human-readable titles for each generated artifact. Used as the artifact
 * row's `title` field at creation time.
 */
export const SYSTEM_DESIGN_KIND_TITLES: Record<SystemDesignKind, string> = {
  readme_summary: "README Summary",
  architecture_overview: "Architecture Overview",
  architecture_diagram: "Architecture Diagram",
  data_model_overview: "Data Model Overview",
  api_surface_overview: "API Surface Overview",
  deployment_overview: "Deployment Overview",
  security_overview: "Security Overview",
  operations_overview: "Operations Overview",
};
