import { MAX_CHUNKS_PER_FILE } from "./constants";

type FileNode = {
  path: string;
  parentPath: string;
  fileType: "file" | "dir";
  extension?: string;
  language?: string;
  sizeBytes: number;
  isEntryPoint: boolean;
  isConfig: boolean;
  isImportant: boolean;
  summary?: string;
};

type ChunkRecord = {
  path: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  chunkKind: "code" | "summary" | "readme";
  symbolName?: string;
  symbolKind?: string;
  summary: string;
  content: string;
};

export type RepositorySnapshot = {
  readmePath?: string;
  readmeContent?: string;
  packageJsonContent?: string;
  pyprojectContent?: string;
  cargoTomlContent?: string;
  importantFileContents: Array<{ path: string; content: string }>;
  files: FileNode[];
};

export type RepositoryManifest = {
  detectedLanguages: string[];
  packageManagers: string[];
  entrypoints: string[];
  importantFiles: string[];
  summary: string;
};

const IMPORTANT_FILE_PATTERNS = [
  "README",
  "package.json",
  "vite.config",
  "tsconfig",
  "convex/schema",
  "convex/http",
  "src/main",
  "src/app",
  "src/App",
  "app/page",
  "main.py",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

const ENTRYPOINT_PATTERNS = ["src/main.", "src/App.", "app/page.", "main.py", "index.ts", "index.tsx", "server.ts"];
const CONFIG_PATTERNS = ["package.json", "tsconfig", "vite.config", "eslint", "prettier", "tailwind", "convex/"];
const TEXT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "toml",
  "yaml",
  "yml",
  "css",
  "scss",
  "html",
  "sql",
  "sh",
  "txt",
]);

export function buildRepositoryManifest(snapshot: RepositorySnapshot): RepositoryManifest {
  const detectedLanguages = unique(
    snapshot.files.map((file) => file.language).filter((value): value is string => !!value),
  );
  const packageManagers = detectPackageManagers(snapshot);
  const entrypoints = snapshot.files
    .filter((file) => file.isEntryPoint)
    .map((file) => file.path)
    .slice(0, 12);
  const importantFiles = snapshot.files
    .filter((file) => file.isImportant)
    .map((file) => file.path)
    .slice(0, 20);

  const summaryParts = [
    "Repository",
    detectedLanguages.length > 0 ? `using ${detectedLanguages.join(", ")}` : undefined,
    entrypoints.length > 0 ? `with ${entrypoints.length} likely entrypoints` : undefined,
  ].filter(Boolean);

  return {
    detectedLanguages,
    packageManagers,
    entrypoints,
    importantFiles,
    summary: summaryParts.join(" ") || "Repository imported for analysis.",
  };
}

export function createRepoFileRecords(paths: Array<{ path: string; fileType: "file" | "dir"; sizeBytes: number }>) {
  return paths.map((item) => {
    const extension = item.fileType === "file" ? getExtension(item.path) : undefined;
    const parentPath = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    const fileName = item.path.split("/").pop() ?? item.path;
    const isEntryPoint = ENTRYPOINT_PATTERNS.some((pattern) => item.path.endsWith(pattern));
    const isConfig = CONFIG_PATTERNS.some((pattern) => item.path.includes(pattern) || fileName === pattern);
    const isImportant =
      isEntryPoint || isConfig || IMPORTANT_FILE_PATTERNS.some((pattern) => item.path.includes(pattern));

    return {
      path: item.path,
      parentPath,
      fileType: item.fileType,
      extension,
      language: extension ? detectLanguageFromExtension(extension) : undefined,
      sizeBytes: item.sizeBytes,
      isEntryPoint,
      isConfig,
      isImportant,
      summary: summarizePath(item.path, isEntryPoint, isConfig),
    } satisfies FileNode;
  });
}

export function createChunkRecords(snapshot: RepositorySnapshot): ChunkRecord[] {
  const records: ChunkRecord[] = [];

  if (snapshot.readmeContent && snapshot.readmePath) {
    records.push(...chunkText(snapshot.readmePath, snapshot.readmeContent, "readme"));
  }

  for (const item of snapshot.importantFileContents.slice(0, 10)) {
    records.push(...chunkText(item.path, item.content, "code"));
  }

  return records.slice(0, 60);
}

export function createManifestArtifactMarkdown(manifest: RepositoryManifest) {
  const lines = [
    "# Repository Manifest",
    "",
    `- Languages: ${manifest.detectedLanguages.join(", ") || "Unknown"}`,
    `- Package managers: ${manifest.packageManagers.join(", ") || "Unknown"}`,
    "",
    "## Likely Entrypoints",
    manifest.entrypoints.length > 0
      ? manifest.entrypoints.map((path) => `- \`${path}\``).join("\n")
      : "- None detected",
    "",
    "## Important Files",
    manifest.importantFiles.length > 0
      ? manifest.importantFiles.map((path) => `- \`${path}\``).join("\n")
      : "- No important files detected yet",
  ];

  return lines.join("\n");
}

export function createArchitectureArtifactMarkdown(manifest: RepositoryManifest, snapshot: RepositorySnapshot) {
  const importantFiles = snapshot.files
    .filter((file) => file.isImportant && file.fileType === "file")
    .map((file) => file.path)
    .slice(0, 12);

  const lines = [
    "# Architecture Overview",
    "",
    "Architecture overview generated from repository layout.",
    "",
    manifest.entrypoints.length > 0
      ? `Primary execution candidates: ${manifest.entrypoints.map((path) => `\`${path}\``).join(", ")}.`
      : "Primary execution candidates were not detected automatically.",
    "",
    "## Files Worth Reading First",
    importantFiles.length > 0
      ? importantFiles.map((path) => `- \`${path}\``).join("\n")
      : "- No high-signal files found yet.",
    "",
    "## Suggested Analysis Flow",
    "- Read the README and top-level config files.",
    "- Inspect entrypoints to locate the application boundary.",
    "- Follow framework-specific folders to map data flow and API surface.",
  ];

  return lines.join("\n");
}

function detectPackageManagers(snapshot: RepositorySnapshot) {
  const paths = new Set(snapshot.files.map((file) => file.path));
  const managers: string[] = [];
  if (paths.has("package-lock.json")) managers.push("npm");
  if (paths.has("pnpm-lock.yaml")) managers.push("pnpm");
  if (paths.has("yarn.lock")) managers.push("yarn");
  if (paths.has("bun.lockb") || paths.has("bun.lock")) managers.push("bun");
  if (paths.has("pyproject.toml")) managers.push("pip/uv");
  if (paths.has("Cargo.toml")) managers.push("cargo");
  return managers;
}

function chunkText(path: string, content: string, chunkKind: "code" | "summary" | "readme") {
  const lines = content.split("\n");
  const chunks: ChunkRecord[] = [];
  const size = chunkKind === "readme" ? 80 : 60;

  for (let i = 0; i < lines.length; i += size) {
    const slice = lines.slice(i, i + size);
    const text = slice.join("\n").trim();
    if (!text) {
      continue;
    }

    chunks.push({
      path,
      chunkIndex: chunks.length,
      startLine: i + 1,
      endLine: i + slice.length,
      chunkKind,
      summary: summarizeChunk(path, text, chunkKind),
      content: text.slice(0, 8000),
    });
  }

  return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

function summarizeChunk(path: string, content: string, chunkKind: "code" | "summary" | "readme") {
  if (chunkKind === "readme") {
    return `README excerpt from ${path}`;
  }

  const firstMeaningfulLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstMeaningfulLine ? `${path}: ${firstMeaningfulLine}`.slice(0, 180) : `Code excerpt from ${path}`;
}

function summarizePath(path: string, isEntryPoint: boolean, isConfig: boolean) {
  if (isEntryPoint) {
    return "Likely application entrypoint";
  }
  if (isConfig) {
    return "Configuration or framework boundary file";
  }
  if (path.includes("/components/")) {
    return "UI component file";
  }
  if (path.includes("/api/") || path.includes("/routes/")) {
    return "API or route definition";
  }
  return undefined;
}

function getExtension(path: string) {
  const fileName = path.split("/").pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > -1 ? fileName.slice(dotIndex + 1).toLowerCase() : undefined;
}

function detectLanguageFromExtension(extension: string) {
  switch (extension) {
    case "ts":
    case "tsx":
      return "TypeScript";
    case "js":
    case "jsx":
      return "JavaScript";
    case "py":
      return "Python";
    case "rs":
      return "Rust";
    case "go":
      return "Go";
    case "md":
      return "Markdown";
    case "json":
      return "JSON";
    case "toml":
      return "TOML";
    case "yml":
    case "yaml":
      return "YAML";
    case "css":
    case "scss":
      return "CSS";
    case "html":
      return "HTML";
    default:
      return undefined;
  }
}

export function shouldReadFile(path: string) {
  const extension = getExtension(path);
  return Boolean(extension && TEXT_EXTENSIONS.has(extension)) || path.endsWith("README") || path.endsWith("README.md");
}

function unique(values: string[]) {
  return Array.from(new Set(values)).slice(0, 12);
}
