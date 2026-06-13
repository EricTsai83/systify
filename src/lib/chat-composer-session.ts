import type { FunctionArgs } from "convex/server";
import type { api } from "../../convex/_generated/api";
import type { GroundingAxisLike } from "@/components/grounding-toggle-bar";
import type { ViewerAccess } from "@/hooks/use-viewer-access";
import { isViewerFeatureEnabled } from "@/hooks/use-viewer-access";
import { getModelAccessDisabledReason } from "@/hooks/use-model-access-disabled-reason";
import { DEMO_MODE_COPY } from "@/lib/demo-content";
import type {
  ArtifactId,
  ChatMode,
  LlmProvider,
  ModelPreferenceScope,
  PickableModelEntry,
  ReasoningEffort,
  RepositoryId,
  ThreadId,
  UserPickableCapability,
} from "@/lib/types";

export type SendMessageArgs = FunctionArgs<typeof api.chat.send.sendMessage>;
export type SendMessageStartingNewThreadArgs = FunctionArgs<typeof api.chat.send.sendMessageStartingNewThread>;

export type ChatSendRequest =
  | { kind: "existingThread"; args: SendMessageArgs }
  | { kind: "newThread"; args: SendMessageStartingNewThreadArgs };

export type ComposerSurface = "repository" | "repoless";

export type ComposerModelRoute = {
  capability: UserPickableCapability;
  preferenceScope: ModelPreferenceScope;
};

export type ComposerGroundingAvailability = {
  library: GroundingAxisLike;
  sandbox: GroundingAxisLike;
};

export type ComposerAccessResolution = {
  chatSendDisabledReason?: string;
  sandboxGroundingDisabledReason?: string;
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
  generateSystemDesignDisabledReason?: string;
  modelAccessDisabledReason?: string;
};

const ACCESS_LOADING_REASON = "Loading access...";
const GROUNDING_LOADING_AXIS = {
  enabled: false,
  code: "loading",
  message: "Loading grounding availability...",
} as const;

export function resolveComposerModelRoute(args: {
  surface: ComposerSurface;
  mode: ChatMode;
  groundSandbox: boolean;
}): ComposerModelRoute {
  if (args.surface === "repoless") {
    return { capability: "discuss", preferenceScope: "chat" };
  }
  if (args.mode === "library") {
    return { capability: "library", preferenceScope: "library" };
  }
  if (args.groundSandbox) {
    return { capability: "sandbox", preferenceScope: "sandbox" };
  }
  return { capability: "discuss", preferenceScope: "discuss" };
}

export function buildChatSendRequest(args: {
  selectedThreadId: ThreadId | null;
  repositoryId: RepositoryId | null;
  mode: ChatMode;
  content: string;
  groundLibrary?: boolean;
  groundSandbox?: boolean;
  provider?: LlmProvider | null;
  modelName?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  newThreadTitle?: string;
  newThreadArtifactContext?: ArtifactId[];
  newThreadSingleTurnEnabled?: boolean;
  newThreadAgentEnabled?: boolean;
  newThreadAgentRole?: string;
  newThreadAgentInstructions?: string;
}): ChatSendRequest | null {
  if (!args.content.trim()) {
    return null;
  }

  const groundingArgs =
    args.mode === "discuss"
      ? {
          groundLibrary: args.groundLibrary === true,
          groundSandbox: args.groundSandbox === true,
        }
      : {};
  const modelArgs =
    args.provider && args.modelName
      ? {
          provider: args.provider,
          modelName: args.modelName,
        }
      : {};
  const reasoningArgs =
    args.reasoningEffort !== null && args.reasoningEffort !== undefined
      ? { reasoningEffort: args.reasoningEffort }
      : {};

  if (args.selectedThreadId !== null) {
    return {
      kind: "existingThread",
      args: {
        threadId: args.selectedThreadId,
        content: args.content,
        mode: args.mode,
        ...groundingArgs,
        ...modelArgs,
        ...reasoningArgs,
      },
    };
  }

  const titleArgs = args.newThreadTitle !== undefined ? { title: args.newThreadTitle } : {};
  const artifactContextArgs =
    args.mode === "library" && args.newThreadArtifactContext && args.newThreadArtifactContext.length > 0
      ? { artifactContext: args.newThreadArtifactContext }
      : {};
  const repositoryArgs = args.repositoryId !== null ? { repositoryId: args.repositoryId } : {};
  const repolessAgentArgs =
    args.repositoryId === null
      ? {
          ...(args.newThreadSingleTurnEnabled !== undefined
            ? { singleTurnEnabled: args.newThreadSingleTurnEnabled }
            : {}),
          ...(args.newThreadAgentEnabled !== undefined ? { agentEnabled: args.newThreadAgentEnabled } : {}),
          ...(args.newThreadAgentRole !== undefined ? { agentRole: args.newThreadAgentRole } : {}),
          ...(args.newThreadAgentInstructions !== undefined
            ? { agentInstructions: args.newThreadAgentInstructions }
            : {}),
        }
      : {};

  return {
    kind: "newThread",
    args: {
      ...repositoryArgs,
      content: args.content,
      mode: args.mode,
      ...titleArgs,
      ...artifactContextArgs,
      ...repolessAgentArgs,
      ...groundingArgs,
      ...modelArgs,
      ...reasoningArgs,
    },
  };
}

export function resolveComposerAccess(args: {
  viewerAccess: ViewerAccess | undefined;
  mode: ChatMode;
  modelPick:
    | {
        provider: LlmProvider;
        modelName: string;
      }
    | null
    | undefined;
  reasoningEffort: ReasoningEffort | null | undefined;
  modelCatalogEntries: ReadonlyArray<PickableModelEntry> | undefined;
}): ComposerAccessResolution {
  const accessLoadingReason = args.viewerAccess === undefined ? ACCESS_LOADING_REASON : undefined;
  const premiumModelsDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(args.viewerAccess, "premiumModels") ? undefined : DEMO_MODE_COPY.premiumModelsDisabled);
  const highReasoningDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(args.viewerAccess, "highReasoning") ? undefined : DEMO_MODE_COPY.highReasoningDisabled);
  const chatSendDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(args.viewerAccess, args.mode === "library" ? "libraryAsk" : "chatSend")
      ? undefined
      : DEMO_MODE_COPY.lockedMessage);
  const sandboxGroundingDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(args.viewerAccess, "sandboxGrounding") ? undefined : DEMO_MODE_COPY.sandboxDisabled);

  let generateSystemDesignDisabledReason = accessLoadingReason;
  if (!generateSystemDesignDisabledReason) {
    if (!isViewerFeatureEnabled(args.viewerAccess, "generateSystemDesign")) {
      generateSystemDesignDisabledReason = DEMO_MODE_COPY.generateDisabled;
    } else if (!isViewerFeatureEnabled(args.viewerAccess, "sandboxGrounding")) {
      generateSystemDesignDisabledReason = DEMO_MODE_COPY.sandboxDisabled;
    }
  }

  const shouldCheckPremiumModel = premiumModelsDisabledReason !== undefined && args.modelPick != null;
  const modelAccessDisabledReason =
    getModelAccessDisabledReason({
      modelPick: args.modelPick,
      reasoningEffort: args.reasoningEffort,
      catalogEntries: args.modelCatalogEntries,
      premiumModelsDisabledReason,
      highReasoningDisabledReason,
      modelCatalogLoading: shouldCheckPremiumModel && args.modelCatalogEntries === undefined,
    }) ?? undefined;

  return {
    chatSendDisabledReason,
    sandboxGroundingDisabledReason,
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
    generateSystemDesignDisabledReason,
    modelAccessDisabledReason,
  };
}

export function resolveEffectiveGrounding(args: {
  groundingAvailability: ComposerGroundingAvailability | null | undefined;
  sandboxGroundingDisabledReason?: string;
}): ComposerGroundingAvailability {
  const base = args.groundingAvailability ?? {
    library: GROUNDING_LOADING_AXIS,
    sandbox: { ...GROUNDING_LOADING_AXIS, isActivatable: false },
  };
  if (!args.sandboxGroundingDisabledReason) {
    return base;
  }
  return {
    library: base.library,
    sandbox: {
      enabled: false,
      code: "feature_not_included",
      message: args.sandboxGroundingDisabledReason,
      isActivatable: false,
    },
  };
}
