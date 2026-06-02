import type { RepositoryId } from "@/lib/types";

export type RepositorySelectionCommand =
  | { kind: "setActiveRepository"; repositoryId: RepositoryId | null }
  | { kind: "touchRepository"; repositoryId: RepositoryId }
  | { kind: "navigateDefault"; replace: true };

export interface RepositorySelectionInput {
  urlRepositoryId: RepositoryId | null;
  activeRepositoryId: RepositoryId | null;
  dbRepositoryId: RepositoryId | null;
  switcherRepositoryIds: readonly RepositoryId[];
  ownerRepositoryIds: ReadonlySet<RepositoryId>;
}

export function resolveRepositorySelection(input: RepositorySelectionInput): {
  activeRepositoryId: RepositoryId | null;
  currentRepositoryId: RepositoryId | null;
  commands: RepositorySelectionCommand[];
} {
  const commands: RepositorySelectionCommand[] = [];
  const isLive = (repositoryId: RepositoryId | null): repositoryId is RepositoryId =>
    repositoryId !== null && input.ownerRepositoryIds.has(repositoryId);

  if (input.urlRepositoryId !== null) {
    if (!isLive(input.urlRepositoryId)) {
      commands.push({ kind: "navigateDefault", replace: true });
      if (!isLive(input.activeRepositoryId)) {
        commands.push({ kind: "setActiveRepository", repositoryId: null });
      }
      return {
        activeRepositoryId: isLive(input.activeRepositoryId) ? input.activeRepositoryId : null,
        currentRepositoryId: null,
        commands,
      };
    }

    if (input.activeRepositoryId !== input.urlRepositoryId) {
      commands.push({ kind: "setActiveRepository", repositoryId: input.urlRepositoryId });
    }
    if (input.dbRepositoryId !== input.urlRepositoryId) {
      commands.push({ kind: "touchRepository", repositoryId: input.urlRepositoryId });
    }
    return {
      activeRepositoryId: input.urlRepositoryId,
      currentRepositoryId: input.urlRepositoryId,
      commands,
    };
  }

  if (isLive(input.dbRepositoryId)) {
    if (input.activeRepositoryId !== input.dbRepositoryId) {
      commands.push({ kind: "setActiveRepository", repositoryId: input.dbRepositoryId });
    }
    return {
      activeRepositoryId: input.dbRepositoryId,
      currentRepositoryId: input.dbRepositoryId,
      commands,
    };
  }

  if (isLive(input.activeRepositoryId)) {
    return {
      activeRepositoryId: input.activeRepositoryId,
      currentRepositoryId: input.activeRepositoryId,
      commands,
    };
  }

  const fallbackRepositoryId = input.switcherRepositoryIds.find((repositoryId) => isLive(repositoryId)) ?? null;
  if (fallbackRepositoryId) {
    commands.push({ kind: "setActiveRepository", repositoryId: fallbackRepositoryId });
    if (input.dbRepositoryId !== fallbackRepositoryId) {
      commands.push({ kind: "touchRepository", repositoryId: fallbackRepositoryId });
    }
    return {
      activeRepositoryId: fallbackRepositoryId,
      currentRepositoryId: fallbackRepositoryId,
      commands,
    };
  }

  if (input.activeRepositoryId !== null) {
    commands.push({ kind: "setActiveRepository", repositoryId: null });
  }
  return {
    activeRepositoryId: null,
    currentRepositoryId: null,
    commands,
  };
}
