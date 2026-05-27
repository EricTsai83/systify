/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as architectureDiagram from "../architectureDiagram.js";
import type * as artifactChunkStore from "../artifactChunkStore.js";
import type * as artifactFolders from "../artifactFolders.js";
import type * as artifactIndexing from "../artifactIndexing.js";
import type * as artifactStore from "../artifactStore.js";
import type * as artifactViews from "../artifactViews.js";
import type * as artifacts from "../artifacts.js";
import type * as chat_cancel from "../chat/cancel.js";
import type * as chat_citationLint from "../chat/citationLint.js";
import type * as chat_context from "../chat/context.js";
import type * as chat_generation from "../chat/generation.js";
import type * as chat_modelSelection from "../chat/modelSelection.js";
import type * as chat_prompting from "../chat/prompting.js";
import type * as chat_redaction from "../chat/redaction.js";
import type * as chat_relevance from "../chat/relevance.js";
import type * as chat_sandboxToolCallLog from "../chat/sandboxToolCallLog.js";
import type * as chat_sandboxTools from "../chat/sandboxTools.js";
import type * as chat_send from "../chat/send.js";
import type * as chat_streamStore from "../chat/streamStore.js";
import type * as chat_streaming from "../chat/streaming.js";
import type * as chat_threads from "../chat/threads.js";
import type * as chat_toolCallEventStore from "../chat/toolCallEventStore.js";
import type * as crons from "../crons.js";
import type * as daytona from "../daytona.js";
import type * as daytonaWebhooks from "../daytonaWebhooks.js";
import type * as daytonaWebhooksNode from "../daytonaWebhooksNode.js";
import type * as designArtifacts from "../designArtifacts.js";
import type * as designArtifactsNode from "../designArtifactsNode.js";
import type * as github from "../github.js";
import type * as githubAppNode from "../githubAppNode.js";
import type * as githubCheck from "../githubCheck.js";
import type * as githubRepoFetcher from "../githubRepoFetcher.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as importsNode from "../importsNode.js";
import type * as lib_architectureDiagram from "../lib/architectureDiagram.js";
import type * as lib_artifactChunking from "../lib/artifactChunking.js";
import type * as lib_artifactRag from "../lib/artifactRag.js";
import type * as lib_artifactView from "../lib/artifactView.js";
import type * as lib_artifactWrites from "../lib/artifactWrites.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_chatEligibility from "../lib/chatEligibility.js";
import type * as lib_chatMode from "../lib/chatMode.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_daytonaRetry from "../lib/daytonaRetry.js";
import type * as lib_daytonaWebhookVerification from "../lib/daytonaWebhookVerification.js";
import type * as lib_github from "../lib/github.js";
import type * as lib_jobs from "../lib/jobs.js";
import type * as lib_observability from "../lib/observability.js";
import type * as lib_openaiPricing from "../lib/openaiPricing.js";
import type * as lib_ownedDocs from "../lib/ownedDocs.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_repoAnalysis from "../lib/repoAnalysis.js";
import type * as lib_repositoryAccess from "../lib/repositoryAccess.js";
import type * as lib_repositoryPalette from "../lib/repositoryPalette.js";
import type * as lib_repositorySandbox from "../lib/repositorySandbox.js";
import type * as lib_returnTo from "../lib/returnTo.js";
import type * as lib_sandboxLiveness from "../lib/sandboxLiveness.js";
import type * as lib_sandboxNames from "../lib/sandboxNames.js";
import type * as lib_systemDesign from "../lib/systemDesign.js";
import type * as lib_userPreferences from "../lib/userPreferences.js";
import type * as ops from "../ops.js";
import type * as opsNode from "../opsNode.js";
import type * as repositories from "../repositories.js";
import type * as repositoryModeEligibility from "../repositoryModeEligibility.js";
import type * as repositoryPreferences from "../repositoryPreferences.js";
import type * as sandboxActivationNode from "../sandboxActivationNode.js";
import type * as sandboxSessions from "../sandboxSessions.js";
import type * as sandboxSessionsNode from "../sandboxSessionsNode.js";
import type * as systemDesign from "../systemDesign.js";
import type * as systemDesignNode from "../systemDesignNode.js";
import type * as threadContext from "../threadContext.js";
import type * as userPreferences from "../userPreferences.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  architectureDiagram: typeof architectureDiagram;
  artifactChunkStore: typeof artifactChunkStore;
  artifactFolders: typeof artifactFolders;
  artifactIndexing: typeof artifactIndexing;
  artifactStore: typeof artifactStore;
  artifactViews: typeof artifactViews;
  artifacts: typeof artifacts;
  "chat/cancel": typeof chat_cancel;
  "chat/citationLint": typeof chat_citationLint;
  "chat/context": typeof chat_context;
  "chat/generation": typeof chat_generation;
  "chat/modelSelection": typeof chat_modelSelection;
  "chat/prompting": typeof chat_prompting;
  "chat/redaction": typeof chat_redaction;
  "chat/relevance": typeof chat_relevance;
  "chat/sandboxToolCallLog": typeof chat_sandboxToolCallLog;
  "chat/sandboxTools": typeof chat_sandboxTools;
  "chat/send": typeof chat_send;
  "chat/streamStore": typeof chat_streamStore;
  "chat/streaming": typeof chat_streaming;
  "chat/threads": typeof chat_threads;
  "chat/toolCallEventStore": typeof chat_toolCallEventStore;
  crons: typeof crons;
  daytona: typeof daytona;
  daytonaWebhooks: typeof daytonaWebhooks;
  daytonaWebhooksNode: typeof daytonaWebhooksNode;
  designArtifacts: typeof designArtifacts;
  designArtifactsNode: typeof designArtifactsNode;
  github: typeof github;
  githubAppNode: typeof githubAppNode;
  githubCheck: typeof githubCheck;
  githubRepoFetcher: typeof githubRepoFetcher;
  http: typeof http;
  imports: typeof imports;
  importsNode: typeof importsNode;
  "lib/architectureDiagram": typeof lib_architectureDiagram;
  "lib/artifactChunking": typeof lib_artifactChunking;
  "lib/artifactRag": typeof lib_artifactRag;
  "lib/artifactView": typeof lib_artifactView;
  "lib/artifactWrites": typeof lib_artifactWrites;
  "lib/auth": typeof lib_auth;
  "lib/chatEligibility": typeof lib_chatEligibility;
  "lib/chatMode": typeof lib_chatMode;
  "lib/constants": typeof lib_constants;
  "lib/daytonaRetry": typeof lib_daytonaRetry;
  "lib/daytonaWebhookVerification": typeof lib_daytonaWebhookVerification;
  "lib/github": typeof lib_github;
  "lib/jobs": typeof lib_jobs;
  "lib/observability": typeof lib_observability;
  "lib/openaiPricing": typeof lib_openaiPricing;
  "lib/ownedDocs": typeof lib_ownedDocs;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/repoAnalysis": typeof lib_repoAnalysis;
  "lib/repositoryAccess": typeof lib_repositoryAccess;
  "lib/repositoryPalette": typeof lib_repositoryPalette;
  "lib/repositorySandbox": typeof lib_repositorySandbox;
  "lib/returnTo": typeof lib_returnTo;
  "lib/sandboxLiveness": typeof lib_sandboxLiveness;
  "lib/sandboxNames": typeof lib_sandboxNames;
  "lib/systemDesign": typeof lib_systemDesign;
  "lib/userPreferences": typeof lib_userPreferences;
  ops: typeof ops;
  opsNode: typeof opsNode;
  repositories: typeof repositories;
  repositoryModeEligibility: typeof repositoryModeEligibility;
  repositoryPreferences: typeof repositoryPreferences;
  sandboxActivationNode: typeof sandboxActivationNode;
  sandboxSessions: typeof sandboxSessions;
  sandboxSessionsNode: typeof sandboxSessionsNode;
  systemDesign: typeof systemDesign;
  systemDesignNode: typeof systemDesignNode;
  threadContext: typeof threadContext;
  userPreferences: typeof userPreferences;
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
