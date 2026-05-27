import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { requireActiveRepositoryForViewer } from "./lib/repositoryAccess";
import { requireOwnedDoc } from "./lib/ownedDocs";
import { createArtifactInMutation } from "./artifactStore";
import {
  generateArchitectureDiagram,
  type DiagramDepth,
  type DiagramSnapshot,
  type DiagramSnapshotFile,
} from "./lib/architectureDiagram";

const REPO_FILE_LIMIT = 800;
const PACKAGE_FILE_PATHS = ["package.json", "pyproject.toml", "Cargo.toml"] as const;
const MAX_EXTERNAL_DEPS_FROM_MANIFEST = 24;

const diagramDepthValidator = v.union(v.literal("service"), v.literal("module"), v.literal("file"));

/**
 * Requests an architecture diagram for the thread's attached repository.
 *
 * Given a repository and a chosen depth (service / module / file), produces
 * a Mermaid `graph TD` describing modules, data flow, and external
 * dependencies. The artifact is persisted to both `threadId` and
 * `repositoryId` so it appears both in the in-thread ArtifactPanel (right
 * rail) and in the repository's artifact list — repositories accumulate
 * diagrams across threads, and a thread sees the diagrams produced for its
 * grounding repo.
 *
 * The generator itself is a pure function (`convex/lib/architectureDiagram`)
 * that consumes a snapshot built from `repoFiles` and (if available) the
 * repository's package manifest. Keeping the generator pure is what makes the
 * snapshot test meaningful: stable input → stable Mermaid string.
 */
export const requestArchitectureDiagram = mutation({
  args: {
    threadId: v.id("threads"),
    depth: diagramDepthValidator,
    /**
     * Optional folder placement. Surfaced by the panel's "+ Generate" tab
     * so the user can route a new diagram into the right feature folder
     * (or into Repository root with `null`). Server validates the folder
     * belongs to the same repository as the artifact.
     */
    folderId: v.optional(v.id("artifactFolders")),
  },
  handler: async (ctx, args) => {
    const { identity, doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    if (!thread.repositoryId) {
      throw new Error("Architecture diagrams require an attached repository on this thread.");
    }
    const { repository } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: thread.repositoryId,
      archivedMessage: "This repository is archived. Restore it to generate diagrams.",
    });

    if (args.folderId) {
      const { doc: folder } = await requireOwnedDoc(ctx, args.folderId, {
        notFoundMessage: "Folder not found.",
      });
      if (folder.repositoryId !== repository._id) {
        throw new Error("Cannot place an artifact in a folder from a different repository.");
      }
    }

    const snapshot = await buildSnapshot(ctx, repository);

    const result = generateArchitectureDiagram(snapshot, args.depth as DiagramDepth);

    const artifactId = await createArtifactInMutation(ctx, {
      threadId: args.threadId,
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      kind: "architecture_diagram",
      title: result.title,
      summary: result.summary,
      contentMarkdown: result.mermaid,
      source: "heuristic",
      folderId: args.folderId,
    });

    return { artifactId };
  },
});

async function buildSnapshot(ctx: MutationCtx, repository: Doc<"repositories">): Promise<DiagramSnapshot> {
  const files = await ctx.db
    .query("repoFiles")
    .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", repository._id))
    .take(REPO_FILE_LIMIT);

  const externalDependencies = repository.latestImportId
    ? await loadExternalDependenciesFromManifest(ctx, repository.latestImportId)
    : [];

  return {
    repositoryName: repository.sourceRepoFullName,
    detectedLanguages: repository.detectedLanguages,
    packageManagers: repository.packageManagers,
    entrypoints: repository.entrypoints,
    files: files.map(toDiagramSnapshotFile),
    externalDependencies,
  };
}

function toDiagramSnapshotFile(file: Doc<"repoFiles">): DiagramSnapshotFile {
  return {
    path: file.path,
    parentPath: file.parentPath,
    fileType: file.fileType,
    language: file.language,
    isEntryPoint: file.isEntryPoint,
    isConfig: file.isConfig,
    isImportant: file.isImportant,
  };
}

/**
 * Reads up to one chunk per supported manifest path (package.json,
 * pyproject.toml, Cargo.toml) and extracts dependency names. The manifest is
 * stored as a chunk on import (see `createChunkRecords`), so we can fetch it
 * straight from `repoChunks` rather than going to the sandbox.
 *
 * Returns `[]` if no manifest chunk is found or if parsing fails — the
 * generator gracefully renders an external-deps-free diagram in that case.
 */
async function loadExternalDependenciesFromManifest(
  ctx: MutationCtx,
  importId: Doc<"imports">["_id"],
): Promise<string[]> {
  const collected = new Set<string>();
  for (const path of PACKAGE_FILE_PATHS) {
    const chunks = await ctx.db
      .query("repoChunks")
      .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", importId).eq("path", path))
      .take(1);
    if (chunks.length === 0) {
      continue;
    }
    const content = chunks[0].content;
    const parsed = parseManifestDependencies(path, content);
    for (const dep of parsed) {
      collected.add(dep);
      if (collected.size >= MAX_EXTERNAL_DEPS_FROM_MANIFEST) {
        break;
      }
    }
    if (collected.size >= MAX_EXTERNAL_DEPS_FROM_MANIFEST) {
      break;
    }
  }
  return Array.from(collected).sort();
}

function parseManifestDependencies(path: string, content: string): string[] {
  if (path === "package.json") {
    return parsePackageJsonDependencies(content);
  }
  if (path === "pyproject.toml" || path === "Cargo.toml") {
    return parseTomlDependencies(content);
  }
  return [];
}

function parsePackageJsonDependencies(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const buckets = ["dependencies", "peerDependencies", "optionalDependencies"];
    const result = new Set<string>();
    for (const bucket of buckets) {
      const value = parsed[bucket];
      if (value && typeof value === "object") {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (key.length > 0) {
            result.add(key);
          }
        }
      }
    }
    return Array.from(result);
  } catch {
    return [];
  }
}

function parseTomlDependencies(content: string): string[] {
  // Lightweight TOML scan: we only care about top-level dependency keys, and
  // dropping a full TOML parser into the bundle for a heuristic generator is
  // overkill. The two patterns we look for cover Python (`pyproject.toml`)
  // and Rust (`Cargo.toml`). Any failure mode here just falls back to an
  // empty list — the diagram still renders.
  const result = new Set<string>();

  const sectionRegex = /^\[(?<section>[^\]]+)\]\s*$/gm;
  const lines = content.split("\n");
  let currentSection: string | null = null;
  for (const line of lines) {
    const sectionMatch = sectionRegex.exec(line);
    sectionRegex.lastIndex = 0;
    if (sectionMatch?.groups?.section) {
      currentSection = sectionMatch.groups.section.trim();
      continue;
    }
    if (!currentSection) {
      continue;
    }
    if (
      currentSection !== "dependencies" &&
      !currentSection.startsWith("project.dependencies") &&
      !currentSection.startsWith("tool.poetry.dependencies") &&
      currentSection !== "dev-dependencies"
    ) {
      continue;
    }
    const keyMatch = /^([A-Za-z0-9_.-]+)\s*=/.exec(line.trim());
    if (keyMatch?.[1]) {
      result.add(keyMatch[1]);
    }
  }

  // PEP 621 `dependencies = [...]` array form (very common in pyproject.toml).
  const arrayMatch = /dependencies\s*=\s*\[([^\]]*)\]/m.exec(content);
  if (arrayMatch?.[1]) {
    const items = arrayMatch[1].split(/[,\n]/);
    for (const raw of items) {
      const trimmed = raw.trim().replace(/^["']|["']$/g, "");
      const nameMatch = /^([A-Za-z0-9_.-]+)/.exec(trimmed);
      if (nameMatch?.[1]) {
        result.add(nameMatch[1]);
      }
    }
  }

  return Array.from(result);
}
