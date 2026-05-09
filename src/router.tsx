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

/**
 * Routes mounted under {@link ProtectedLayout}. Defining them as a named const
 * (rather than inline in `appRoutes`) lets {@link isProtectedReturnTo} match
 * against the same data the router actually uses, so the post-login redirect
 * allowlist cannot drift from the route table — adding a route here is the
 * only place it needs to be registered.
 */
const protectedRoutes: RouteObject[] = [
  // `/chat` is the no-selection workspace entry point. ChatPage redirects
  // it to the most recent thread (`/t/:threadId`) when one exists, or
  // renders the dual-CTA empty state when none does. Per PRD #19 user
  // story 27 ("most recent thread loads on landing").
  { path: PROTECTED_ROUTE_SEGMENTS.chat, lazy: loadChatRoute },
  // PRD #19 user story 25: stable, shareable URLs for design threads.
  { path: PROTECTED_ROUTE_SEGMENTS.thread, lazy: loadChatRoute },
  // PRD #19 user story 26: stable, shareable URLs for repository overviews
  // (artifacts + threads grounded in that repo).
  { path: PROTECTED_ROUTE_SEGMENTS.repository, lazy: loadChatRoute },
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
