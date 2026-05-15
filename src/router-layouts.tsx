import { Suspense, useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  Navigate,
  Outlet,
  Link,
  isRouteErrorResponse,
  useLocation,
  useParams,
  useRouteError,
  useSearchParams,
} from "react-router-dom";
import { AppNotice } from "@/components/app-notice";
import { ScreenState } from "@/components/screen-state";
import { Button } from "@/components/ui/button";
import { hasWorkOSSessionHint } from "@/lib/auth-session-hint";
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

  return (
    <Suspense fallback={<RouteLoadingScreen description="Loading your chat workspace." />}>
      <Outlet />
    </Suspense>
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
          ? "Still syncing your workspace and permissions. This usually takes a few more seconds."
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

/**
 * Legacy Library Ask URL redirect. The standalone `/library/ask/:threadId`
 * route was removed when Library Ask became an always-visible column
 * addressed by `?ask=:threadId`. Old bookmarks/links land here and bounce
 * to the canonical query-param URL; `replace` keeps the dead URL out of
 * history so Back doesn't ping-pong between the two forms.
 *
 * This path is deliberately NOT registered in `PROTECTED_ROUTE_SEGMENTS` /
 * `isProtectedReturnTo` — re-adding the literal there would reintroduce the
 * route-table drift that allowlist is designed to prevent. The narrow cost:
 * a logged-out user hitting a stale Ask bookmark returns to the default
 * path after sign-in rather than to the thread.
 */
export function LibraryAskLegacyRedirect() {
  const { workspaceId, threadId } = useParams<{ workspaceId: string; threadId: string }>();
  if (!workspaceId) {
    return <Navigate to={LANDING_PATH} replace />;
  }
  const base = `/w/${workspaceId}/library`;
  const target = threadId ? `${base}?ask=${threadId}` : base;
  return <Navigate to={target} replace />;
}

function AuthLoadingScreen() {
  return <RouteLoadingScreen description="Reconnecting your session and loading your workspace." />;
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
  try {
    return window.sessionStorage.getItem(AUTH_RETURN_TO_KEY);
  } catch {
    return null;
  }
}

function writeStoredReturnTo(path: string) {
  try {
    window.sessionStorage.setItem(AUTH_RETURN_TO_KEY, path);
  } catch {
    // Browsers can deny storage in privacy modes; auth should still continue.
  }
}

function removeStoredReturnTo() {
  try {
    window.sessionStorage.removeItem(AUTH_RETURN_TO_KEY);
  } catch {
    // Ignore unavailable storage; the in-memory auth flow can still complete.
  }
}
