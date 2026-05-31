/// <reference types="vite/client" />

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

// Architecture invariant: the multi-provider abstraction lives behind
// `convex/lib/llmGateway.ts`. NO other convex source file may import
// the raw provider SDKs (`@ai-sdk/openai`, `@ai-sdk/anthropic`); going
// through the gateway is the only way to reach a model. Tests are
// allowed to import the SDKs for mocking purposes, and the generated
// Convex files / evaluation harnesses are excluded too.
//
// If this test fails, a consumer has bypassed the gateway. Move the
// call site behind `generateViaGateway` / `embedViaGateway` so quota,
// retry, cost tracking, and pricing stay consistent across providers.

const CONVEX_ROOT = join(__dirname, "..");
const GATEWAY_RELATIVE_PATH = join("lib", "llmGateway.ts");
const FORBIDDEN_IMPORT_PATTERN = /^\s*import\s.+?from\s+["']@ai-sdk\/(openai|anthropic)["']/m;
const EXCLUDED_DIRECTORIES = new Set(["_generated", "eval", "node_modules"]);

type ForbiddenImport = {
  file: string;
  line: number;
  source: string;
};

function collectTsFiles(rootDir: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      collected.push(absolutePath);
    }
  }
  return collected;
}

function findForbiddenImports(): ForbiddenImport[] {
  const offenders: ForbiddenImport[] = [];
  for (const filePath of collectTsFiles(CONVEX_ROOT)) {
    const relativePath = relative(CONVEX_ROOT, filePath);
    if (relativePath === GATEWAY_RELATIVE_PATH) continue;
    if (relativePath.endsWith(".test.ts")) continue;

    const contents = readFileSync(filePath, "utf8");
    const lines = contents.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (FORBIDDEN_IMPORT_PATTERN.test(line)) {
        offenders.push({ file: relativePath, line: i + 1, source: line.trim() });
      }
    }
  }
  return offenders;
}

describe("provider abstraction integrity", () => {
  test("no convex source file outside lib/llmGateway.ts imports @ai-sdk/openai or @ai-sdk/anthropic", () => {
    const offenders = findForbiddenImports();
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  - ${o.file}:${o.line} -> ${o.source}`).join("\n");
      throw new Error(
        [
          "Found provider SDK imports outside convex/lib/llmGateway.ts.",
          "Route the call site through generateViaGateway / embedViaGateway instead:",
          detail,
        ].join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
