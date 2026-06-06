import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";
import { discussPath, libraryPath, withLibraryAskParam } from "@/route-paths";

export interface RepositoryLandingAvailability {
  modes: { discuss: { enabled: boolean }; library: { enabled: boolean } };
  defaultMode: ChatMode;
}

export interface RepositoryLandingThreadSummary {
  _id: ThreadId;
}

export type RepositoryLandingDecision =
  | {
      status: "ready";
      intendedChatMode: ChatMode;
      navigation: null;
    }
  | {
      status: "loading";
      intendedChatMode: ChatMode;
      navigation: null;
    }
  | {
      status: "redirecting";
      intendedChatMode: ChatMode;
      navigation: { to: string; replace: true };
    };

/**
 * Pick the mode for repository landing URLs that do not pin one:
 * URL mode -> repository last mode when still enabled -> backend default.
 */
export function resolveRepositoryLandingMode(args: {
  mode: ChatMode | null;
  lastMode: ChatMode | null | undefined;
  availability: RepositoryLandingAvailability | null | undefined;
}): ChatMode {
  const { mode, lastMode, availability } = args;
  if (mode) return mode;
  const lastModeEnabled = lastMode ? (availability?.modes[lastMode].enabled ?? false) : false;
  if (lastModeEnabled && lastMode) return lastMode;
  return availability?.defaultMode ?? "discuss";
}

export function resolveRepositoryLandingDecision(args: {
  urlRepositoryId: RepositoryId | null;
  urlThreadId: ThreadId | null;
  intendedChatMode: ChatMode;
  mode: ChatMode | null;
  availability: RepositoryLandingAvailability | null | undefined;
  repositoriesLoaded: boolean;
  ownerThreads: readonly RepositoryLandingThreadSummary[] | undefined;
}): RepositoryLandingDecision {
  if (args.urlRepositoryId === null || args.urlThreadId !== null) {
    return { status: "ready", intendedChatMode: args.intendedChatMode, navigation: null };
  }

  if (args.availability === undefined || !args.repositoriesLoaded || args.ownerThreads === undefined) {
    return { status: "loading", intendedChatMode: args.intendedChatMode, navigation: null };
  }

  if (args.intendedChatMode === "library") {
    const askThreadId = args.ownerThreads[0]?._id ?? null;
    return {
      status: "redirecting",
      intendedChatMode: args.intendedChatMode,
      navigation: {
        to: withLibraryAskParam(libraryPath(args.urlRepositoryId), askThreadId),
        replace: true,
      },
    };
  }

  const discussThreadId = args.ownerThreads[0]?._id;
  if (discussThreadId) {
    return {
      status: "redirecting",
      intendedChatMode: args.intendedChatMode,
      navigation: { to: discussPath(args.urlRepositoryId, discussThreadId), replace: true },
    };
  }

  if (args.mode === null) {
    return {
      status: "redirecting",
      intendedChatMode: args.intendedChatMode,
      navigation: { to: discussPath(args.urlRepositoryId), replace: true },
    };
  }

  return { status: "ready", intendedChatMode: args.intendedChatMode, navigation: null };
}
