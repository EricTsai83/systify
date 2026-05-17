import { matchRoutes, type RouteObject } from "react-router-dom";
import type { ArtifactId, ThreadId, ThreadMode, WorkspaceId } from "@/lib/types";

/**
 * Re-export {@link ThreadMode} from `lib/types` so existing callers that
 * imported it from `route-paths` (`workspaceThreadsRail`, `repository-shell`
 * etc.) keep working. The canonical declaration lives next to the other
 * domain id types in `lib/types` so back-end-driven types stay in one
 * file.
 */
export type { ThreadMode };

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
  archive: "archive",
  resources: "resources",
  /**
   * Three-mode restructure — top-level service modes:
   *
   *   - `discuss/:threadId?` — free-form chat, with or without a thread.
   *   - `library` / `library/a/:artifactId` — read-mostly artifact reader.
   *     The artifact owns the path; the active Library Ask thread travels
   *     as a `?ask=:threadId` query param. The Ask panel is always visible,
   *     so the thread is secondary view-state, not its own route.
   *   - `lab/:threadId?` — sandbox-backed mode. Same chat surface as
   *     Discuss for Phase 1; Phase 2 adds the LabStatusBar and explicit
   *     session lifecycle.
   */
  workspaceDiscuss: "w/:workspaceId/discuss",
  workspaceDiscussThread: "w/:workspaceId/discuss/:threadId",
  workspaceLibrary: "w/:workspaceId/library",
  workspaceLibraryArtifact: "w/:workspaceId/library/a/:artifactId",
  workspaceLab: "w/:workspaceId/lab",
  workspaceLabThread: "w/:workspaceId/lab/:threadId",
} as const;

export const ARCHIVE_PATH = `/${PROTECTED_ROUTE_SEGMENTS.archive}` as const;

export const RESOURCES_PATH = `/${PROTECTED_ROUTE_SEGMENTS.resources}` as const;

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
 * Build the canonical mode-aware URL for a thread given its stored mode.
 *
 * The single URL builder used by every in-app callsite that knows a
 * thread's mode (sidebar row clicks, fresh thread creation via the
 * mutation's `{ _id, mode }` return, post-import navigation via the
 * import's `defaultThreadMode` field, attach/swap via `setThreadRepository`'s
 * returned mode). Routing through this helper instead of the
 * mode-agnostic `/w/:wid/t/:tid` URL keeps the user on the same shell
 * component when navigating within a mode — e.g. clicking a Discuss
 * thread while already on `/w/:wid/discuss/:tid_prev` reaches
 * `/w/:wid/discuss/:tid_next` with only a params change, so
 * `RepositoryShell` and its Convex subscriptions stay mounted instead of
 * unmounting through `LegacyThreadRedirect`.
 *
 * Maps:
 *   - discuss / docs / sandbox → `/w/:wid/discuss/:tid` (Discuss service mode
 *     hosts all three thread sub-modes)
 *   - ask → `/w/:wid/library?ask=:tid` (Library Ask threads live in the
 *     Library reader as a query param, not their own route)
 *   - lab → `/w/:wid/lab/:tid`
 */
export function modeAwareThreadPath(workspaceId: WorkspaceId, threadId: ThreadId, mode: ThreadMode): string {
  switch (mode) {
    case "discuss":
    case "docs":
    case "sandbox":
      return discussPath(workspaceId, threadId);
    case "ask":
      return withLibraryAskParam(libraryPath(workspaceId), threadId);
    case "lab":
      return labPath(workspaceId, threadId);
  }
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
 * Library mode landing. With an artifact id, opens the IDE-style reader
 * directly on that artifact; without one, the shell shows the folder
 * overview. The `open` option is the multi-tab list to restore
 * (round-tripped through `?open=id1,id2`); empty / undefined means
 * "open just the active tab". An `?ask=:threadId` query param may also
 * be present — that one is owned by the page, not these builders.
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
 * Append or clear the `?ask=:threadId` query param on a Library URL,
 * preserving any other query params already present (notably `?open=`).
 * The active Library Ask thread is secondary view-state — the artifact
 * owns the path — so it travels as a query param rather than its own
 * route. Used by the legacy `/library/ask/:threadId` redirect; the page
 * itself mutates `?ask=` through `useSearchParams` directly.
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
