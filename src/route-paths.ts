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
 * Build a `/w/:workspaceId/a/:artifactId` URL — Artifact Reader entry. The
 * workspace id is encoded so the Reader can paint workspace chrome
 * (sidebar, breadcrumb, repo title) without a `getRepositoryDetail`
 * round-trip; the artifact id resolves the document body itself.
 */
export function workspaceArtifactPath(workspaceId: WorkspaceId, artifactId: ArtifactId): string {
  return `/w/${workspaceId}/a/${artifactId}`;
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
