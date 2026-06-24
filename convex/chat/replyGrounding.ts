import type { Doc, Id } from "../_generated/dataModel";
import type { ChatMode } from "../lib/chatMode";
import { MAX_CONTEXT_ARTIFACTS } from "../lib/constants";

export type ExtendedChatMode = ChatMode;

export type SandboxTooling = {
  sandboxId: Id<"sandboxes">;
  remoteId: string;
  repoPath: string;
};

export type RepositoryGroundingSnapshot = {
  repositoryId: Id<"repositories">;
  sourceRepoFullName?: string;
  repositorySummary?: string;
  readmeSummary?: string;
  architectureSummary?: string;
};

export type PromptArtifactEvidence =
  | {
      kind: "artifact";
      artifactId: Id<"artifacts">;
      title: string;
      description: string;
      contentMarkdown: string;
    }
  | {
      kind: "chunk";
      chunkId: Id<"artifactChunks">;
      artifactId: Id<"artifacts">;
      artifactTitle: string;
      artifactKind: Doc<"artifacts">["kind"];
      headingPath: string[];
      content: string;
      lexicalScore: number;
      semanticScore: number;
      rrfScore: number;
    };

export type CitationMapEntry = {
  index: number;
  artifactId: Id<"artifacts">;
  chunkId?: Id<"artifactChunks">;
  headingPath?: string[];
};

export type ArtifactGroundingEvidence =
  | { kind: "none" }
  | { kind: "pending_retrieval"; artifactScope?: Id<"artifacts">[] }
  | {
      kind: "ready";
      promptArtifacts: PromptArtifactEvidence[];
      citationMap: CitationMapEntry[];
    };

export type LiveSourceGroundingIntent =
  | { kind: "none" }
  | {
      kind: "prepare";
      repositoryId: Id<"repositories">;
      ownerTokenIdentifier: string;
      readyHint?: SandboxTooling;
    };

export type ReplyGroundingPlan = {
  mode: ExtendedChatMode;
  flags: {
    groundLibrary: boolean;
    groundSandbox: boolean;
  };
  repository: RepositoryGroundingSnapshot | null;
  artifactEvidence: ArtifactGroundingEvidence;
  liveSource: LiveSourceGroundingIntent;
};

export type ReadyReplyGrounding = Omit<ReplyGroundingPlan, "artifactEvidence"> & {
  artifactEvidence: Exclude<ArtifactGroundingEvidence, { kind: "pending_retrieval" }>;
};

export function createReplyGroundingPlan(args: {
  mode: ExtendedChatMode;
  flags: ReplyGroundingPlan["flags"];
  ownerTokenIdentifier: string;
  repository: RepositoryGroundingSnapshot | null;
  artifactScope?: Id<"artifacts">[];
}): ReplyGroundingPlan {
  const usesRepository =
    args.repository !== null &&
    (args.mode === "library" || args.flags.groundLibrary === true || args.flags.groundSandbox === true);
  const repository = usesRepository ? args.repository : null;
  const shouldRetrieveArtifacts = repository !== null && (args.mode === "library" || args.flags.groundLibrary === true);
  const shouldPrepareLiveSource = repository !== null && args.flags.groundSandbox === true;

  return {
    mode: args.mode,
    flags: args.flags,
    repository,
    artifactEvidence: shouldRetrieveArtifacts
      ? {
          kind: "pending_retrieval",
          ...(args.artifactScope && args.artifactScope.length > 0 ? { artifactScope: args.artifactScope } : {}),
        }
      : { kind: "none" },
    liveSource: shouldPrepareLiveSource
      ? {
          kind: "prepare",
          repositoryId: repository.repositoryId,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
        }
      : { kind: "none" },
  };
}

export function buildReadyArtifactEvidence(promptArtifacts: PromptArtifactEvidence[]): ArtifactGroundingEvidence {
  const visiblePromptArtifacts = promptArtifacts.slice(0, MAX_CONTEXT_ARTIFACTS);
  return {
    kind: "ready",
    promptArtifacts: visiblePromptArtifacts,
    citationMap: buildCitationMapFromPromptArtifacts(visiblePromptArtifacts),
  };
}

export function buildCitationMapFromArtifactEvidence(evidence: ArtifactGroundingEvidence): CitationMapEntry[] {
  if (evidence.kind !== "ready") {
    return [];
  }
  return evidence.citationMap;
}

export function withArtifactEvidence(
  grounding: ReplyGroundingPlan,
  artifactEvidence: ArtifactGroundingEvidence,
): ReplyGroundingPlan {
  return {
    ...grounding,
    artifactEvidence,
  };
}

export function withPreparedLiveSource(grounding: ReplyGroundingPlan, readyHint: SandboxTooling): ReplyGroundingPlan {
  if (grounding.liveSource.kind !== "prepare") {
    return grounding;
  }
  return {
    ...grounding,
    liveSource: {
      ...grounding.liveSource,
      readyHint,
    },
  };
}

export function getPreparedSandboxTooling(grounding: ReplyGroundingPlan): SandboxTooling | undefined {
  return grounding.liveSource.kind === "prepare" ? grounding.liveSource.readyHint : undefined;
}

function buildCitationMapFromPromptArtifacts(promptArtifacts: PromptArtifactEvidence[]): CitationMapEntry[] {
  return promptArtifacts.map((artifact, index) => {
    if (artifact.kind === "chunk") {
      return {
        index: index + 1,
        artifactId: artifact.artifactId,
        chunkId: artifact.chunkId,
        headingPath: artifact.headingPath,
      };
    }
    return {
      index: index + 1,
      artifactId: artifact.artifactId,
    };
  });
}
