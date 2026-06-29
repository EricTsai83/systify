import type { RepositoryId } from "@/lib/types";

export type RepositorySelectionCommand =
  | { kind: "setCachedRepository"; repositoryId: RepositoryId | null }
  | { kind: "touchRepository"; repositoryId: RepositoryId }
  | { kind: "navigateDefault"; replace: true };

export interface RepositorySelectionInput {
  urlRepositoryId: RepositoryId | null;
  cachedRepositoryId: RepositoryId | null;
  preferenceRepositoryId: RepositoryId | null;
  switcherRepositoryIds: readonly RepositoryId[];
  ownerRepositoryIds: ReadonlySet<RepositoryId>;
}

export function resolveRepositorySelection(input: RepositorySelectionInput): {
  cachedRepositoryId: RepositoryId | null;
  currentRepositoryId: RepositoryId | null;
  commands: RepositorySelectionCommand[];
} {
  const commands: RepositorySelectionCommand[] = [];
  const isLive = (repositoryId: RepositoryId | null): repositoryId is RepositoryId =>
    repositoryId !== null && input.ownerRepositoryIds.has(repositoryId);

  if (input.urlRepositoryId !== null) {
    if (!isLive(input.urlRepositoryId)) {
      commands.push({ kind: "navigateDefault", replace: true });
      if (!isLive(input.cachedRepositoryId)) {
        commands.push({ kind: "setCachedRepository", repositoryId: null });
      }
      return {
        cachedRepositoryId: isLive(input.cachedRepositoryId) ? input.cachedRepositoryId : null,
        currentRepositoryId: null,
        commands,
      };
    }

    if (input.cachedRepositoryId !== input.urlRepositoryId) {
      commands.push({ kind: "setCachedRepository", repositoryId: input.urlRepositoryId });
    }
    if (input.preferenceRepositoryId !== input.urlRepositoryId) {
      commands.push({ kind: "touchRepository", repositoryId: input.urlRepositoryId });
    }
    return {
      cachedRepositoryId: input.urlRepositoryId,
      currentRepositoryId: input.urlRepositoryId,
      commands,
    };
  }

  if (isLive(input.preferenceRepositoryId)) {
    if (input.cachedRepositoryId !== input.preferenceRepositoryId) {
      commands.push({ kind: "setCachedRepository", repositoryId: input.preferenceRepositoryId });
    }
    return {
      cachedRepositoryId: input.preferenceRepositoryId,
      currentRepositoryId: input.preferenceRepositoryId,
      commands,
    };
  }

  if (isLive(input.cachedRepositoryId)) {
    return {
      cachedRepositoryId: input.cachedRepositoryId,
      currentRepositoryId: input.cachedRepositoryId,
      commands,
    };
  }

  const fallbackRepositoryId = input.switcherRepositoryIds.find((repositoryId) => isLive(repositoryId)) ?? null;
  if (fallbackRepositoryId) {
    commands.push({ kind: "setCachedRepository", repositoryId: fallbackRepositoryId });
    if (input.preferenceRepositoryId !== fallbackRepositoryId) {
      commands.push({ kind: "touchRepository", repositoryId: fallbackRepositoryId });
    }
    return {
      cachedRepositoryId: fallbackRepositoryId,
      currentRepositoryId: fallbackRepositoryId,
      commands,
    };
  }

  if (input.cachedRepositoryId !== null) {
    commands.push({ kind: "setCachedRepository", repositoryId: null });
  }
  return {
    cachedRepositoryId: null,
    currentRepositoryId: null,
    commands,
  };
}
