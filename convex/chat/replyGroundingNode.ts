"use node";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { retrieveArtifactChunks, type RetrievedChunk } from "../lib/artifactRag";
import { ensureSandboxReady, type SandboxPreparationStage } from "../lib/sandboxLiveness";
import type { ReplyTurnContext } from "./context";
import {
  buildReadyArtifactEvidence,
  withArtifactEvidence,
  withPreparedLiveSource,
  type PromptArtifactEvidence,
  type ReplyGroundingPlan,
} from "./replyGrounding";

const DOCS_ARTIFACT_KINDS: Array<Doc<"artifacts">["kind"]> = [
  "architecture_diagram",
  "architecture_overview",
  "design_review",
  "migration_plan",
  "trade_off_matrix",
  "capacity_estimate",
];
const DOCS_ARTIFACTS_TOTAL_LIMIT = 12;

export async function hydrateReplyGroundingForGeneration(
  ctx: ActionCtx,
  args: {
    turnContext: ReplyTurnContext;
    threadId: Id<"threads">;
    userMessageId: Id<"messages">;
    query: string;
  },
): Promise<ReplyTurnContext> {
  const { grounding } = args.turnContext;
  if (grounding.artifactEvidence.kind !== "pending_retrieval") {
    return args.turnContext;
  }
  const repository = grounding.repository;
  if (!repository) {
    return {
      ...args.turnContext,
      grounding: withArtifactEvidence(grounding, { kind: "none" }),
    };
  }

  const fallbackArtifacts = await loadPromptArtifactFallbacks(ctx, {
    ownerTokenIdentifier: args.turnContext.ownerTokenIdentifier,
    repositoryId: repository.repositoryId,
    artifactScope: grounding.artifactEvidence.artifactScope,
  });
  const hasExplicitArtifactScope =
    grounding.artifactEvidence.artifactScope !== undefined && grounding.artifactEvidence.artifactScope.length > 0;

  if (hasExplicitArtifactScope && fallbackArtifacts.length === 0) {
    return {
      ...args.turnContext,
      grounding: withArtifactEvidence(grounding, buildReadyArtifactEvidence([])),
    };
  }

  const artifactScope = hasExplicitArtifactScope ? fallbackArtifacts.map((artifact) => artifact.artifactId) : undefined;
  const retrievedChunks = await retrieveArtifactChunks(ctx, {
    ownerTokenIdentifier: args.turnContext.ownerTokenIdentifier,
    repositoryId: repository.repositoryId,
    query: args.query,
    threadId: args.threadId,
    messageId: args.userMessageId,
    ...(artifactScope ? { artifactScope } : {}),
  });
  const chunkEvidence = retrievedChunks.map(toPromptArtifactChunkEvidence);
  const promptArtifacts = chunkEvidence.length > 0 ? chunkEvidence : fallbackArtifacts;

  return {
    ...args.turnContext,
    grounding: withArtifactEvidence(grounding, buildReadyArtifactEvidence(promptArtifacts)),
  };
}

export async function prepareLiveSourceGrounding(
  ctx: ActionCtx,
  args: {
    grounding: ReplyGroundingPlan;
    jobId: Id<"jobs">;
  },
): Promise<ReplyGroundingPlan> {
  if (args.grounding.liveSource.kind === "none") {
    return args.grounding;
  }

  const stageProgress: Record<SandboxPreparationStage, number> = {
    probing: 0.18,
    waking: 0.2,
    provisioning: 0.22,
    cloning: 0.3,
    polling: 0.32,
  };

  await ctx.runMutation(internal.chat.streaming.updateAssistantReplyProgress, {
    jobId: args.jobId,
    stage: "Preparing live source…",
    progress: 0.18,
  });

  const prepared = await ensureSandboxReady(
    ctx,
    {
      repositoryId: args.grounding.liveSource.repositoryId,
      ownerTokenIdentifier: args.grounding.liveSource.ownerTokenIdentifier,
    },
    async (stage) => {
      await ctx.runMutation(internal.chat.streaming.updateAssistantReplyProgress, {
        jobId: args.jobId,
        stage: "Preparing live source…",
        progress: stageProgress[stage] ?? 0.2,
      });
    },
  );

  return withPreparedLiveSource(args.grounding, {
    sandboxId: prepared.sandboxId,
    remoteId: prepared.remoteId,
    repoPath: prepared.repoPath,
  });
}

async function loadPromptArtifactFallbacks(
  ctx: ActionCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    artifactScope?: Id<"artifacts">[];
  },
): Promise<PromptArtifactEvidence[]> {
  if (args.artifactScope && args.artifactScope.length > 0) {
    const scoped = await Promise.all(
      args.artifactScope.map((artifactId) => ctx.runQuery(internal.artifactStore.getArtifact, { artifactId })),
    );
    return scoped
      .filter(
        (artifact): artifact is Doc<"artifacts"> =>
          artifact !== null &&
          artifact.repositoryId === args.repositoryId &&
          artifact.ownerTokenIdentifier === args.ownerTokenIdentifier,
      )
      .map(toPromptArtifactFallbackEvidence);
  }

  const perKindResults = await Promise.all(
    DOCS_ARTIFACT_KINDS.map((kind) =>
      ctx.runQuery(internal.artifactStore.listByRepositoryAndKind, {
        repositoryId: args.repositoryId,
        kind,
        limit: DOCS_ARTIFACTS_TOTAL_LIMIT,
      }),
    ),
  );
  const artifacts = perKindResults
    .flat()
    .filter((artifact) => artifact.ownerTokenIdentifier === args.ownerTokenIdentifier);

  artifacts.sort((left, right) => {
    if (right._creationTime !== left._creationTime) {
      return right._creationTime - left._creationTime;
    }
    return right._id > left._id ? 1 : -1;
  });

  return artifacts.slice(0, DOCS_ARTIFACTS_TOTAL_LIMIT).map(toPromptArtifactFallbackEvidence);
}

function toPromptArtifactFallbackEvidence(artifact: Doc<"artifacts">): PromptArtifactEvidence {
  return {
    kind: "artifact",
    artifactId: artifact._id,
    artifactKind: artifact.kind,
    artifactVersion: artifact.version,
    title: artifact.title,
    description: artifact.description,
    contentMarkdown: artifact.contentMarkdown,
  };
}

function toPromptArtifactChunkEvidence(chunk: RetrievedChunk): PromptArtifactEvidence {
  return {
    kind: "chunk",
    chunkId: chunk.chunkId,
    artifactId: chunk.artifactId,
    artifactTitle: chunk.artifactTitle,
    artifactKind: chunk.artifactKind,
    artifactVersion: chunk.artifactVersion,
    headingPath: chunk.headingPath,
    content: chunk.content,
    lexicalScore: chunk.lexicalScore,
    semanticScore: chunk.semanticScore,
    rrfScore: chunk.rrfScore,
  };
}
