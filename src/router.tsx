import { createBrowserRouter, createMemoryRouter, useParams, type RouteObject } from "react-router-dom";
import {
  AppLayout,
  AuthCallbackRoute,
  LandingRoute,
  NotFoundRoute,
  ProtectedLayout,
  RouteErrorBoundary,
  RouterHydrateFallback,
} from "@/router-layouts";
import { AUTH_CALLBACK_ROUTE_SEGMENT, PROTECTED_ROUTE_SEGMENTS, PUBLIC_ROUTE_SEGMENTS } from "@/route-paths";
import { prefetchDiscussRoute, prefetchLibraryRoute } from "@/route-prefetch";
import type { ThreadId } from "@/lib/types";

// Validate that a URL param looks like a valid Convex ID (non-empty string with
// alphanumeric + common separators; prevents injection of obviously malformed values).
function isValidConvexId(value: string | undefined): boolean {
  return !!value && /^[a-z0-9_|.-]+$/i.test(value);
}

async function loadRepolessChatRoute() {
  const module = await import("@/components/repoless-chat-shell");
  return {
    Component: function RepolessChatRoute() {
      const params = useParams<{ threadId?: string }>();
      const urlThreadId = isValidConvexId(params.threadId) ? (params.threadId as ThreadId) : null;
      return <module.RepolessChatShell urlThreadId={urlThreadId} />;
    },
  };
}

async function loadArchiveRoute() {
  const module = await import("@/pages/archive");
  return { Component: module.ArchivePage };
}

async function loadResourcesRoute() {
  const module = await import("@/pages/resources");
  return { Component: module.ResourcesPage };
}

async function loadSettingsRoute() {
  const module = await import("@/pages/settings");
  return { Component: module.SettingsPage };
}

async function loadSharedThreadRoute() {
  const module = await import("@/pages/shared-thread");
  return {
    Component: function SharedThreadRoute() {
      const params = useParams<{ token?: string }>();
      return <module.SharedThreadPage token={params.token ?? ""} />;
    },
  };
}

/**
 * Lazy loaders for the top-level service modes. Each route mounts its own
 * shell so the mode the user is in maps 1:1 to the URL, and code-splitting
 * separates the Library Read bundle from the Discuss chat bundle.
 */
async function loadDiscussRoute() {
  const module = await prefetchDiscussRoute();
  return { Component: module.DiscussPage };
}

async function loadLibraryRoute() {
  const module = await prefetchLibraryRoute();
  return { Component: module.LibraryPage };
}

const protectedRoutes: RouteObject[] = [
  // `/chat` and `/chat/:threadId` mount the repoless chat shell. The bare
  // `/chat` is the post-login landing and the empty-state surface; the
  // `/chat/:threadId` variant renders an existing repoless thread.
  { path: `${PROTECTED_ROUTE_SEGMENTS.chat}/:threadId?`, lazy: loadRepolessChatRoute },
  // `/r/:repositoryId` is the repository landing target. Redirects into
  // that repository's most recent thread (or empty state).
  { path: PROTECTED_ROUTE_SEGMENTS.repository, lazy: loadDiscussRoute },
  // Top-level service modes live under their own path prefixes.
  { path: `${PROTECTED_ROUTE_SEGMENTS.repositoryDiscuss}/:threadId?`, lazy: loadDiscussRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.repositoryLibrary, lazy: loadLibraryRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.repositoryLibraryArtifact, lazy: loadLibraryRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.archive, lazy: loadArchiveRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.resources, lazy: loadResourcesRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.settings, lazy: loadSettingsRoute },
  { path: PROTECTED_ROUTE_SEGMENTS.settingsSection, lazy: loadSettingsRoute },
];

export const appRoutes: RouteObject[] = [
  {
    path: "/",
    Component: AppLayout,
    HydrateFallback: RouterHydrateFallback,
    ErrorBoundary: RouteErrorBoundary,
    children: [
      { index: true, Component: LandingRoute },
      { path: AUTH_CALLBACK_ROUTE_SEGMENT, Component: AuthCallbackRoute },
      { path: PUBLIC_ROUTE_SEGMENTS.sharedThread, lazy: loadSharedThreadRoute },
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
