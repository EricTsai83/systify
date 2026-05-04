/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analysis from "../analysis.js";
import type * as analysisNode from "../analysisNode.js";
import type * as architectureDiagram from "../architectureDiagram.js";
import type * as artifactStore from "../artifactStore.js";
import type * as artifacts from "../artifacts.js";
import type * as chat_context from "../chat/context.js";
import type * as chat_generation from "../chat/generation.js";
import type * as chat_prompting from "../chat/prompting.js";
import type * as chat_redaction from "../chat/redaction.js";
import type * as chat_relevance from "../chat/relevance.js";
import type * as chat_sandboxTools from "../chat/sandboxTools.js";
import type * as chat_send from "../chat/send.js";
import type * as chat_streamStore from "../chat/streamStore.js";
import type * as chat_streaming from "../chat/streaming.js";
import type * as chat_threads from "../chat/threads.js";
import type * as chatModeResolver from "../chatModeResolver.js";
import type * as crons from "../crons.js";
import type * as daytona from "../daytona.js";
import type * as daytonaWebhooks from "../daytonaWebhooks.js";
import type * as daytonaWebhooksNode from "../daytonaWebhooksNode.js";
import type * as designArtifacts from "../designArtifacts.js";
import type * as designArtifactsNode from "../designArtifactsNode.js";
import type * as github from "../github.js";
import type * as githubAppNode from "../githubAppNode.js";
import type * as githubCheck from "../githubCheck.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as importsNode from "../importsNode.js";
import type * as lib_architectureDiagram from "../lib/architectureDiagram.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_daytonaWebhookVerification from "../lib/daytonaWebhookVerification.js";
import type * as lib_github from "../lib/github.js";
import type * as lib_observability from "../lib/observability.js";
import type * as lib_openaiPricing from "../lib/openaiPricing.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_repoAnalysis from "../lib/repoAnalysis.js";
import type * as lib_returnTo from "../lib/returnTo.js";
import type * as lib_sandboxAvailability from "../lib/sandboxAvailability.js";
import type * as lib_sandboxFeatureFlag from "../lib/sandboxFeatureFlag.js";
import type * as lib_sandboxNames from "../lib/sandboxNames.js";
import type * as lib_userPreferences from "../lib/userPreferences.js";
import type * as lib_workspaces from "../lib/workspaces.js";
import type * as ops from "../ops.js";
import type * as opsNode from "../opsNode.js";
import type * as repositories from "../repositories.js";
import type * as threadContext from "../threadContext.js";
import type * as userPreferences from "../userPreferences.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analysis: typeof analysis;
  analysisNode: typeof analysisNode;
  architectureDiagram: typeof architectureDiagram;
  artifactStore: typeof artifactStore;
  artifacts: typeof artifacts;
  "chat/context": typeof chat_context;
  "chat/generation": typeof chat_generation;
  "chat/prompting": typeof chat_prompting;
  "chat/redaction": typeof chat_redaction;
  "chat/relevance": typeof chat_relevance;
  "chat/sandboxTools": typeof chat_sandboxTools;
  "chat/send": typeof chat_send;
  "chat/streamStore": typeof chat_streamStore;
  "chat/streaming": typeof chat_streaming;
  "chat/threads": typeof chat_threads;
  chatModeResolver: typeof chatModeResolver;
  crons: typeof crons;
  daytona: typeof daytona;
  daytonaWebhooks: typeof daytonaWebhooks;
  daytonaWebhooksNode: typeof daytonaWebhooksNode;
  designArtifacts: typeof designArtifacts;
  designArtifactsNode: typeof designArtifactsNode;
  github: typeof github;
  githubAppNode: typeof githubAppNode;
  githubCheck: typeof githubCheck;
  http: typeof http;
  imports: typeof imports;
  importsNode: typeof importsNode;
  "lib/architectureDiagram": typeof lib_architectureDiagram;
  "lib/auth": typeof lib_auth;
  "lib/constants": typeof lib_constants;
  "lib/daytonaWebhookVerification": typeof lib_daytonaWebhookVerification;
  "lib/github": typeof lib_github;
  "lib/observability": typeof lib_observability;
  "lib/openaiPricing": typeof lib_openaiPricing;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/repoAnalysis": typeof lib_repoAnalysis;
  "lib/returnTo": typeof lib_returnTo;
  "lib/sandboxAvailability": typeof lib_sandboxAvailability;
  "lib/sandboxFeatureFlag": typeof lib_sandboxFeatureFlag;
  "lib/sandboxNames": typeof lib_sandboxNames;
  "lib/userPreferences": typeof lib_userPreferences;
  "lib/workspaces": typeof lib_workspaces;
  ops: typeof ops;
  opsNode: typeof opsNode;
  repositories: typeof repositories;
  threadContext: typeof threadContext;
  userPreferences: typeof userPreferences;
  workspaces: typeof workspaces;
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
