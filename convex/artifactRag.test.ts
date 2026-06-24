import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import type { ArtifactChunkSearchHit } from "./artifactChunkStore";
import { retrieveArtifactChunks } from "./lib/artifactRag";

function makeId<TableName extends "artifactChunks" | "artifacts" | "repositories" | "messages" | "threads">(
  tableName: TableName,
  suffix: string,
): Id<TableName> {
  return `${tableName}_${suffix}` as unknown as Id<TableName>;
}

function makeHit(args: {
  chunkId: Id<"artifactChunks">;
  artifactId: Id<"artifacts">;
  artifactTitle: string;
  lexicalScore: number;
}): ArtifactChunkSearchHit {
  return {
    chunkId: args.chunkId,
    artifactId: args.artifactId,
    artifactVersion: 1,
    chunkIndex: 0,
    headingPath: ["Architecture"],
    content: `${args.artifactTitle} content`,
    summary: "Chunk summary",
    artifactTitle: args.artifactTitle,
    artifactKind: "architecture_overview",
    lexicalScore: args.lexicalScore,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retrieveArtifactChunks", () => {
  test("falls back to scoped lexical results when semantic retrieval cannot embed the query", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const repositoryId = makeId("repositories", "repo");
    const artifactA = makeId("artifacts", "a");
    const artifactB = makeId("artifacts", "b");
    const hitA = makeHit({
      chunkId: makeId("artifactChunks", "a"),
      artifactId: artifactA,
      artifactTitle: "Scoped artifact",
      lexicalScore: 0.5,
    });
    const hitB = makeHit({
      chunkId: makeId("artifactChunks", "b"),
      artifactId: artifactB,
      artifactTitle: "Out-of-scope artifact",
      lexicalScore: 1,
    });

    let runQueryCallIndex = 0;
    const lexicalResults: ArtifactChunkSearchHit[][] = [[hitB, hitA], [hitA]];
    const runQuery = vi.fn(async () => {
      const result = lexicalResults[runQueryCallIndex] ?? [];
      runQueryCallIndex += 1;
      return result;
    });
    const runMutation = vi.fn(async (..._args: unknown[]) => {
      throw new Error("embedding budget unavailable");
    });
    const vectorSearch = vi.fn(async () => []);
    const ctx = { runQuery, runMutation, vectorSearch } as unknown as ActionCtx;

    const results = await retrieveArtifactChunks(ctx, {
      ownerTokenIdentifier: "user|artifact-rag-test",
      repositoryId,
      artifactScope: [artifactA],
      query: "architecture",
      topN: 3,
      candidateK: 3,
      threadId: makeId("threads", "thread"),
      messageId: makeId("messages", "message"),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunkId: hitA.chunkId,
      artifactId: artifactA,
      artifactTitle: "Scoped artifact",
      artifactKind: "architecture_overview",
      headingPath: ["Architecture"],
      content: "Scoped artifact content",
      lexicalScore: 0.5,
      semanticScore: 0,
    });
    expect(results[0]?.rrfScore).toBeGreaterThan(0);
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runMutation).toHaveBeenCalled();
    expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
      sourceId: expect.stringMatching(
        /^libraryRetrieval:user\|artifact-rag-test:repositories_repo:messages_message:[a-f0-9]{64}$/,
      ),
    });
    expect(vectorSearch).not.toHaveBeenCalled();
  });
});
