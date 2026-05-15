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
  { systemKey: "overview", name: "Overview", sortOrder: 1 },
  { systemKey: "architecture", name: "Architecture", sortOrder: 2 },
  { systemKey: "data_model", name: "Data Model", sortOrder: 3 },
  { systemKey: "api", name: "API & Interfaces", sortOrder: 4 },
  { systemKey: "infrastructure", name: "Infrastructure & Deployment", sortOrder: 5 },
  { systemKey: "security", name: "Security & Auth", sortOrder: 6 },
  { systemKey: "operations", name: "Operations & Observability", sortOrder: 7 },
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

/**
 * The 8 artifact kinds that the Library System Design publication can produce.
 * The 2 heuristic kinds (`manifest`, `architecture_overview`) derive from the
 * imported repo snapshot without an LLM call; the 6 LLM-backed kinds read live
 * source via sandbox tools so the doc tracks the current code state. README
 * Summary used to be heuristic but moved to LLM so the output is a real
 * condensation rather than a prefix slice of the README file.
 */
export const SYSTEM_DESIGN_KINDS = [
  "manifest",
  "readme_summary",
  "architecture_overview",
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
 * Static mapping from artifact kind → destination folder `systemKey`. Used by
 * the generator to drop each new artifact into the right seeded folder, even
 * after the user has renamed the folder.
 */
export const SYSTEM_DESIGN_KIND_TO_FOLDER: Record<SystemDesignKind, SystemDesignFolderKey> = {
  manifest: "overview",
  readme_summary: "overview",
  architecture_overview: "architecture",
  data_model_overview: "data_model",
  api_surface_overview: "api",
  deployment_overview: "infrastructure",
  security_overview: "security",
  operations_overview: "operations",
};

/**
 * Whether a given kind is generated via a heuristic (no LLM call) or by an
 * LLM-backed sandbox session. Drives the "Free" vs "~1 LLM call" badge in
 * the Generate System Design dialog and the per-kind dispatch branch in the
 * generator action.
 */
export const SYSTEM_DESIGN_KIND_GENERATOR: Record<SystemDesignKind, "heuristic" | "llm"> = {
  manifest: "heuristic",
  readme_summary: "llm",
  architecture_overview: "heuristic",
  data_model_overview: "llm",
  api_surface_overview: "llm",
  deployment_overview: "llm",
  security_overview: "llm",
  operations_overview: "llm",
};

/**
 * Human-readable titles for each generated artifact. Used as the artifact
 * row's `title` field at creation time.
 */
export const SYSTEM_DESIGN_KIND_TITLES: Record<SystemDesignKind, string> = {
  manifest: "Repository Manifest",
  readme_summary: "README Summary",
  architecture_overview: "Architecture Overview",
  data_model_overview: "Data Model Overview",
  api_surface_overview: "API Surface Overview",
  deployment_overview: "Deployment Overview",
  security_overview: "Security Overview",
  operations_overview: "Operations Overview",
};
