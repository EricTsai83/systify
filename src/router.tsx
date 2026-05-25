import { createBrowserRouter, createMemoryRouter, type RouteObject } from "react-router-dom";
import {
  AppLayout,
  AuthCallbackRoute,
  LandingRoute,
  LabLegacyRedirect,
  LegacyThreadRedirect,
  LibraryAskLegacyRedirect,
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

async function loadResourcesRoute() {
  const module = await import("@/pages/resources");
  return { Component: module.ResourcesPage };
}

/**
 * Lazy loaders for the top-level service modes. Each route mounts its own
 * shell so the mode the user is in maps 1:1 to the URL, and code-splitting
 * separates the Library Read bundle from the Discuss chat bundle.
 */
async function loadDiscussRoute() {
  const module = await import("@/pages/discuss");
  return { Component: module.DiscussPage };
}

async function loadLibraryRoute() {
  const module = await import("@/pages/library");
  return { Component: module.LibraryPage };
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
  // recently used workspace's most-recent thread. It exists primarily as the
  // post-login landing target and the place we bounce to after destructive
  // operations clear the current selection.
  { path: PROTECTED_ROUTE_SEGMENTS.chat, lazy: loadChatRoute },
  // `/w/:workspaceId` is the workspace landing target. Same redirect-to-most-
  // recent-thread behaviour as `/chat`, but scoped to the workspace named in
  // the URL — used by the workspace switcher and as the canonical destination
  // when a thread URL no longer resolves but its workspace still exists.
  { path: PROTECTED_ROUTE_SEGMENTS.workspace, lazy: loadChatRoute },
  // `/w/:workspaceId/t/:threadId` is the legacy mode-agnostic thread URL —
  // kept reachable only for stale bookmarks and external links saved
  // before the canonical-URL switchover; no in-app code generates it now
  // (every navigation surface routes via `modeAwareThreadPath`). The
  // redirect canonicalises onto the service-mode-aware path
  // (`/w/:wid/discuss/:tid` or `/w/:wid/library?ask=:tid`) so the URL
  // itself carries the user's mode and `useChatMode` reads it directly
  // without a placeholder fallback.
  { path: PROTECTED_ROUTE_SEGMENTS.workspaceThread, Component: LegacyThreadRedirect },
  // Top-level service modes live under their own path prefixes. The page
  // components wrap the shared workspace chrome (sidebar, top-bar) and
  // pivot the inset content based on mode.
  { path: PROTECTED_ROUTE_SEGMENTS.workspaceDiscuss, lazy: loadDiscussRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.workspaceDiscussThread, lazy: loadDiscussRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.workspaceLibrary, lazy: loadLibraryRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.workspaceLibraryArtifact, lazy: loadLibraryRoute },
  // Legacy Library Ask URL — the standalone route was removed when Library
  // Ask became an always-visible column addressed by `?ask=`. Redirect old
  // bookmarks/links so they don't 404. Kept as a literal (not a
  // `PROTECTED_ROUTE_SEGMENTS` entry) so it stays out of the post-login
  // return-to allowlist — see `LibraryAskLegacyRedirect`.
  { path: "w/:workspaceId/library/ask/:threadId", Component: LibraryAskLegacyRedirect },
  // Legacy Lab-mode URLs — "lab" was the original name for "discuss" mode.
  // Redirect old bookmarks/links so they don't 404. Kept as literals (not
  // `PROTECTED_ROUTE_SEGMENTS` entries) so they stay out of the post-login
  // return-to allowlist — see `LabLegacyRedirect`.
  { path: "w/:workspaceId/lab", Component: LabLegacyRedirect },
  { path: "w/:workspaceId/lab/:threadId", Component: LabLegacyRedirect },
  { path: PROTECTED_ROUTE_SEGMENTS.archive, lazy: loadArchiveRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.resources, lazy: loadResourcesRoute },
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
