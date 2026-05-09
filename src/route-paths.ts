import { matchRoutes, type RouteObject } from "react-router-dom";

export const LANDING_PATH = "/";
export const AUTH_CALLBACK_ROUTE_SEGMENT = "callback";
export const AUTH_CALLBACK_PATH = `/${AUTH_CALLBACK_ROUTE_SEGMENT}` as const;

export const PROTECTED_ROUTE_SEGMENTS = {
  chat: "chat",
  thread: "t/:threadId",
  repository: "r/:repoId",
  archive: "archive",
} as const;

export const ARCHIVE_PATH = `/${PROTECTED_ROUTE_SEGMENTS.archive}` as const;

export const DEFAULT_AUTHENTICATED_PATH = `/${PROTECTED_ROUTE_SEGMENTS.chat}` as const;

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
