/**
 * ArchitectureDiagramGenerator — pure heuristic generator that turns a
 * repository snapshot into a Mermaid `graph TD` describing modules, data flow,
 * and external dependencies.
 *
 * The generator is intentionally a pure function:
 *   - all inputs come in via `DiagramSnapshot` (no Convex `ctx`, no `Date.now`)
 *   - all outputs are deterministic for stable input (sorted lexicographically)
 *
 * This keeps it snapshot-testable, and lets the caller
 * (`convex/architectureDiagram.ts`) own the Convex-side concerns (auth,
 * persistence, artifact insert).
 *
 * Depth ladder — service / module / file:
 *   - `service`: top-level directories. Cheapest, best for high-level sketch.
 *   - `module`:  top + 2nd-level directories grouped via subgraphs.
 *                Default depth, balances detail and legibility.
 *   - `file`:    important files (entrypoints, config, isImportant) grouped
 *                by their owning top-level directory.
 *
 * External dependencies are rendered as dotted-edge nodes off the repo root so
 * the user can spot the boundary between in-repo modules and third-party
 * surfaces (PRD US 17: "show modules, data flow, and external dependencies").
 */

export type DiagramDepth = "service" | "module" | "file";

export interface DiagramSnapshotFile {
  path: string;
  parentPath: string;
  fileType: "file" | "dir";
  language?: string;
  isEntryPoint: boolean;
  isConfig: boolean;
  isImportant: boolean;
}

export interface DiagramSnapshot {
  repositoryName: string;
  detectedLanguages: string[];
  packageManagers: string[];
  /** Likely application entrypoints, e.g. `src/main.tsx`. */
  entrypoints: string[];
  /**
   * Repo files (both directories and files). For `file` depth we draw
   * `isEntryPoint || isConfig || isImportant` files; for `module` and
   * `service` depth we only need the directory hierarchy, but mixing files
   * in is fine — they are filtered out.
   */
  files: DiagramSnapshotFile[];
  /**
   * Optional list of external (npm / pypi / cargo / etc.) dependency names.
   * Caller is expected to extract these from `package.json` /
   * `pyproject.toml` / `Cargo.toml` content. Unknown → empty.
   */
  externalDependencies?: string[];
}

export interface DiagramOutput {
  /** Short artifact title for the right-rail card. */
  title: string;
  /** One-sentence summary used in the artifact list summary. */
  summary: string;
  /** Mermaid `graph TD …` source. */
  mermaid: string;
}

const MAX_EXTERNAL_DEPS = 8;
const MAX_FILE_NODES_PER_DIR = 4;
const MAX_TOTAL_FILE_NODES = 24;

export function generateArchitectureDiagram(snapshot: DiagramSnapshot, depth: DiagramDepth): DiagramOutput {
  switch (depth) {
    case "service":
      return generateServiceDiagram(snapshot);
    case "module":
      return generateModuleDiagram(snapshot);
    case "file":
      return generateFileDiagram(snapshot);
  }
}

function generateServiceDiagram(snapshot: DiagramSnapshot): DiagramOutput {
  const ids = new NodeIdAllocator();
  const lines: string[] = ["graph TD"];

  const repoLabel = snapshot.repositoryName || "repository";
  const repoNodeId = ids.allocate(`repo:${repoLabel}`, "repo_");
  lines.push(`    ${repoNodeId}[["${escapeLabel(repoLabel)}"]]:::root`);

  const services = collectTopLevelDirectories(snapshot);
  for (const service of services) {
    const serviceId = ids.allocate(`service:${service}`, "svc_");
    lines.push(`    ${serviceId}["${escapeLabel(`${service}/`)}"]:::module`);
    lines.push(`    ${repoNodeId} --> ${serviceId}`);
  }

  // Entry-points are highlighted at this depth so the reader can see "what
  // boots" at a glance. We attach each entrypoint to its top-level service so
  // the edges still convey hierarchy.
  for (const entry of pickEntrypoints(snapshot)) {
    const owningService = topLevelOf(entry);
    if (!owningService || !services.includes(owningService)) {
      continue;
    }
    const entryId = ids.allocate(`entrypoint:${entry}`, "ep_");
    const serviceId = ids.allocate(`service:${owningService}`, "svc_");
    lines.push(`    ${entryId}(("${escapeLabel(entry)}")):::entrypoint`);
    lines.push(`    ${serviceId} --> ${entryId}`);
  }

  appendExternalDependencyEdges(snapshot, repoNodeId, ids, lines);
  appendStyleClasses(lines);

  return {
    title: `Architecture diagram (service): ${repoLabel}`,
    summary: buildServiceSummary(repoLabel, services.length, snapshot.externalDependencies?.length ?? 0),
    mermaid: lines.join("\n"),
  };
}

function generateModuleDiagram(snapshot: DiagramSnapshot): DiagramOutput {
  const ids = new NodeIdAllocator();
  const lines: string[] = ["graph TD"];

  const repoLabel = snapshot.repositoryName || "repository";
  const repoNodeId = ids.allocate(`repo:${repoLabel}`, "repo_");
  lines.push(`    ${repoNodeId}[["${escapeLabel(repoLabel)}"]]:::root`);

  const services = collectTopLevelDirectories(snapshot);
  const subModulesByService = collectSubModulesByService(snapshot, services);
  const linkTargetByService = new Map<string, string>();

  for (const service of services) {
    const serviceId = ids.allocate(`service:${service}`, "svc_");
    const subModules = subModulesByService.get(service) ?? [];
    if (subModules.length === 0) {
      lines.push(`    ${serviceId}["${escapeLabel(`${service}/`)}"]:::module`);
      lines.push(`    ${repoNodeId} --> ${serviceId}`);
      linkTargetByService.set(service, serviceId);
      continue;
    }

    // Each service with submodules becomes a Mermaid subgraph so the visual
    // hierarchy matches the directory tree at-a-glance.
    const subgraphId = `${serviceId}_grp`;
    lines.push(`    subgraph ${subgraphId}["${escapeLabel(`${service}/`)}"]`);
    lines.push("        direction TB");
    for (const subPath of subModules) {
      const subId = ids.allocate(`module:${subPath}`, "mod_");
      const label = subPath.slice(service.length + 1);
      lines.push(`        ${subId}["${escapeLabel(`${label}/`)}"]:::submodule`);
    }
    lines.push("    end");
    lines.push(`    ${repoNodeId} --> ${subgraphId}`);
    linkTargetByService.set(service, subgraphId);
  }

  for (const entry of pickEntrypoints(snapshot)) {
    const owningService = topLevelOf(entry);
    if (!owningService || !services.includes(owningService)) {
      continue;
    }
    const entryId = ids.allocate(`entrypoint:${entry}`, "ep_");
    const serviceTarget = linkTargetByService.get(owningService);
    if (!serviceTarget) {
      continue;
    }
    lines.push(`    ${entryId}(("${escapeLabel(entry)}")):::entrypoint`);
    lines.push(`    ${serviceTarget} --> ${entryId}`);
  }

  appendExternalDependencyEdges(snapshot, repoNodeId, ids, lines);
  appendStyleClasses(lines);

  return {
    title: `Architecture diagram (module): ${repoLabel}`,
    summary: buildModuleSummary(repoLabel, services.length, countSubModules(subModulesByService)),
    mermaid: lines.join("\n"),
  };
}

function generateFileDiagram(snapshot: DiagramSnapshot): DiagramOutput {
  const ids = new NodeIdAllocator();
  const lines: string[] = ["graph TD"];

  const repoLabel = snapshot.repositoryName || "repository";
  const repoNodeId = ids.allocate(`repo:${repoLabel}`, "repo_");
  lines.push(`    ${repoNodeId}[["${escapeLabel(repoLabel)}"]]:::root`);

  const services = collectTopLevelDirectories(snapshot);
  const filesByService = collectFilesByService(snapshot, services);

  let totalDrawn = 0;
  for (const service of services) {
    const candidates = filesByService.get(service) ?? [];
    if (candidates.length === 0) {
      continue;
    }
    const visible = takeWithinCaps(candidates, MAX_FILE_NODES_PER_DIR, MAX_TOTAL_FILE_NODES - totalDrawn);
    if (visible.length === 0) {
      break;
    }
    const serviceId = ids.allocate(`service:${service}`, "svc_");
    const subgraphId = `${serviceId}_grp`;
    lines.push(`    subgraph ${subgraphId}["${escapeLabel(`${service}/`)}"]`);
    lines.push("        direction TB");
    for (const file of visible) {
      const fileId = ids.allocate(`file:${file.path}`, "file_");
      const label = file.path.slice(service.length + 1) || file.path;
      const shape = file.isEntryPoint
        ? `((${quote(label)}))`
        : file.isConfig
          ? `[/${quote(label)}/]`
          : `[${quote(label)}]`;
      const className = file.isEntryPoint ? ":::entrypoint" : file.isConfig ? ":::config" : ":::file";
      lines.push(`        ${fileId}${shape}${className}`);
    }
    lines.push("    end");
    lines.push(`    ${repoNodeId} --> ${subgraphId}`);
    totalDrawn += visible.length;
    if (totalDrawn >= MAX_TOTAL_FILE_NODES) {
      break;
    }
  }

  // Files at the repo root (no top-level dir) — typically `package.json`,
  // `README.md`. Render them under a synthetic "root" group so they don't get
  // lost at this depth.
  const rootFiles = takeWithinCaps(
    filesByService.get("") ?? [],
    MAX_FILE_NODES_PER_DIR,
    MAX_TOTAL_FILE_NODES - totalDrawn,
  );
  if (rootFiles.length > 0 && totalDrawn < MAX_TOTAL_FILE_NODES) {
    const rootGroupId = `${repoNodeId}_root`;
    lines.push(`    subgraph ${rootGroupId}["root"]`);
    lines.push("        direction TB");
    for (const file of rootFiles) {
      const fileId = ids.allocate(`file:${file.path}`, "file_");
      const label = file.path;
      const shape = file.isEntryPoint
        ? `((${quote(label)}))`
        : file.isConfig
          ? `[/${quote(label)}/]`
          : `[${quote(label)}]`;
      const className = file.isEntryPoint ? ":::entrypoint" : file.isConfig ? ":::config" : ":::file";
      lines.push(`        ${fileId}${shape}${className}`);
    }
    lines.push("    end");
    lines.push(`    ${repoNodeId} --> ${rootGroupId}`);
    totalDrawn += rootFiles.length;
  }

  appendExternalDependencyEdges(snapshot, repoNodeId, ids, lines);
  appendStyleClasses(lines);

  return {
    title: `Architecture diagram (file): ${repoLabel}`,
    summary: buildFileSummary(repoLabel, totalDrawn, services.length),
    mermaid: lines.join("\n"),
  };
}

function takeWithinCaps<T>(items: readonly T[], perGroupCap: number, remainingGlobalCap: number): T[] {
  if (perGroupCap <= 0 || remainingGlobalCap <= 0) {
    return [];
  }
  return items.slice(0, Math.min(perGroupCap, remainingGlobalCap));
}

function collectTopLevelDirectories(snapshot: DiagramSnapshot): string[] {
  const seen = new Set<string>();
  for (const file of snapshot.files) {
    // A top-level dir row (`parentPath === ''`, `fileType === 'dir'`) is the
    // strongest evidence — that's the directory the importer found at root.
    if (file.fileType === "dir" && file.parentPath === "" && file.path) {
      seen.add(file.path);
      continue;
    }
    // For nested files we infer the owning top-level dir from the path. This
    // covers cases where the importer truncated the dir rows but kept the file
    // rows (`repoFiles.take()` is bounded). A path without a slash is a file
    // at the repo root and is **not** a service.
    const slash = file.path.indexOf("/");
    if (slash > 0) {
      seen.add(file.path.slice(0, slash));
    }
  }
  return Array.from(seen).sort();
}

function collectSubModulesByService(snapshot: DiagramSnapshot, services: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const serviceSet = new Set(services);
  const subSeen = new Map<string, Set<string>>();

  for (const file of snapshot.files) {
    const parts = file.path.split("/");
    if (file.fileType === "dir") {
      // A 2nd-level dir row (e.g. `src/components`) is the canonical evidence
      // for a submodule.
      if (parts.length === 2 && serviceSet.has(parts[0])) {
        const set = subSeen.get(parts[0]) ?? new Set<string>();
        set.add(file.path);
        subSeen.set(parts[0], set);
      }
      continue;
    }
    // For files, only paths that are *at least* 3 segments deep imply a
    // submodule directory (e.g. `src/components/Button.tsx` → `src/components`).
    // A 2-segment file path like `convex/chat.ts` is a file directly in the
    // service, **not** a submodule.
    if (parts.length >= 3 && serviceSet.has(parts[0])) {
      const subPath = `${parts[0]}/${parts[1]}`;
      const set = subSeen.get(parts[0]) ?? new Set<string>();
      set.add(subPath);
      subSeen.set(parts[0], set);
    }
  }

  for (const service of services) {
    const set = subSeen.get(service) ?? new Set<string>();
    result.set(service, Array.from(set).sort());
  }
  return result;
}

function collectFilesByService(snapshot: DiagramSnapshot, services: string[]): Map<string, DiagramSnapshotFile[]> {
  const result = new Map<string, DiagramSnapshotFile[]>();
  result.set("", []);
  for (const service of services) {
    result.set(service, []);
  }

  // We only show files that are likely interesting; otherwise the diagram
  // bloats and stops being useful at file depth.
  const interesting = snapshot.files
    .filter((file) => file.fileType === "file")
    .filter((file) => file.isEntryPoint || file.isConfig || file.isImportant);

  for (const file of interesting) {
    const top = topLevelOf(file.path) ?? "";
    if (top !== "" && !services.includes(top)) {
      continue;
    }
    const list = result.get(top);
    if (!list) {
      continue;
    }
    list.push(file);
  }

  for (const [key, list] of result) {
    list.sort(compareFilesForFileDepth);
    result.set(key, list);
  }
  return result;
}

function compareFilesForFileDepth(a: DiagramSnapshotFile, b: DiagramSnapshotFile): number {
  const aRank = fileRank(a);
  const bRank = fileRank(b);
  if (aRank !== bRank) {
    return aRank - bRank;
  }
  return a.path.localeCompare(b.path);
}

function fileRank(file: DiagramSnapshotFile): number {
  if (file.isEntryPoint) return 0;
  if (file.isConfig) return 1;
  if (file.isImportant) return 2;
  return 3;
}

function pickEntrypoints(snapshot: DiagramSnapshot): string[] {
  // Prefer the file-level rows (which are stamped with `isEntryPoint`) so the
  // diagram still highlights entrypoints even if the caller didn't pre-fill
  // `snapshot.entrypoints`. Fall back to the explicit list otherwise.
  const fromFiles = snapshot.files
    .filter((file) => file.fileType === "file" && file.isEntryPoint)
    .map((file) => file.path);
  const merged = new Set([...fromFiles, ...snapshot.entrypoints]);
  return Array.from(merged).sort().slice(0, 6);
}

function appendExternalDependencyEdges(
  snapshot: DiagramSnapshot,
  repoNodeId: string,
  ids: NodeIdAllocator,
  lines: string[],
) {
  const externals = (snapshot.externalDependencies ?? []).slice().sort();
  const limited = externals.slice(0, MAX_EXTERNAL_DEPS);
  for (const dep of limited) {
    const depId = ids.allocate(`ext:${dep}`, "ext_");
    lines.push(`    ${depId}["${escapeLabel(dep)}"]:::external`);
    lines.push(`    ${repoNodeId} -.-> ${depId}`);
  }
  if (externals.length > limited.length) {
    const overflowId = ids.allocate("ext:__overflow__", "ext_more_");
    const remaining = externals.length - limited.length;
    lines.push(`    ${overflowId}["+ ${remaining} more"]:::external`);
    lines.push(`    ${repoNodeId} -.-> ${overflowId}`);
  }
}

function appendStyleClasses(lines: string[]) {
  // Mermaid styling is intentionally minimal so the rendered diagram inherits
  // the surrounding theme on the frontend (light/dark) instead of fighting it.
  lines.push("    classDef root fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;");
  lines.push("    classDef module fill:#eef2ff,stroke:#4338ca,color:#3730a3;");
  lines.push("    classDef submodule fill:#f5f3ff,stroke:#6d28d9,color:#5b21b6;");
  lines.push("    classDef entrypoint fill:#ecfdf5,stroke:#047857,color:#065f46;");
  lines.push("    classDef config fill:#fefce8,stroke:#a16207,color:#713f12;");
  lines.push("    classDef file fill:#ffffff,stroke:#9ca3af,color:#1f2937;");
  lines.push("    classDef external fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-dasharray: 5 5;");
}

function buildServiceSummary(repoLabel: string, serviceCount: number, externalCount: number): string {
  return `${repoLabel}: ${serviceCount} service${serviceCount === 1 ? "" : "s"} and ${externalCount} external dependenc${externalCount === 1 ? "y" : "ies"} at service-level depth.`;
}

function buildModuleSummary(repoLabel: string, serviceCount: number, moduleCount: number): string {
  return `${repoLabel}: ${serviceCount} service${serviceCount === 1 ? "" : "s"} containing ${moduleCount} module${moduleCount === 1 ? "" : "s"} at module-level depth.`;
}

function buildFileSummary(repoLabel: string, fileCount: number, serviceCount: number): string {
  return `${repoLabel}: ${fileCount} key file${fileCount === 1 ? "" : "s"} across ${serviceCount} service${serviceCount === 1 ? "" : "s"} at file-level depth.`;
}

function countSubModules(subs: Map<string, string[]>): number {
  let total = 0;
  for (const list of subs.values()) {
    total += list.length;
  }
  return total;
}

function topLevelOf(path: string): string | null {
  if (!path) return null;
  const slash = path.indexOf("/");
  return slash === -1 ? null : path.slice(0, slash);
}

function escapeLabel(value: string): string {
  // Mermaid labels in `["..."]` syntax interpret double-quote pairs as the
  // literal label boundary. Escape internal double quotes so paths like
  // `src/components/"weird".tsx` (rare, but possible) don't break rendering.
  return value.replace(/"/g, "#quot;");
}

function quote(value: string): string {
  return `"${escapeLabel(value)}"`;
}

/**
 * Stable, collision-free Mermaid node id allocator. Mermaid ids must be
 * alphanumeric-or-underscore and shouldn't collide. We keep a cache keyed by
 * the *logical* identity (e.g. `service:src`) so repeat calls return the same
 * id, which is what produces deterministic output across snapshot runs.
 */
class NodeIdAllocator {
  private cache = new Map<string, string>();
  private used = new Set<string>();

  allocate(key: string, prefix: string): string {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const sanitized = sanitizeIdentifier(prefix + key);
    let candidate = sanitized;
    let counter = 1;
    while (this.used.has(candidate)) {
      counter += 1;
      candidate = `${sanitized}_${counter}`;
    }
    this.used.add(candidate);
    this.cache.set(key, candidate);
    return candidate;
  }
}

function sanitizeIdentifier(value: string): string {
  let cleaned = value.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
  // Mermaid identifiers cannot start with a digit.
  if (/^[0-9]/.test(cleaned)) {
    cleaned = `n_${cleaned}`;
  }
  if (cleaned.length === 0) {
    cleaned = "node";
  }
  if (cleaned.length > 48) {
    cleaned = cleaned.slice(0, 48);
  }
  return cleaned;
}
