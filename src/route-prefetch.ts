let discussRouteModulePromise: Promise<typeof import("@/pages/discuss")> | null = null;
let libraryRouteModulePromise: Promise<typeof import("@/pages/library")> | null = null;

export function prefetchDiscussRoute() {
  discussRouteModulePromise ??= import("@/pages/discuss");
  return discussRouteModulePromise;
}

export function prefetchLibraryRoute() {
  libraryRouteModulePromise ??= import("@/pages/library");
  return libraryRouteModulePromise;
}
