import { createBrowserRouter, createMemoryRouter, type RouteObject } from "react-router-dom";
import {
  AppLayout,
  AuthCallbackRoute,
  LandingRoute,
  NotFoundRoute,
  ProtectedLayout,
  RouteErrorBoundary,
} from "@/router-layouts";
import { AUTH_CALLBACK_ROUTE_SEGMENT, PROTECTED_ROUTE_SEGMENTS } from "@/route-paths";

async function loadChatRoute() {
  const module = await import("@/pages/chat");
  return { Component: module.ChatPage };
}

async function loadArchiveRoute() {
  const module = await import("@/pages/archive");
  return { Component: module.ArchivePage };
}

async function loadArtifactReaderRoute() {
  const module = await import("@/pages/artifact-reader");
  return { Component: module.ArtifactReaderPage };
}

/**
 * Routes mounted under {@link ProtectedLayout}. Defining them as a named const
 * (rather than inline in `appRoutes`) lets {@link isProtectedReturnTo} match
 * against the same data the router actually uses, so the post-login redirect
 * allowlist cannot drift from the route table — adding a route here is the
 * only place it needs to be registered.
 */
const protectedRoutes: RouteObject[] = [
  // `/chat` is the workspaceless entry point: ChatPage redirects to the most
  // recently used workspace's most-recent thread (PRD #19 user story 27).
  // It exists primarily as the post-login landing target and the place we
  // bounce to after destructive operations clear the current selection.
  { path: PROTECTED_ROUTE_SEGMENTS.chat, lazy: loadChatRoute },
  // `/w/:workspaceId` is the workspace landing target. Same redirect-to-most-
  // recent-thread behaviour as `/chat`, but scoped to the workspace named in
  // the URL — used by the workspace switcher and as the canonical destination
  // when a thread URL no longer resolves but its workspace still exists.
  { path: PROTECTED_ROUTE_SEGMENTS.workspace, lazy: loadChatRoute },
  // `/w/:workspaceId/t/:threadId` is the canonical thread URL. Encoding the
  // workspace id in the URL means the shell can derive `repository.repositoryId`
  // synchronously from the cached `listWorkspaces` query — no `getThreadContext`
  // round-trip required to know which repo's chrome to render. PRD #19 user
  // story 25 ("stable, shareable URLs for design threads").
  { path: PROTECTED_ROUTE_SEGMENTS.workspaceThread, lazy: loadChatRoute },
  // `/w/:workspaceId/a/:artifactId` is the Artifact Reader — a folder-aware,
  // wide-format reader for a single artifact. Lives alongside `/t/:threadId`
  // under the same workspace prefix so the sidebar, top-bar, and workspace
  // chrome stay consistent on entry. Direct entries (bookmarks, shared
  // links) are resolved via `api.artifacts.getById`; missing artifacts
  // surface a not-found state inside the reader.
  { path: PROTECTED_ROUTE_SEGMENTS.workspaceArtifact, lazy: loadArtifactReaderRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.archive, lazy: loadArchiveRoute },
];

export const appRoutes: RouteObject[] = [
  {
    path: "/",
    Component: AppLayout,
    ErrorBoundary: RouteErrorBoundary,
    children: [
      { index: true, Component: LandingRoute },
      { path: AUTH_CALLBACK_ROUTE_SEGMENT, Component: AuthCallbackRoute },
      { Component: ProtectedLayout, children: protectedRoutes },
      { path: "*", Component: NotFoundRoute },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}

export function createAppMemoryRouter(initialEntries: string[] = ["/"]) {
  return createMemoryRouter(appRoutes, { initialEntries });
}
