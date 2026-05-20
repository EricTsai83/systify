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
  "app/layout",
  "pages/_app",
  "pages/index",
  "src/index",
  "main.py",
  "manage.py",
  "app.py",
  "main.go",
  "server.js",
  "app.js",
  "index.html",
  "pom.xml",
  "build.gradle",
  "go.mod",
  "Gemfile",
  "composer.json",
  "composer.lock",
  "Pipfile",
  "Podfile",
  "requirements.txt",
  "mix.exs",
  "mix.lock",
  "pyproject.toml",
  "Cargo.toml",
];

const ENTRYPOINT_STEMS = ["src/main", "src/App", "app/page", "app/layout", "pages/_app", "pages/index", "src/index"];
const ENTRYPOINT_FILENAMES = new Set([
  "main.py",
  "manage.py",
  "app.py",
  "main.go",
  "server.js",
  "app.js",
  "index.js",
  "index.ts",
  "index.tsx",
  "server.ts",
  "index.html",
]);
const CONFIG_PATTERNS = [
  "package.json",
  "tsconfig",
  "vite.config",
  "eslint",
  "prettier",
  "tailwind",
  "convex/auth.config",
  "convex/convex.config",
  "convex/_generated/",
];
export const TEXT_EXTENSIONS = new Set([
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
  "php",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "cs",
  "vue",
  "svelte",
  "astro",
  "ex",
  "exs",
  "lua",
  "r",
  "dart",
]);

function stripExt(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) : path;
}

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
    const isEntryPoint = ENTRYPOINT_STEMS.includes(stripExt(item.path)) || ENTRYPOINT_FILENAMES.has(fileName);
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

export function detectPackageManagers(snapshot: RepositorySnapshot) {
  const paths = new Set(snapshot.files.map((file) => file.path));
  const managers: string[] = [];
  if (paths.has("package-lock.json")) managers.push("npm");
  if (paths.has("pnpm-lock.yaml")) managers.push("pnpm");
  if (paths.has("yarn.lock")) managers.push("yarn");
  if (paths.has("bun.lockb") || paths.has("bun.lock")) managers.push("bun");
  if (paths.has("pyproject.toml")) managers.push("pip/uv");
  if (paths.has("Cargo.toml")) managers.push("cargo");
  if (paths.has("go.mod")) managers.push("go modules");
  if (paths.has("Gemfile.lock") || paths.has("Gemfile")) managers.push("bundler");
  if (paths.has("composer.lock") || paths.has("composer.json")) managers.push("composer");
  if (paths.has("Pipfile.lock")) managers.push("pipenv");
  if (paths.has("requirements.txt") && !paths.has("pyproject.toml")) managers.push("pip");
  if (paths.has("pom.xml")) managers.push("maven");
  if (paths.has("build.gradle") || paths.has("build.gradle.kts")) managers.push("gradle");
  if (paths.has("Podfile.lock")) managers.push("cocoapods");
  if (paths.has("mix.lock")) managers.push("hex (mix)");
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

export function detectLanguageFromExtension(extension: string) {
  switch (extension) {
    case "ts":
    case "tsx":
      return "TypeScript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "JavaScript";
    case "py":
      return "Python";
    case "rs":
      return "Rust";
    case "go":
      return "Go";
    case "java":
      return "Java";
    case "kt":
      return "Kotlin";
    case "rb":
      return "Ruby";
    case "sh":
      return "Shell";
    case "sql":
      return "SQL";
    case "php":
      return "PHP";
    case "swift":
      return "Swift";
    case "c":
    case "h":
      return "C";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "C++";
    case "cs":
      return "C#";
    case "vue":
      return "Vue";
    case "svelte":
      return "Svelte";
    case "astro":
      return "Astro";
    case "ex":
    case "exs":
      return "Elixir";
    case "lua":
      return "Lua";
    case "r":
      return "R";
    case "dart":
      return "Dart";
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
    case "txt":
      return "Text";
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
