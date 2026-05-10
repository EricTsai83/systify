import { describe, expect, test } from "vitest";
import { chunkArtifactMarkdown } from "./lib/artifactChunking";

describe("chunkArtifactMarkdown", () => {
  test("force-splits long code blocks under the hard cap", () => {
    const chunks = chunkArtifactMarkdown(`\`\`\`ts\n${"x".repeat(120)}\n\`\`\``, {
      softTokenCap: 10,
      hardTokenCap: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 20)).toBe(true);
  });
});
