import { matchRoutes, type RouteObject } from "react-router-dom";
import type { ArtifactId, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";

/**
 * Re-export {@link ThreadMode} from `lib/types` so existing callers that
 * imported it from `route-paths` keep working. The canonical declaration
 * lives next to the other domain id types in `lib/types`.
 */
export type { ThreadMode };

export const LANDING_PATH = "/";
export const AUTH_CALLBACK_ROUTE_SEGMENT = "callback";
export const AUTH_CALLBACK_PATH = `/${AUTH_CALLBACK_ROUTE_SEGMENT}` as const;

/**
 * Authenticated route segments.
 *
 *   /chat                              — repoless landing (composer +
 *                                        recent repoless threads).
 *   /chat/:threadId                    — specific repoless thread
 *                                        (structurally Discuss-only).
 *   /r/:repositoryId                   — repository landing, redirects
 *                                        into that repository's most recent
 *                                        thread (or empty state).
 *   /archive                           — archived repos listing.
 *
 * Every repository is its own top-level scope. Threads without a
 * repository are repoless and surface under `/chat/:threadId`.
 */
export const PROTECTED_ROUTE_SEGMENTS = {
  chat: "chat",
  /**
   * Repoless thread URL. Structurally Discuss-only (Library requires an
   * attached repository), so the URL deliberately has no mode segment.
   */
  repolessChat: "chat/:threadId",
  repository: "r/:repositoryId",
  archive: "archive",
  resources: "resources",
  settings: "settings",
  settingsSection: "settings/:section",
  /**
   * Top-level service modes:
   *
   *   - `discuss/:threadId?` — free-form chat with per-message grounding
   *     toggles (Library / Sandbox) the composer surfaces above the input.
   *   - `library` / `library/a/:artifactId` — read-mostly artifact reader.
   *     The artifact owns the path; the active Library Ask thread travels
   *     as a `?ask=:threadId` query param.
   */
  repositoryDiscuss: "r/:repositoryId/discuss",
  repositoryDiscussThread: "r/:repositoryId/discuss/:threadId",
  repositoryLibrary: "r/:repositoryId/library",
  repositoryLibraryArtifact: "r/:repositoryId/library/a/:artifactId",
} as const;

export const ARCHIVE_PATH = `/${PROTECTED_ROUTE_SEGMENTS.archive}` as const;

export const RESOURCES_PATH = `/${PROTECTED_ROUTE_SEGMENTS.resources}` as const;

export const SETTINGS_PATH = `/${PROTECTED_ROUTE_SEGMENTS.settings}` as const;

export const SETTINGS_SECTION_IDS = [
  "account",
  "customization",
  "history",
  "resources",
  "models",
  "api-keys",
  "attachments",
  "shortcuts",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "customization";

export function settingsPath(section: SettingsSectionId = DEFAULT_SETTINGS_SECTION, from?: string | null): string {
  const path = `${SETTINGS_PATH}/${section}`;
  if (!from) {
    return path;
  }
  const params = new URLSearchParams({ from });
  return `${path}?${params.toString()}`;
}

export const DEFAULT_AUTHENTICATED_PATH = `/${PROTECTED_ROUTE_SEGMENTS.chat}` as const;

/**
 * Build a `/r/:repositoryId` URL. Centralised so the URL shape lives in
 * exactly one place — every callsite goes through these helpers, so
 * changing the pattern (or adding a query param, prefix, etc.) is a
 * one-file edit.
 */
export function repositoryPath(repositoryId: RepositoryId): string {
  return `/r/${repositoryId}`;
}

/**
 * Build a `/chat/:threadId` URL for a repoless thread. The repoless
 * shell is structurally Discuss-only — Library requires a repo binding —
 * so the URL has no mode segment.
 */
export function repolessThreadPath(threadId: ThreadId): string {
  return `/chat/${threadId}`;
}

/**
 * Build the canonical mode-aware URL for a thread given its stored mode.
 *
 * Maps:
 *   - `discuss` → `/r/:rid/discuss/:tid`
 *   - `library` → `/r/:rid/library?ask=:tid`
 */
export function modeAwareThreadPath(repositoryId: RepositoryId, threadId: ThreadId, mode: ThreadMode): string {
  switch (mode) {
    case "discuss":
      return discussPath(repositoryId, threadId);
    case "library":
      return withLibraryAskParam(libraryPath(repositoryId), threadId);
  }
}

/**
 * Discuss service mode URL builders. With a thread id, the URL is the
 * canonical "render this thread inside Discuss service mode"; without one,
 * the repository shell either finds the most recent discuss thread or
 * shows the no-repo empty state.
 */
export function discussPath(repositoryId: RepositoryId, threadId?: ThreadId): string {
  return threadId ? `/r/${repositoryId}/discuss/${threadId}` : `/r/${repositoryId}/discuss`;
}

/**
 * Library mode landing. With an artifact id, opens the IDE-style reader
 * directly on that artifact; without one, the shell shows the folder
 * overview. The `open` option is the multi-tab list to restore
 * (round-tripped through `?open=id1,id2`); empty / undefined means
 * "open just the active tab". An `?ask=:threadId` query param may also
 * be present — that one is owned by the page, not these builders.
 */
export function libraryPath(repositoryId: RepositoryId): string {
  return `/r/${repositoryId}/library`;
}

export function libraryArtifactPath(
  repositoryId: RepositoryId,
  artifactId: ArtifactId,
  options?: { open?: ArtifactId[] },
): string {
  const base = `/r/${repositoryId}/library/a/${artifactId}`;
  if (!options?.open || options.open.length === 0) {
    return base;
  }
  const params = new URLSearchParams({ open: options.open.join(",") });
  return `${base}?${params.toString()}`;
}

/**
 * Append or clear the `?ask=:threadId` query param on a Library URL,
 * preserving any other query params already present (notably `?open=`).
 */
export function withLibraryAskParam(base: string, askThreadId: ThreadId | null): string {
  const [path, existingQuery] = base.split("?");
  const params = new URLSearchParams(existingQuery ?? "");
  if (askThreadId) {
    params.set("ask", askThreadId);
  } else {
    params.delete("ask");
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const protectedReturnRoutes: RouteObject[] = Object.values(PROTECTED_ROUTE_SEGMENTS).map((path) => ({
  path,
}));

/**
 * True when `pathname` matches a protected route.
 */
export function isProtectedReturnTo(pathname: string): boolean {
  return matchRoutes([{ path: LANDING_PATH, children: protectedReturnRoutes }], pathname) !== null;
}
