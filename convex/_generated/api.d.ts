/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as artifactChunkStore from "../artifactChunkStore.js";
import type * as artifactFolders from "../artifactFolders.js";
import type * as artifactIndexing from "../artifactIndexing.js";
import type * as artifactMermaidRepair from "../artifactMermaidRepair.js";
import type * as artifactMermaidRepairNode from "../artifactMermaidRepairNode.js";
import type * as artifactStore from "../artifactStore.js";
import type * as artifactViews from "../artifactViews.js";
import type * as artifacts from "../artifacts.js";
import type * as chat_archiveState from "../chat/archiveState.js";
import type * as chat_cancel from "../chat/cancel.js";
import type * as chat_chatTurnIntake from "../chat/chatTurnIntake.js";
import type * as chat_citationLint from "../chat/citationLint.js";
import type * as chat_context from "../chat/context.js";
import type * as chat_generation from "../chat/generation.js";
import type * as chat_history from "../chat/history.js";
import type * as chat_historyState from "../chat/historyState.js";
import type * as chat_modelSelection from "../chat/modelSelection.js";
import type * as chat_prompting from "../chat/prompting.js";
import type * as chat_redaction from "../chat/redaction.js";
import type * as chat_relevance from "../chat/relevance.js";
import type * as chat_replySession from "../chat/replySession.js";
import type * as chat_replyStreamController from "../chat/replyStreamController.js";
import type * as chat_sandboxToolCallLog from "../chat/sandboxToolCallLog.js";
import type * as chat_sandboxTools from "../chat/sandboxTools.js";
import type * as chat_send from "../chat/send.js";
import type * as chat_sendPlanning from "../chat/sendPlanning.js";
import type * as chat_streamStore from "../chat/streamStore.js";
import type * as chat_streaming from "../chat/streaming.js";
import type * as chat_threadAccess from "../chat/threadAccess.js";
import type * as chat_threadShares from "../chat/threadShares.js";
import type * as chat_threads from "../chat/threads.js";
import type * as chat_titles from "../chat/titles.js";
import type * as chat_titlesNode from "../chat/titlesNode.js";
import type * as chat_toolCallEventStore from "../chat/toolCallEventStore.js";
import type * as crons from "../crons.js";
import type * as daytona from "../daytona.js";
import type * as daytonaWebhooks from "../daytonaWebhooks.js";
import type * as daytonaWebhooksNode from "../daytonaWebhooksNode.js";
import type * as eval_systemDesign_aggregate from "../eval/systemDesign/aggregate.js";
import type * as eval_systemDesign_corpus from "../eval/systemDesign/corpus.js";
import type * as eval_systemDesign_judge from "../eval/systemDesign/judge.js";
import type * as eval_systemDesign_report from "../eval/systemDesign/report.js";
import type * as eval_systemDesign_runner from "../eval/systemDesign/runner.js";
import type * as github from "../github.js";
import type * as githubAppNode from "../githubAppNode.js";
import type * as githubCheck from "../githubCheck.js";
import type * as githubRepoFetcher from "../githubRepoFetcher.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as importsNode from "../importsNode.js";
import type * as lib_artifactChunking from "../lib/artifactChunking.js";
import type * as lib_artifactDefaults from "../lib/artifactDefaults.js";
import type * as lib_artifactFolderDefaults from "../lib/artifactFolderDefaults.js";
import type * as lib_artifactRag from "../lib/artifactRag.js";
import type * as lib_artifactView from "../lib/artifactView.js";
import type * as lib_artifactWrites from "../lib/artifactWrites.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_chatEligibility from "../lib/chatEligibility.js";
import type * as lib_chatMode from "../lib/chatMode.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_daytonaRetry from "../lib/daytonaRetry.js";
import type * as lib_daytonaWebhookVerification from "../lib/daytonaWebhookVerification.js";
import type * as lib_embeddingAccounting from "../lib/embeddingAccounting.js";
import type * as lib_embeddingAccountingMutations from "../lib/embeddingAccountingMutations.js";
import type * as lib_entitlements from "../lib/entitlements.js";
import type * as lib_functionResultSchemas from "../lib/functionResultSchemas.js";
import type * as lib_github from "../lib/github.js";
import type * as lib_githubAppAuthNode from "../lib/githubAppAuthNode.js";
import type * as lib_importLifecycle from "../lib/importLifecycle.js";
import type * as lib_importPipeline from "../lib/importPipeline.js";
import type * as lib_importSnapshotPersistence from "../lib/importSnapshotPersistence.js";
import type * as lib_jobs from "../lib/jobs.js";
import type * as lib_liveSourceLifecycle from "../lib/liveSourceLifecycle.js";
import type * as lib_llmCatalog from "../lib/llmCatalog.js";
import type * as lib_llmGateway from "../lib/llmGateway.js";
import type * as lib_llmPricing from "../lib/llmPricing.js";
import type * as lib_llmProvider from "../lib/llmProvider.js";
import type * as lib_mermaidMarkdown from "../lib/mermaidMarkdown.js";
import type * as lib_modeAvailability from "../lib/modeAvailability.js";
import type * as lib_observability from "../lib/observability.js";
import type * as lib_ownedDocs from "../lib/ownedDocs.js";
import type * as lib_providerEnv from "../lib/providerEnv.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_repoAnalysis from "../lib/repoAnalysis.js";
import type * as lib_repolessThreadKind from "../lib/repolessThreadKind.js";
import type * as lib_repositoryAccess from "../lib/repositoryAccess.js";
import type * as lib_repositoryCascade from "../lib/repositoryCascade.js";
import type * as lib_repositoryImportWorkflow from "../lib/repositoryImportWorkflow.js";
import type * as lib_repositoryOwnedDataAdapters from "../lib/repositoryOwnedDataAdapters.js";
import type * as lib_repositoryOwnedDataLifecycle from "../lib/repositoryOwnedDataLifecycle.js";
import type * as lib_repositoryPalette from "../lib/repositoryPalette.js";
import type * as lib_repositoryRetirement from "../lib/repositoryRetirement.js";
import type * as lib_repositorySandbox from "../lib/repositorySandbox.js";
import type * as lib_returnTo from "../lib/returnTo.js";
import type * as lib_sandboxLibraryGeneration from "../lib/sandboxLibraryGeneration.js";
import type * as lib_sandboxLibraryGenerationAccounting from "../lib/sandboxLibraryGenerationAccounting.js";
import type * as lib_sandboxLiveness from "../lib/sandboxLiveness.js";
import type * as lib_sandboxNames from "../lib/sandboxNames.js";
import type * as lib_systemDesign from "../lib/systemDesign.js";
import type * as lib_systemDesignFailureClassification from "../lib/systemDesignFailureClassification.js";
import type * as lib_systemDesignFailures from "../lib/systemDesignFailures.js";
import type * as lib_systemDesignPlanning from "../lib/systemDesignPlanning.js";
import type * as lib_systemDesignPrompts from "../lib/systemDesignPrompts.js";
import type * as lib_threadDefaults from "../lib/threadDefaults.js";
import type * as lib_titleSanitization from "../lib/titleSanitization.js";
import type * as lib_userCost from "../lib/userCost.js";
import type * as lib_userPreferences from "../lib/userPreferences.js";
import type * as lib_withLlmRetry from "../lib/withLlmRetry.js";
import type * as libraryArtifactDrafts from "../libraryArtifactDrafts.js";
import type * as libraryArtifactDraftsNode from "../libraryArtifactDraftsNode.js";
import type * as llmCatalog from "../llmCatalog.js";
import type * as ops from "../ops.js";
import type * as opsNode from "../opsNode.js";
import type * as repositories from "../repositories.js";
import type * as repositoryModeEligibility from "../repositoryModeEligibility.js";
import type * as repositoryPreferences from "../repositoryPreferences.js";
import type * as sandboxActivationNode from "../sandboxActivationNode.js";
import type * as sandboxProvisioning from "../sandboxProvisioning.js";
import type * as sandboxSessions from "../sandboxSessions.js";
import type * as sandboxSessionsNode from "../sandboxSessionsNode.js";
import type * as systemDesign from "../systemDesign.js";
import type * as systemDesignKindRun from "../systemDesignKindRun.js";
import type * as systemDesignNode from "../systemDesignNode.js";
import type * as threadContext from "../threadContext.js";
import type * as userPreferences from "../userPreferences.js";
import type * as viewerAccess from "../viewerAccess.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  artifactChunkStore: typeof artifactChunkStore;
  artifactFolders: typeof artifactFolders;
  artifactIndexing: typeof artifactIndexing;
  artifactMermaidRepair: typeof artifactMermaidRepair;
  artifactMermaidRepairNode: typeof artifactMermaidRepairNode;
  artifactStore: typeof artifactStore;
  artifactViews: typeof artifactViews;
  artifacts: typeof artifacts;
  "chat/archiveState": typeof chat_archiveState;
  "chat/cancel": typeof chat_cancel;
  "chat/chatTurnIntake": typeof chat_chatTurnIntake;
  "chat/citationLint": typeof chat_citationLint;
  "chat/context": typeof chat_context;
  "chat/generation": typeof chat_generation;
  "chat/history": typeof chat_history;
  "chat/historyState": typeof chat_historyState;
  "chat/modelSelection": typeof chat_modelSelection;
  "chat/prompting": typeof chat_prompting;
  "chat/redaction": typeof chat_redaction;
  "chat/relevance": typeof chat_relevance;
  "chat/replySession": typeof chat_replySession;
  "chat/replyStreamController": typeof chat_replyStreamController;
  "chat/sandboxToolCallLog": typeof chat_sandboxToolCallLog;
  "chat/sandboxTools": typeof chat_sandboxTools;
  "chat/send": typeof chat_send;
  "chat/sendPlanning": typeof chat_sendPlanning;
  "chat/streamStore": typeof chat_streamStore;
  "chat/streaming": typeof chat_streaming;
  "chat/threadAccess": typeof chat_threadAccess;
  "chat/threadShares": typeof chat_threadShares;
  "chat/threads": typeof chat_threads;
  "chat/titles": typeof chat_titles;
  "chat/titlesNode": typeof chat_titlesNode;
  "chat/toolCallEventStore": typeof chat_toolCallEventStore;
  crons: typeof crons;
  daytona: typeof daytona;
  daytonaWebhooks: typeof daytonaWebhooks;
  daytonaWebhooksNode: typeof daytonaWebhooksNode;
  "eval/systemDesign/aggregate": typeof eval_systemDesign_aggregate;
  "eval/systemDesign/corpus": typeof eval_systemDesign_corpus;
  "eval/systemDesign/judge": typeof eval_systemDesign_judge;
  "eval/systemDesign/report": typeof eval_systemDesign_report;
  "eval/systemDesign/runner": typeof eval_systemDesign_runner;
  github: typeof github;
  githubAppNode: typeof githubAppNode;
  githubCheck: typeof githubCheck;
  githubRepoFetcher: typeof githubRepoFetcher;
  http: typeof http;
  imports: typeof imports;
  importsNode: typeof importsNode;
  "lib/artifactChunking": typeof lib_artifactChunking;
  "lib/artifactDefaults": typeof lib_artifactDefaults;
  "lib/artifactFolderDefaults": typeof lib_artifactFolderDefaults;
  "lib/artifactRag": typeof lib_artifactRag;
  "lib/artifactView": typeof lib_artifactView;
  "lib/artifactWrites": typeof lib_artifactWrites;
  "lib/auth": typeof lib_auth;
  "lib/chatEligibility": typeof lib_chatEligibility;
  "lib/chatMode": typeof lib_chatMode;
  "lib/constants": typeof lib_constants;
  "lib/daytonaRetry": typeof lib_daytonaRetry;
  "lib/daytonaWebhookVerification": typeof lib_daytonaWebhookVerification;
  "lib/embeddingAccounting": typeof lib_embeddingAccounting;
  "lib/embeddingAccountingMutations": typeof lib_embeddingAccountingMutations;
  "lib/entitlements": typeof lib_entitlements;
  "lib/functionResultSchemas": typeof lib_functionResultSchemas;
  "lib/github": typeof lib_github;
  "lib/githubAppAuthNode": typeof lib_githubAppAuthNode;
  "lib/importLifecycle": typeof lib_importLifecycle;
  "lib/importPipeline": typeof lib_importPipeline;
  "lib/importSnapshotPersistence": typeof lib_importSnapshotPersistence;
  "lib/jobs": typeof lib_jobs;
  "lib/liveSourceLifecycle": typeof lib_liveSourceLifecycle;
  "lib/llmCatalog": typeof lib_llmCatalog;
  "lib/llmGateway": typeof lib_llmGateway;
  "lib/llmPricing": typeof lib_llmPricing;
  "lib/llmProvider": typeof lib_llmProvider;
  "lib/mermaidMarkdown": typeof lib_mermaidMarkdown;
  "lib/modeAvailability": typeof lib_modeAvailability;
  "lib/observability": typeof lib_observability;
  "lib/ownedDocs": typeof lib_ownedDocs;
  "lib/providerEnv": typeof lib_providerEnv;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/repoAnalysis": typeof lib_repoAnalysis;
  "lib/repolessThreadKind": typeof lib_repolessThreadKind;
  "lib/repositoryAccess": typeof lib_repositoryAccess;
  "lib/repositoryCascade": typeof lib_repositoryCascade;
  "lib/repositoryImportWorkflow": typeof lib_repositoryImportWorkflow;
  "lib/repositoryOwnedDataAdapters": typeof lib_repositoryOwnedDataAdapters;
  "lib/repositoryOwnedDataLifecycle": typeof lib_repositoryOwnedDataLifecycle;
  "lib/repositoryPalette": typeof lib_repositoryPalette;
  "lib/repositoryRetirement": typeof lib_repositoryRetirement;
  "lib/repositorySandbox": typeof lib_repositorySandbox;
  "lib/returnTo": typeof lib_returnTo;
  "lib/sandboxLibraryGeneration": typeof lib_sandboxLibraryGeneration;
  "lib/sandboxLibraryGenerationAccounting": typeof lib_sandboxLibraryGenerationAccounting;
  "lib/sandboxLiveness": typeof lib_sandboxLiveness;
  "lib/sandboxNames": typeof lib_sandboxNames;
  "lib/systemDesign": typeof lib_systemDesign;
  "lib/systemDesignFailureClassification": typeof lib_systemDesignFailureClassification;
  "lib/systemDesignFailures": typeof lib_systemDesignFailures;
  "lib/systemDesignPlanning": typeof lib_systemDesignPlanning;
  "lib/systemDesignPrompts": typeof lib_systemDesignPrompts;
  "lib/threadDefaults": typeof lib_threadDefaults;
  "lib/titleSanitization": typeof lib_titleSanitization;
  "lib/userCost": typeof lib_userCost;
  "lib/userPreferences": typeof lib_userPreferences;
  "lib/withLlmRetry": typeof lib_withLlmRetry;
  libraryArtifactDrafts: typeof libraryArtifactDrafts;
  libraryArtifactDraftsNode: typeof libraryArtifactDraftsNode;
  llmCatalog: typeof llmCatalog;
  ops: typeof ops;
  opsNode: typeof opsNode;
  repositories: typeof repositories;
  repositoryModeEligibility: typeof repositoryModeEligibility;
  repositoryPreferences: typeof repositoryPreferences;
  sandboxActivationNode: typeof sandboxActivationNode;
  sandboxProvisioning: typeof sandboxProvisioning;
  sandboxSessions: typeof sandboxSessions;
  sandboxSessionsNode: typeof sandboxSessionsNode;
  systemDesign: typeof systemDesign;
  systemDesignKindRun: typeof systemDesignKindRun;
  systemDesignNode: typeof systemDesignNode;
  threadContext: typeof threadContext;
  userPreferences: typeof userPreferences;
  viewerAccess: typeof viewerAccess;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
