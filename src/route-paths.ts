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
 * no-repo "Home" workspace.
 */
export const PROTECTED_ROUTE_SEGMENTS = {
  chat: "chat",
  workspace: "w/:workspaceId",
  workspaceThread: "w/:workspaceId/t/:threadId",
  archive: "archive",
  resources: "resources",
  /**
   * Top-level service modes:
   *
   *   - `discuss/:threadId?` — free-form chat with per-message grounding
   *     toggles (Library / Sandbox) the composer surfaces above the input.
   *   - `library` / `library/a/:artifactId` — read-mostly artifact reader.
   *     The artifact owns the path; the active Library Ask thread travels
   *     as a `?ask=:threadId` query param. The Ask panel is always visible,
   *     so the thread is secondary view-state, not its own route.
   */
  workspaceDiscuss: "w/:workspaceId/discuss",
  workspaceDiscussThread: "w/:workspaceId/discuss/:threadId",
  workspaceLibrary: "w/:workspaceId/library",
  workspaceLibraryArtifact: "w/:workspaceId/library/a/:artifactId",
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
 * returned mode). Routing through this helper keeps the user on the same
 * shell as the thread's mode.
 *
 * Maps:
 *   - `discuss` → `/w/:wid/discuss/:tid`
 *   - `library` → `/w/:wid/library?ask=:tid`
 */
export function modeAwareThreadPath(workspaceId: WorkspaceId, threadId: ThreadId, mode: ThreadMode): string {
  switch (mode) {
    case "discuss":
      return discussPath(workspaceId, threadId);
    case "library":
      return withLibraryAskParam(libraryPath(workspaceId), threadId);
  }
}

/**
 * Discuss service mode URL builders. With a thread id, the URL is the
 * canonical "render this thread inside Discuss service mode"; without one,
 * the workspace shell either finds the most recent discuss thread or shows
 * the no-repo empty state. Discuss never renders the artifact panel —
 * surfacing it would imply repo context the mode does not have.
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
  // canonical writer (`useLibraryTabs`) debounces updates so navigation
  // doesn't churn the history.
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
