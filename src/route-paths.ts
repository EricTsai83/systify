import { matchRoutes, type RouteObject } from "react-router-dom";
import type { ArtifactId, ThreadId, WorkspaceId } from "@/lib/types";

export const LANDING_PATH = "/";
export const AUTH_CALLBACK_ROUTE_SEGMENT = "callback";
export const AUTH_CALLBACK_PATH = `/${AUTH_CALLBACK_ROUTE_SEGMENT}` as const;

/**
 * Authenticated route segments. The shape is intentionally workspace-rooted:
 *
 *   /chat                              — auth landing, redirects into the most
 *                                        recently used workspace
 *   /w/:workspaceId                    — workspace landing, redirects into
 *                                        that workspace's most recent thread
 *                                        (or empty state if there are none)
 *   /w/:workspaceId/t/:threadId        — canonical thread URL
 *   /w/:workspaceId/a/:artifactId      — Artifact Reader (folder-aware deep
 *                                        reader for a single artifact)
 *   /archive                           — archived repos listing
 *
 * Workspace is the schema's primary container: every thread either lives in a
 * repo-bound workspace (1:1 with the repository) or in the user's single
 * no-repo "Home" workspace. Encoding the workspace id directly in the URL lets
 * the shell resolve `repository.repositoryId` synchronously from the cached
 * `listWorkspaces` query, instead of waiting on `getThreadContext` to tell us
 * which workspace this thread belongs to. That removes the loading-window
 * flicker that previously appeared on every workspace transition.
 *
 * The flat `/t/:threadId` and `/r/:repoId` routes used by earlier versions are
 * removed deliberately — they couldn't carry workspace context, so navigations
 * through them always paid for a server round-trip before the chrome could
 * display the right repo. A hard cutover keeps the route table small and
 * eliminates the "is this URL canonical?" branch from every render.
 */
export const PROTECTED_ROUTE_SEGMENTS = {
  chat: "chat",
  workspace: "w/:workspaceId",
  workspaceThread: "w/:workspaceId/t/:threadId",
  workspaceArtifact: "w/:workspaceId/a/:artifactId",
  archive: "archive",
  /**
   * Three-mode restructure — top-level service modes:
   *
   *   - `discuss/:threadId?` — free-form chat, with or without a thread.
   *   - `library` / `library/a/:artifactId` / `library/ask/:threadId` —
   *     read-mostly artifact reader (Read sub-mode renders markdown,
   *     Ask sub-mode lands a Library Ask thread). The Ask URL form is
   *     wired in Phase 1 so the route table is stable; Library Ask
   *     turns on for users in Phase 2.
   *   - `lab/:threadId?` — sandbox-backed mode. Same chat surface as
   *     Discuss for Phase 1; Phase 2 adds the LabStatusBar and explicit
   *     session lifecycle.
   */
  workspaceDiscuss: "w/:workspaceId/discuss",
  workspaceDiscussThread: "w/:workspaceId/discuss/:threadId",
  workspaceLibrary: "w/:workspaceId/library",
  workspaceLibraryArtifact: "w/:workspaceId/library/a/:artifactId",
  workspaceLibraryAsk: "w/:workspaceId/library/ask/:threadId",
  workspaceLab: "w/:workspaceId/lab",
  workspaceLabThread: "w/:workspaceId/lab/:threadId",
} as const;

export const ARCHIVE_PATH = `/${PROTECTED_ROUTE_SEGMENTS.archive}` as const;

export const DEFAULT_AUTHENTICATED_PATH = `/${PROTECTED_ROUTE_SEGMENTS.chat}` as const;

/**
 * Build a `/w/:workspaceId` URL. Centralised so the URL shape lives in exactly
 * one place — every callsite goes through these helpers, so changing the
 * pattern (or adding a query param, prefix, etc.) is a one-file edit.
 */
export function workspacePath(workspaceId: WorkspaceId): string {
  return `/w/${workspaceId}`;
}

/**
 * Build a `/w/:workspaceId/t/:threadId` URL. See {@link workspacePath} for the
 * single-source-of-truth rationale.
 */
export function workspaceThreadPath(workspaceId: WorkspaceId, threadId: ThreadId): string {
  return `/w/${workspaceId}/t/${threadId}`;
}

/**
 * Build a `/w/:workspaceId/a/:artifactId` URL — legacy Artifact Reader
 * entry. Three-mode restructure deprecates this in favour of
 * {@link libraryArtifactPath}; kept so the existing routes still resolve
 * during the transition. New code should target the Library URL.
 */
export function workspaceArtifactPath(workspaceId: WorkspaceId, artifactId: ArtifactId): string {
  return `/w/${workspaceId}/a/${artifactId}`;
}

/**
 * Three-mode restructure — Discuss service mode URL builders. With a
 * thread id, the URL is the canonical "render this thread inside Discuss
 * service mode"; without one, the workspace shell either finds the most
 * recent discuss thread or shows the no-repo empty state. Distinct from
 * the legacy `workspaceThreadPath` because Discuss never renders the
 * artifact panel — surfacing it would imply repo context the mode does
 * not have.
 */
export function discussPath(workspaceId: WorkspaceId, threadId?: ThreadId): string {
  return threadId ? `/w/${workspaceId}/discuss/${threadId}` : `/w/${workspaceId}/discuss`;
}

/**
 * Library Read mode landing. With an artifact id, opens the IDE-style
 * reader directly on that artifact; without one, the shell shows the
 * folder overview. The `open` option is the multi-tab list to restore
 * (round-tripped through `?open=id1,id2`); empty / undefined means
 * "open just the active tab".
 */
export function libraryPath(workspaceId: WorkspaceId): string {
  return `/w/${workspaceId}/library`;
}

export function libraryArtifactPath(
  workspaceId: WorkspaceId,
  artifactId: ArtifactId,
  options?: { open?: ArtifactId[] },
): string {
  const base = `/w/${workspaceId}/library/a/${artifactId}`;
  if (!options?.open || options.open.length === 0) {
    return base;
  }
  // `open` carries the side-tab set so a deep link restores the user's
  // tab strip. Comma-separated to keep the URL human-readable; the
  // canonical writer (Phase 1.5's `useLibraryTabs`) debounces updates
  // so navigation doesn't churn the history.
  const params = new URLSearchParams({ open: options.open.join(",") });
  return `${base}?${params.toString()}`;
}

/**
 * Library Ask thread URL — Phase 1 builds the route, Phase 2 wires the
 * thread-creation flow and turns on the panel. Until then, hitting this
 * URL renders the Library shell with a "Library Ask is rolling out"
 * placeholder.
 */
export function libraryAskPath(workspaceId: WorkspaceId, threadId: ThreadId): string {
  return `/w/${workspaceId}/library/ask/${threadId}`;
}

/**
 * Lab service mode URL — sandbox-backed chat. Same shape as
 * {@link discussPath} so routing stays uniform; the difference lives in
 * the shell that mounts at the URL (Phase 2 adds the LabStatusBar +
 * session lifecycle there).
 */
export function labPath(workspaceId: WorkspaceId, threadId?: ThreadId): string {
  return threadId ? `/w/${workspaceId}/lab/${threadId}` : `/w/${workspaceId}/lab`;
}

const protectedReturnRoutes: RouteObject[] = Object.values(PROTECTED_ROUTE_SEGMENTS).map((path) => ({
  path,
}));

/**
 * True when `pathname` matches a protected route. Keep this derived from the
 * same route segment constants used by the router so post-login redirects do
 * not drift from the actual route table.
 */
export function isProtectedReturnTo(pathname: string): boolean {
  return matchRoutes([{ path: LANDING_PATH, children: protectedReturnRoutes }], pathname) !== null;
}
