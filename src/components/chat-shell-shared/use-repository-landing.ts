import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import {
  resolveRepositoryLandingDecision,
  resolveRepositoryLandingMode,
  type RepositoryLandingAvailability,
  type RepositoryLandingDecision,
} from "@/lib/repository-landing";
import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";

export function useRepositoryLandingDecision({
  urlRepositoryId,
  urlThreadId,
  currentRepositoryId,
  currentRepository,
  mode,
  availability,
  repositories,
  suppressThreadAutoOpen,
}: {
  urlRepositoryId: RepositoryId | null;
  urlThreadId: ThreadId | null;
  currentRepositoryId: RepositoryId | null;
  currentRepository: Doc<"repositories"> | null;
  mode: ChatMode | null;
  availability: RepositoryLandingAvailability | null | undefined;
  repositories: Doc<"repositories">[] | undefined;
  suppressThreadAutoOpen?: boolean;
}): RepositoryLandingDecision {
  const lastMode = currentRepository?.lastMode ?? null;
  const intendedChatMode = useMemo(
    () => resolveRepositoryLandingMode({ mode, lastMode, availability }),
    [availability, lastMode, mode],
  );

  const ownerThreads = useQuery(
    api.chat.threads.listThreads,
    urlThreadId === null && currentRepositoryId !== null && !suppressThreadAutoOpen
      ? { repositoryId: currentRepositoryId, mode: intendedChatMode }
      : "skip",
  );

  return useMemo(
    () =>
      resolveRepositoryLandingDecision({
        urlRepositoryId,
        urlThreadId,
        intendedChatMode,
        mode,
        availability,
        repositoriesLoaded: repositories !== undefined,
        ownerThreads,
        suppressThreadAutoOpen,
      }),
    [
      availability,
      intendedChatMode,
      mode,
      ownerThreads,
      repositories,
      suppressThreadAutoOpen,
      urlRepositoryId,
      urlThreadId,
    ],
  );
}
