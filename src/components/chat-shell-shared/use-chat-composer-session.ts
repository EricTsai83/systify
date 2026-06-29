import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { ThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useChatLifecycle } from "@/hooks/use-chat-lifecycle";
import { useComposerDraft } from "@/hooks/use-composer-draft";
import { useComposerModelPick } from "@/hooks/use-composer-model-pick";
import { useStorageGC } from "@/hooks/use-storage-gc";
import {
  buildChatSendRequest,
  createComposerSessionState,
  getComposerSessionSnapshot,
  reduceComposerSession,
  resolveComposerAccess,
  type ComposerGroundingAvailability,
  type ComposerSessionInputs,
} from "@/lib/chat-composer-session";
import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";
import type { ViewerAccess } from "@/hooks/use-viewer-access";
import type { ChatComposerViewModel } from "./chat-composer-types";

type RepolessDraftAgentProfile = {
  singleTurnEnabled: boolean;
  agentEnabled: boolean;
  agentRole: string;
  agentInstructions: string;
};

type BaseComposerSessionArgs = {
  threadId: ThreadId | null;
  capabilities: ThreadCapabilities;
  viewerAccess: ViewerAccess | undefined;
  isSyncing: boolean;
  isReadOnly: boolean;
  readOnlyHint?: string;
  setActionError: (value: string | null) => void;
  onAfterCreateThread: (threadId: ThreadId, mode: ChatMode) => void;
  extraControls?: ReactNode;
  extraControlsReady?: boolean;
  extraSendDisabledReason?: string;
};

type RepositoryComposerSessionArgs = BaseComposerSessionArgs & {
  surface: "repository";
  repositoryId: RepositoryId | null;
  mode: ChatMode;
  groundingAvailability: ComposerGroundingAvailability | null | undefined;
};

type RepolessComposerSessionArgs = BaseComposerSessionArgs & {
  surface: "repoless";
  repositoryId: null;
  mode: "discuss";
  draftAgentProfile?: RepolessDraftAgentProfile;
};

type UseChatComposerSessionArgs = RepositoryComposerSessionArgs | RepolessComposerSessionArgs;

const DEFAULT_PLACEHOLDER = "Ask about architecture, module boundaries, data flow, risks…";

export function useChatComposerSession(args: UseChatComposerSessionArgs): ChatComposerViewModel {
  useStorageGC();
  const { user, isLoading: isAuthLoading } = useAuth();
  const [lastSettledAuthId, setLastSettledAuthId] = useState<string | null>(user?.id ?? null);
  useEffect(() => {
    if (!isAuthLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastSettledAuthId(user?.id ?? null);
    }
  }, [isAuthLoading, user?.id]);

  const [inputValue, setInputValue, clearInput] = useComposerDraft({
    authUserId: isAuthLoading ? lastSettledAuthId : (user?.id ?? null),
    repositoryId: args.repositoryId,
    threadId: args.threadId,
    mode: args.mode,
  });

  const rawGroundingAvailability = args.surface === "repository" ? args.groundingAvailability : null;
  const accessResolved = args.viewerAccess !== undefined;
  const baseComposerSessionInputs = useMemo<ComposerSessionInputs>(
    () => ({
      threadId: args.threadId,
      repositoryId: args.repositoryId,
      surface: args.surface,
      mode: args.mode,
      capabilitiesLoading: args.capabilities.isLoading,
      defaultGroundLibrary: args.capabilities.defaultGroundLibrary,
      defaultGroundSandbox: args.capabilities.defaultGroundSandbox,
      groundingAvailability: rawGroundingAvailability,
      accessResolved: false,
    }),
    [
      args.capabilities.defaultGroundLibrary,
      args.capabilities.defaultGroundSandbox,
      args.capabilities.isLoading,
      args.mode,
      args.repositoryId,
      args.surface,
      args.threadId,
      rawGroundingAvailability,
    ],
  );
  const [composerSessionState, dispatchComposerSession] = useReducer(
    reduceComposerSession,
    baseComposerSessionInputs,
    createComposerSessionState,
  );
  const baseRenderComposerSessionState = useMemo(
    () => reduceComposerSession(composerSessionState, { type: "sync", inputs: baseComposerSessionInputs }),
    [baseComposerSessionInputs, composerSessionState],
  );
  const baseComposerSession = useMemo(
    () =>
      getComposerSessionSnapshot({
        state: baseRenderComposerSessionState,
        inputs: baseComposerSessionInputs,
      }),
    [baseComposerSessionInputs, baseRenderComposerSessionState],
  );
  const { route } = baseComposerSession;
  const setGroundLibrary = useCallback((next: boolean) => {
    dispatchComposerSession({ type: "setGroundLibrary", value: next });
  }, []);
  const setGroundSandbox = useCallback((next: boolean) => {
    dispatchComposerSession({ type: "setGroundSandbox", value: next });
  }, []);

  const {
    selectedProvider,
    selectedModelName,
    selectedModel,
    setSelectedModel,
    selectedReasoningEffort,
    setSelectedReasoningEffort,
  } = useComposerModelPick({
    threadId: args.threadId,
    capability: route.capability,
    preferenceScope: route.preferenceScope,
    threadLockedProvider: args.capabilities.lockedProvider,
    threadDefaultModelName: args.capabilities.defaultModelName,
  });

  const shouldRenderModelPicker = !args.isReadOnly;
  const shouldRenderReasoningPicker = !args.isReadOnly;
  const modelPickerCapability = route.preferenceScope === "sandbox" ? route.capability : undefined;
  const modelCatalogEntries = useQuery(
    api.llmCatalog.listPickableModels,
    shouldRenderModelPicker
      ? modelPickerCapability !== undefined
        ? { capability: modelPickerCapability, preferenceScope: route.preferenceScope }
        : { preferenceScope: route.preferenceScope }
      : "skip",
  );
  const reasoningCatalogEntries = useQuery(
    api.llmCatalog.listPickableModels,
    shouldRenderReasoningPicker ? { preferenceScope: route.preferenceScope } : "skip",
  );
  const access = resolveComposerAccess({
    viewerAccess: args.viewerAccess,
    mode: args.mode,
    modelPick: selectedModel,
    reasoningEffort: selectedReasoningEffort,
    modelCatalogEntries: reasoningCatalogEntries,
  });
  const composerSessionInputs = useMemo<ComposerSessionInputs>(
    () => ({
      ...baseComposerSessionInputs,
      accessResolved,
      sandboxGroundingDisabledReason: access.sandboxGroundingDisabledReason,
    }),
    [access.sandboxGroundingDisabledReason, accessResolved, baseComposerSessionInputs],
  );
  useEffect(() => {
    dispatchComposerSession({ type: "sync", inputs: composerSessionInputs });
  }, [composerSessionInputs]);

  const renderComposerSessionState = useMemo(
    () => reduceComposerSession(composerSessionState, { type: "sync", inputs: composerSessionInputs }),
    [composerSessionInputs, composerSessionState],
  );
  const composerSession = useMemo(
    () =>
      getComposerSessionSnapshot({
        state: renderComposerSessionState,
        inputs: composerSessionInputs,
      }),
    [composerSessionInputs, renderComposerSessionState],
  );

  const buildSendRequest = useCallback(
    (content: string) => {
      const draftAgentProfile =
        args.surface === "repoless" && args.threadId === null ? args.draftAgentProfile : undefined;
      return buildChatSendRequest({
        selectedThreadId: args.threadId,
        repositoryId: args.repositoryId,
        mode: args.mode,
        content,
        groundLibrary: composerSession.groundLibrary,
        groundSandbox: composerSession.groundSandbox,
        provider: selectedProvider,
        modelName: selectedModelName,
        reasoningEffort: selectedReasoningEffort,
        newThreadSingleTurnEnabled: draftAgentProfile?.singleTurnEnabled,
        newThreadAgentEnabled: draftAgentProfile?.agentEnabled,
        newThreadAgentRole: draftAgentProfile?.agentRole,
        newThreadAgentInstructions: draftAgentProfile?.agentInstructions,
      });
    },
    [
      args,
      composerSession.groundLibrary,
      composerSession.groundSandbox,
      selectedModelName,
      selectedProvider,
      selectedReasoningEffort,
    ],
  );

  const lifecycle = useChatLifecycle({
    selectedThreadId: args.threadId,
    buildSendRequest,
    clearChatInput: clearInput,
    setActionError: args.setActionError,
    onAfterCreateThread: args.onAfterCreateThread,
  });

  const toolsReady = args.extraControlsReady ?? true;

  const accessDisabledReason =
    args.extraSendDisabledReason ?? access.chatSendDisabledReason ?? access.modelAccessDisabledReason;
  const emptyDisabledReason = inputValue.trim() ? undefined : "Message requires text";
  const readOnlyDisabledReason = args.isReadOnly ? (args.readOnlyHint ?? "This thread is read-only.") : undefined;
  const disabledReason = emptyDisabledReason ?? accessDisabledReason ?? readOnlyDisabledReason;
  const isBlocked =
    args.isReadOnly ||
    inputValue.trim().length === 0 ||
    accessDisabledReason !== undefined ||
    lifecycle.isSending ||
    args.isSyncing;

  return {
    input: {
      value: inputValue,
      setValue: setInputValue,
      placeholder: args.isReadOnly ? (args.readOnlyHint ?? "This thread is read-only.") : DEFAULT_PLACEHOLDER,
      readOnly: args.isReadOnly,
      readOnlyHint: args.readOnlyHint,
    },
    tools: {
      ready: toolsReady,
      modelPicker: shouldRenderModelPicker
        ? {
            value: selectedModel,
            onChange: setSelectedModel,
            threadLockedProvider: args.capabilities.lockedProvider,
            capability: modelPickerCapability,
            preferenceScope: route.preferenceScope,
            getDisabledReason: (entry) =>
              access.premiumModelsDisabledReason && entry.capability === "sandbox"
                ? access.premiumModelsDisabledReason
                : null,
            catalogEntries: modelCatalogEntries,
          }
        : null,
      reasoningPicker: shouldRenderReasoningPicker
        ? {
            value: selectedReasoningEffort,
            onChange: setSelectedReasoningEffort,
            provider: selectedProvider ?? undefined,
            modelName: selectedModelName ?? undefined,
            preferenceScope: route.preferenceScope,
            disabledReasoningEfforts: access.highReasoningDisabledReason ? ["high", "xhigh"] : [],
            disabledReasoningEffortMessage: access.highReasoningDisabledReason,
            catalogEntries: reasoningCatalogEntries,
          }
        : null,
      grounding:
        args.surface === "repository" && args.mode === "discuss"
          ? {
              groundLibrary: composerSession.groundLibrary,
              groundSandbox: composerSession.groundSandbox,
              setGroundLibrary,
              setGroundSandbox,
              grounding: composerSession.effectiveGrounding,
            }
          : null,
      extraControls: args.extraControls,
    },
    send: {
      isSending: lifecycle.isSending,
      isBlocked,
      disabledReason,
      buttonState: args.isSyncing ? "Syncing…" : lifecycle.isSending ? "Sending…" : "Send",
      onSubmit: lifecycle.handleSendMessage,
    },
    cancel: {
      canCancel: args.threadId !== null,
      isCancelling: lifecycle.isCancellingReply,
      onCancel: args.threadId !== null ? lifecycle.handleCancelInFlightReply : undefined,
    },
  };
}
