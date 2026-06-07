import { Suspense, useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  Navigate,
  Outlet,
  Link,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
  useSearchParams,
} from "react-router-dom";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { AppNotice } from "@/components/app-notice";
import { ScreenState } from "@/components/screen-state";
import { Button } from "@/components/ui/button";
import { SidebarProvider } from "@/components/ui/sidebar";
import { isDemoMode, useViewerAccess } from "@/hooks/use-viewer-access";
import { hasWorkOSSessionHint } from "@/lib/auth-session-hint";
import { readString, removeKey, writeString } from "@/lib/storage";
import { useConvexAuthStatus } from "@/providers/convex-provider-with-auth-kit";
import { AUTH_CALLBACK_PATH, DEFAULT_AUTHENTICATED_PATH, LANDING_PATH, isProtectedReturnTo } from "@/route-paths";
import { HomePage } from "@/pages/home";

const MAX_CALLBACK_ERROR_DESCRIPTION_LENGTH = 240;

/**
 * sessionStorage key used to remember the protected URL an unauthenticated
 * user attempted to visit, so AuthCallbackRoute can return them there after
 * sign-in. Exported so tests assert against the same constant the
 * implementation uses (no magic-string drift).
 */
export const AUTH_RETURN_TO_KEY = "systify.auth.returnTo";

export function AppLayout() {
  const { authError } = useConvexAuthStatus();

  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      {authError ? (
        <div className="absolute inset-x-0 top-0 z-10 border-b border-border px-4 py-3">
          <AppNotice
            title="Authentication error"
            message={authError}
            tone="error"
            actionLabel="Refresh"
            onAction={() => window.location.reload()}
          />
        </div>
      ) : null}
      <Outlet />
    </div>
  );
}

export function RouterHydrateFallback() {
  return null;
}

export function LandingRoute() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  // Auth confirmed — redirect logged-in users to the app.
  if (!isLoading && isAuthenticated) {
    return <Navigate to={DEFAULT_AUTHENTICATED_PATH} replace />;
  }

  // Auth still resolving but the WorkOS session cookie says this browser
  // was signed in last time. Render the auth-loading screen instead of
  // HomePage so returning users don't see a marketing-page flash before
  // we redirect them to /chat — the cookie is the same synchronous signal
  // the WorkOS SDK uses to decide whether to refresh a session on boot.
  if (isLoading && hasWorkOSSessionHint()) {
    return <AuthLoadingScreen />;
  }

  // Render the static home page immediately, even while auth is still
  // loading. The home page is fully static (no auth, no data fetching),
  // so there's no reason to block rendering behind an auth check.
  return <HomePage />;
}

export function ProtectedLayout() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const location = useLocation();
  const attemptedPath = `${location.pathname}${location.search}${location.hash}`;
  const viewerAccess = useViewerAccess({ enabled: !isLoading && isAuthenticated });

  // Persist the attempted protected path so AuthCallbackRoute can return the
  // user there after sign-in. Two reasons this lives in a committed effect
  // rather than the render path:
  //   1. Writing to sessionStorage during render is a side effect; under
  //      concurrent rendering / Strict Mode the same render can run twice
  //      and we'd write the same value redundantly.
  //   2. We must wait for `isLoading` to settle before persisting, otherwise
  //      we'd stash a "return-to" entry for a user who is actually already
  //      authenticated (initial `isAuthenticated` is `false` simply because
  //      the auth check hasn't completed yet) and never clean it up — the
  //      callback-side cleanup only runs on the auth callback route.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      persistAuthReturnTo(attemptedPath);
    }
  }, [isLoading, isAuthenticated, attemptedPath]);

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (!isAuthenticated) {
    return <Navigate to={LANDING_PATH} replace />;
  }

  // SidebarProvider lives here, above the route Outlet, so it stays mounted
  // across protected-route navigation. With it inside each page, navigating
  // from a page that renders Sidebar (/chat, /discuss, /library) into one
  // that doesn't (/archive, /resources) unmounted the provider mid-open
  // and stranded Radix's mobile-Sheet overlay + scroll lock on the
  // destination page. Hoisting it lets the pathname effect inside the
  // provider observe the route change and close the Sheet cleanly.
  return (
    <SidebarProvider>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isDemoMode(viewerAccess) ? <DemoModeBanner /> : null}
        <Suspense fallback={<RouteLoadingScreen description="Loading your chat." />}>
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <Outlet />
          </div>
        </Suspense>
      </div>
    </SidebarProvider>
  );
}

function DemoModeBanner() {
  return (
    <div className="shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-foreground" role="status">
      <div className="mx-auto flex w-full max-w-7xl justify-center">
        <div className="flex max-w-4xl items-start justify-center gap-2 text-center sm:items-center">
          <WarningCircleIcon
            size={18}
            weight="fill"
            className="mt-0.5 shrink-0 text-warning sm:mt-0"
            aria-hidden="true"
          />
          <div className="min-w-0 text-xs leading-5 sm:flex sm:flex-wrap sm:items-baseline sm:justify-center sm:gap-x-2">
            <span className="font-semibold text-foreground">Demo Mode</span>
            <span>
              Cost-incurring features are disabled, including messages, repository import and sync, live source
              sessions, Repository Guide generation, premium models, and high reasoning.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AuthCallbackRoute() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [searchParams] = useSearchParams();
  const [loadingStartedAt] = useState(() => Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const callbackError = searchParams.get("error");
  const callbackErrorDescription = searchParams.get("error_description");
  // Read the stored destination exactly once at mount. `useState`'s lazy
  // initializer (unlike `useMemo`) is guaranteed not to re-run, so the value
  // is stable for the component's lifetime even if React decides to discard
  // memoized values.
  const [returnTo] = useState(() => getStoredReturnTo());

  useEffect(() => {
    if (!isLoading) {
      return;
    }
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - loadingStartedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isLoading, loadingStartedAt]);

  useEffect(() => {
    if (isAuthenticated) {
      removeStoredReturnTo();
    }
  }, [isAuthenticated]);

  if (isLoading) {
    const isSlow = elapsedMs >= 8_000;
    const description =
      elapsedMs < 2_000
        ? "Finishing sign-in and validating your session."
        : elapsedMs < 8_000
          ? "Still syncing your account and permissions. This usually takes a few more seconds."
          : "This is taking longer than expected. You can retry or return home.";

    return (
      <div className="flex h-full w-full items-center justify-center px-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">Signing you in…</h1>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          {isSlow ? (
            <div className="mt-5 flex items-center justify-center gap-3">
              <Button asChild variant="secondary">
                <Link to={LANDING_PATH} replace>
                  Back to home
                </Link>
              </Button>
              <Button onClick={() => window.location.reload()}>Retry</Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to={returnTo ?? DEFAULT_AUTHENTICATED_PATH} replace />;
  }

  const { title, description } = mapCallbackErrorToCopy({
    callbackError,
    callbackErrorDescription,
  });

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <Button asChild variant="secondary">
            <Link to={LANDING_PATH} replace>
              Back to home
            </Link>
          </Button>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    </div>
  );
}

export function RouteErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return <NotFoundRoute />;
    }

    return (
      <ScreenState
        title={`Request failed (${error.status})`}
        description={error.statusText || "Something unexpected happened while loading this page."}
      />
    );
  }

  return (
    <ScreenState
      title="Something went wrong"
      description="Please refresh this page. If the issue continues, return home and try again."
    />
  );
}

export function NotFoundRoute() {
  return (
    <div className="flex min-h-dvh w-full items-center justify-center px-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-lg font-semibold text-foreground">This page does not exist.</h1>
        <p className="mt-2 text-sm text-muted-foreground">The link may be outdated, or the page was moved.</p>
        <div className="mt-5 flex justify-center">
          <Button asChild>
            <Link to={LANDING_PATH}>Go to home</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function AuthLoadingScreen() {
  return <RouteLoadingScreen description="Reconnecting your session and loading your account." />;
}

function RouteLoadingScreen({ description }: { description: string }) {
  return <ScreenState title="Loading…" description={description} isLoading />;
}

function getStoredReturnTo() {
  const value = readStoredReturnTo();
  if (!value) {
    return null;
  }
  const normalized = normalizeReturnTo(value);
  if (normalized === null) {
    removeStoredReturnTo();
    return null;
  }
  return normalized;
}

function mapCallbackErrorToCopy({
  callbackError,
  callbackErrorDescription,
}: {
  callbackError: string | null;
  callbackErrorDescription: string | null;
}) {
  const safeCallbackErrorDescription = normalizeCallbackErrorDescription(callbackErrorDescription);

  if (callbackError === "access_denied") {
    return {
      title: "Sign-in was cancelled",
      description: "You closed or denied the sign-in request. Try again when you are ready.",
    };
  }

  if (callbackError === "temporarily_unavailable" || callbackError === "server_error") {
    return {
      title: "Sign-in service is temporarily unavailable",
      description: "Please retry in a moment. If this keeps happening, return home and start sign-in again.",
    };
  }

  if (safeCallbackErrorDescription) {
    return {
      title: "We could not complete your sign-in",
      description: safeCallbackErrorDescription,
    };
  }

  if (callbackError) {
    return {
      title: "We could not complete your sign-in",
      description: `Sign-in returned an unexpected response (${callbackError}). Please retry.`,
    };
  }

  return {
    title: "Your sign-in session expired",
    description: "Please return home and start sign-in again.",
  };
}

function persistAuthReturnTo(path: string) {
  const normalized = normalizeReturnTo(path);
  if (normalized === null) {
    return;
  }
  writeStoredReturnTo(normalized);
}

function normalizeReturnTo(path: string) {
  // Reject schemeless or protocol-relative URLs (e.g. `//evil.com`) before
  // parsing — they could otherwise resolve to a different origin.
  if (!path.startsWith("/") || path.startsWith("//")) {
    return null;
  }

  try {
    const parsed = new URL(path, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return null;
    }
    // Defense-in-depth: never return the user to the callback route, which would
    // create a redirect loop. Use an exact pathname match so we don't
    // overbroadly reject siblings like `/callback-help` if such routes are
    // ever added (and we still rely on `isProtectedReturnTo` as the
    // single-source allowlist below).
    if (parsed.pathname === AUTH_CALLBACK_PATH) {
      return null;
    }
    if (!isProtectedReturnTo(parsed.pathname)) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function normalizeCallbackErrorDescription(description: string | null) {
  if (!description) {
    return null;
  }
  const trimmed = description.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= MAX_CALLBACK_ERROR_DESCRIPTION_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_CALLBACK_ERROR_DESCRIPTION_LENGTH)}...`;
}

function readStoredReturnTo() {
  return readString(AUTH_RETURN_TO_KEY, "session");
}

function writeStoredReturnTo(path: string) {
  writeString(AUTH_RETURN_TO_KEY, path, "session");
}

function removeStoredReturnTo() {
  removeKey(AUTH_RETURN_TO_KEY, "session");
}
