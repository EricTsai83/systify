import { describe, expect, test } from "vitest";
import {
  TEXT_EXTENSIONS,
  type RepositorySnapshot,
  createRepoFileRecords,
  detectLanguageFromExtension,
  detectPackageManagers,
} from "./repoAnalysis";

/**
 * These helpers are the single source of truth for the four cached
 * boolean fields on `repoFiles` (`isEntryPoint` / `isConfig` /
 * `isImportant` / `language`) and for `buildRepositoryManifest`, which
 * import uses to populate repository metadata. The rules ran
 * untested for months — silent regressions (e.g. the historical
 * `path.endsWith("src/main.")` dead-pattern) only surfaced once we
 * tried to widen ecosystem coverage. The cases here pin each
 * detection rule individually so future edits cannot silently drop
 * a language, a manager, or an entrypoint shape.
 */

function makeSnapshot(paths: string[]): RepositorySnapshot {
  return {
    importantFileContents: [],
    files: paths.map((path) => ({
      path,
      parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      fileType: "file" as const,
      sizeBytes: 0,
      isEntryPoint: false,
      isConfig: false,
      isImportant: false,
    })),
  };
}

function classifyFile(path: string) {
  const [record] = createRepoFileRecords([{ path, fileType: "file", sizeBytes: 0 }]);
  return record;
}

describe("detectLanguageFromExtension", () => {
  test.each([
    ["ts", "TypeScript"],
    ["tsx", "TypeScript"],
    ["js", "JavaScript"],
    ["jsx", "JavaScript"],
    ["mjs", "JavaScript"],
    ["cjs", "JavaScript"],
    ["py", "Python"],
    ["rs", "Rust"],
    ["go", "Go"],
    ["java", "Java"],
    ["kt", "Kotlin"],
    ["rb", "Ruby"],
    ["sh", "Shell"],
    ["sql", "SQL"],
    ["php", "PHP"],
    ["swift", "Swift"],
    ["c", "C"],
    ["h", "C"],
    ["cpp", "C++"],
    ["cc", "C++"],
    ["cxx", "C++"],
    ["hpp", "C++"],
    ["cs", "C#"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
    ["astro", "Astro"],
    ["ex", "Elixir"],
    ["exs", "Elixir"],
    ["lua", "Lua"],
    ["r", "R"],
    ["dart", "Dart"],
    ["md", "Markdown"],
    ["json", "JSON"],
    ["toml", "TOML"],
    ["yaml", "YAML"],
    ["yml", "YAML"],
    ["css", "CSS"],
    ["scss", "CSS"],
    ["html", "HTML"],
    ["txt", "Text"],
  ])("maps %j to %j", (ext, language) => {
    expect(detectLanguageFromExtension(ext)).toBe(language);
  });

  test("returns undefined for an unknown extension", () => {
    expect(detectLanguageFromExtension("xyzzy")).toBeUndefined();
  });
});

describe("TEXT_EXTENSIONS / detectLanguageFromExtension invariant", () => {
  // If a file is text-readable for chunking, it must also produce a
  // detected language for the manifest. The two sets used to drift —
  // `rb` / `java` / `kt` / `sh` / `sql` were in TEXT_EXTENSIONS but
  // not in the language switch, so those files were ingested but
  // never surfaced in `detectedLanguages`.
  test.each(Array.from(TEXT_EXTENSIONS))("recognizes %j", (extension) => {
    expect(detectLanguageFromExtension(extension)).toBeDefined();
  });
});

describe("detectPackageManagers", () => {
  test("returns [] for a snapshot with no manifest files", () => {
    expect(detectPackageManagers(makeSnapshot([]))).toEqual([]);
  });

  test.each([
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pyproject.toml", "pip/uv"],
    ["Cargo.toml", "cargo"],
    ["go.mod", "go modules"],
    ["Gemfile.lock", "bundler"],
    ["Gemfile", "bundler"],
    ["composer.lock", "composer"],
    ["composer.json", "composer"],
    ["Pipfile.lock", "pipenv"],
    ["pom.xml", "maven"],
    ["build.gradle", "gradle"],
    ["build.gradle.kts", "gradle"],
    ["Podfile.lock", "cocoapods"],
    ["mix.lock", "hex (mix)"],
  ])("detects %j as %j", (path, manager) => {
    expect(detectPackageManagers(makeSnapshot([path]))).toContain(manager);
  });

  test("requirements.txt alone reports pip", () => {
    expect(detectPackageManagers(makeSnapshot(["requirements.txt"]))).toContain("pip");
  });

  test("requirements.txt alongside pyproject.toml reports only pip/uv", () => {
    // requirements.txt is often kept around for CI/Docker bootstrapping
    // even in modern pyproject-driven projects; the rule below avoids
    // double-reporting both pip and pip/uv in that case.
    const managers = detectPackageManagers(makeSnapshot(["requirements.txt", "pyproject.toml"]));
    expect(managers).toContain("pip/uv");
    expect(managers).not.toContain("pip");
  });
});

describe("createRepoFileRecords — isEntryPoint", () => {
  // Stem-mode (the `ENTRYPOINT_STEMS` path). The historical
  // `path.endsWith("src/main.")` pattern never matched real files
  // because every real file has content after the trailing dot; we
  // now match `stripExt(path)` against the stem set instead, so
  // `src/main.rs`, `src/App.tsx`, etc. become true entrypoints.
  test.each([
    "src/main.ts",
    "src/main.rs",
    "src/main.tsx",
    "src/App.tsx",
    "app/page.tsx",
    "app/layout.tsx",
    "pages/_app.tsx",
    "pages/index.tsx",
    "src/index.ts",
  ])("flags %j as entrypoint via stem match", (path) => {
    expect(classifyFile(path).isEntryPoint).toBe(true);
  });

  // Filename-mode (the `ENTRYPOINT_FILENAMES` path).
  test.each([
    "main.py",
    "manage.py",
    "app.py",
    "main.go",
    "server.ts",
    "server.js",
    "app.js",
    "index.js",
    "index.ts",
    "index.tsx",
    "index.html",
  ])("flags %j as entrypoint via filename match", (path) => {
    expect(classifyFile(path).isEntryPoint).toBe(true);
  });

  test.each([
    // Same basename as a known stem, but in a non-root subdirectory.
    "src/components/main.ts",
    // Not a recognised filename and not at a recognised stem.
    "lib/server.py",
    // A regular leaf component, not an entrypoint shape.
    "src/components/Button.tsx",
  ])("does not flag %j as entrypoint", (path) => {
    expect(classifyFile(path).isEntryPoint).toBe(false);
  });
});

describe("createRepoFileRecords — isConfig", () => {
  test.each([
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    ".eslintrc.json",
    "prettier.config.js",
    "tailwind.config.ts",
    "convex/auth.config.ts",
    "convex/convex.config.ts",
    "convex/_generated/api.d.ts",
  ])("flags %j as config", (path) => {
    expect(classifyFile(path).isConfig).toBe(true);
  });

  test.each([
    // Business logic under convex/ must not be matched by the blanket
    // "convex/" config pattern.
    "convex/agent/chat.ts",
    "convex/chat/redaction.ts",
    "convex/repositories.ts",
    // Source under src/ that is not a known config family.
    "src/lib/utils.ts",
  ])("does not flag %j as config", (path) => {
    expect(classifyFile(path).isConfig).toBe(false);
  });
});

describe("createRepoFileRecords — isImportant", () => {
  test.each([
    "README.md",
    "convex/schema.ts",
    "convex/http.ts",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "Pipfile",
    "Podfile",
    "requirements.txt",
    "mix.exs",
    // Transitively important via isEntryPoint / isConfig.
    "src/main.rs",
    "package.json",
  ])("flags %j as important", (path) => {
    expect(classifyFile(path).isImportant).toBe(true);
  });

  test.each([
    // Once "convex/" is no longer a config pattern, these business-logic
    // files should not be falsely promoted into the manifest's
    // `importantFiles` list.
    "convex/agent/chat.ts",
    "convex/chat/redaction.ts",
    // A generic source file in a typical project layout.
    "src/lib/utils.ts",
  ])("does not flag %j as important", (path) => {
    expect(classifyFile(path).isImportant).toBe(false);
  });
});
