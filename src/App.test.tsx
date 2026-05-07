// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";
import { createAppMemoryRouter } from "./router";
import { AUTH_RETURN_TO_KEY } from "./router-layouts";

const getAccessTokenMock = vi.fn<() => Promise<string | null>>();

vi.mock("@workos-inc/authkit-react", async () => {
  const React = await import("react");

  return {
    AuthKitProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAuth: vi.fn(),
  };
});

vi.mock("@/providers/theme-provider", async () => {
  const React = await import("react");

  return {
    ThemeProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/pages/home", () => ({
  HomePage: () => <div>home page</div>,
}));

vi.mock("@/pages/chat", () => ({
  ChatPage: () => <div>chat page</div>,
}));

vi.mock("convex/react", async () => {
  const React = await import("react");

  const AuthContext = React.createContext({
    isLoading: true,
    isAuthenticated: false,
    fetchAccessToken: async () => null as string | null,
  });

  return {
    ConvexProviderWithAuth: ({
      children,
      useAuth,
    }: {
      children: React.ReactNode;
      useAuth: () => {
        isLoading: boolean;
        isAuthenticated: boolean;
        fetchAccessToken: () => Promise<string | null>;
      };
    }) => {
      const auth = useAuth();
      const { fetchAccessToken } = auth;

      React.useEffect(() => {
        const timer = window.setTimeout(() => {
          void fetchAccessToken();
        }, 0);

        return () => window.clearTimeout(timer);
      }, [fetchAccessToken]);

      return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
    },
    ConvexReactClient: class {},
    useConvexAuth: () => React.useContext(AuthContext),
  };
});

describe("App auth token failures", () => {
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    // Expire any cookies set during the test so the WorkOS session hint
    // doesn't leak into the next case (jsdom keeps document.cookie alive).
    for (const cookie of document.cookie.split(";")) {
      const eq = cookie.indexOf("=");
      const name = (eq === -1 ? cookie : cookie.slice(0, eq)).trim();
      if (name) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    }
    getAccessTokenMock.mockReset();
    vi.restoreAllMocks();
  });

  test("shows the auth error even when the user is signed in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    getAccessTokenMock.mockRejectedValue(new Error("token fetch failed"));

    function useAuth() {
      return {
        isLoading: false,
        user: { id: "user_1" },
        getAccessToken: getAccessTokenMock,
      };
    }

    renderWithAuth(useAuth, ["/chat"]);

    expect(await screen.findByText("chat page")).toBeInTheDocument();
    expect(
      await screen.findByText("Authentication failed. Please refresh the page and sign in again."),
    ).toBeInTheDocument();
  });

  test("loads the home route for signed-out users on /", async () => {
    function useAuth() {
      return {
        isLoading: false,
        user: null,
        getAccessToken: getAccessTokenMock,
      };
    }

    renderWithAuth(useAuth, ["/"]);

    expect(await screen.findByText("home page")).toBeInTheDocument();
  });

  test("redirects signed-in users from / to /chat", async () => {
    function useAuth() {
      return {
        isLoading: false,
        user: { id: "user_1" },
        getAccessToken: getAccessTokenMock,
      };
    }

    renderWithAuth(useAuth, ["/"]);

    expect(await screen.findByText("chat page")).toBeInTheDocument();
  });

  test("shows the auth loading screen instead of HomePage on / when a WorkOS session cookie is present", async () => {
    // Returning signed-in user: cookie was set by a prior OAuth callback,
    // and useConvexAuth hasn't finished hydrating yet. We should *not*
    // flash HomePage before the redirect to /chat fires.
    document.cookie = "workos-has-session=client_test";

    function useAuth() {
      return {
        isLoading: true,
        user: null,
        getAccessToken: getAccessTokenMock,
      };
    }

    renderWithAuth(useAuth, ["/"]);

    expect(await screen.findByText("Reconnecting your session and loading your workspace.")).toBeInTheDocument();
    expect(screen.queryByText("home page")).not.toBeInTheDocument();
  });

  test("renders HomePage during auth loading when no WorkOS session cookie is present", async () => {
    // First-time / signed-out visitor: nothing in document.cookie hints at
    // a prior session, so the static landing page renders immediately
    // rather than blocking on auth hydration.
    function useAuth() {
      return {
        isLoading: true,
        user: null,
        getAccessToken: getAccessTokenMock,
      };
    }

    renderWithAuth(useAuth, ["/"]);

    expect(await screen.findByText("home page")).toBeInTheDocument();
  });

  test("redirects signed-in users from /callback to /chat", async () => {
    function useAuth() {
      return {
        isLoading: false,
        user: { id: "user_1" },
        getAccessToken: getAccessTokenMock,
      };
    }

    const router = renderWithAuth(useAuth, ["/callback?code=test-code"]);

    expect(await screen.findByText("chat page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/chat");
  });

  test("persists attempted protected path before redirecting unauthenticated users to /", async () => {
    function useAuth() {
      return {
        isLoading: false,
        user: null,
        getAccessToken: getAccessTokenMock,
      };
    }

    const router = renderWithAuth(useAuth, ["/r/repo_xyz"]);

    // ProtectedLayout should bounce signed-out users back to the landing route.
    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    // …and have stashed the originally-requested path so AuthCallbackRoute can
    // resume there after sign-in (covers persistAuthReturnTo + normalizeReturnTo).
    expect(window.sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBe("/r/repo_xyz");
  });

  test("redirects callback users back to stored destination", async () => {
    window.sessionStorage.setItem(AUTH_RETURN_TO_KEY, "/r/repo_123");

    function useAuth() {
      return {
        isLoading: false,
        user: { id: "user_1" },
        getAccessToken: getAccessTokenMock,
      };
    }

    const router = renderWithAuth(useAuth, ["/callback?code=test-code"]);

    expect(await screen.findByText("chat page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/r/repo_123");
    expect(window.sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBeNull();
  });

  test("ignores unsafe callback return destination and falls back to /chat", async () => {
    window.sessionStorage.setItem(AUTH_RETURN_TO_KEY, "//evil.example/steal");

    function useAuth() {
      return {
        isLoading: false,
        user: { id: "user_1" },
        getAccessToken: getAccessTokenMock,
      };
    }

    const router = renderWithAuth(useAuth, ["/callback?code=test-code"]);

    expect(await screen.findByText("chat page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/chat");
    expect(window.sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBeNull();
  });

  test("ignores callback return destination to avoid redirect loops", async () => {
    window.sessionStorage.setItem(AUTH_RETURN_TO_KEY, "/callback?code=stale-code");

    function useAuth() {
      return {
        isLoading: false,
        user: { id: "user_1" },
        getAccessToken: getAccessTokenMock,
      };
    }

    const router = renderWithAuth(useAuth, ["/callback?code=test-code"]);

    expect(await screen.findByText("chat page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/chat");
    expect(window.sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBeNull();
  });

  test("shows a clear callback error message for cancelled sign-in", async () => {
    function useAuth() {
      return {
        isLoading: false,
        user: null,
        getAccessToken: getAccessTokenMock,
      };
    }

    renderWithAuth(useAuth, ["/callback?error=access_denied"]);

    expect(await screen.findByText("Sign-in was cancelled")).toBeInTheDocument();
    expect(await screen.findByText("Back to home")).toBeInTheDocument();
  });

  test("shows a friendly 404 route page instead of router default error", async () => {
    function useAuth() {
      return {
        isLoading: false,
        user: null,
        getAccessToken: getAccessTokenMock,
      };
    }

    renderWithAuth(useAuth, ["/does-not-exist"]);

    expect(await screen.findByText("This page does not exist.")).toBeInTheDocument();
    expect(await screen.findByText("Go to home")).toBeInTheDocument();
  });
});

function renderWithAuth(
  useAuth: () => {
    isLoading: boolean;
    user: { id: string } | null;
    getAccessToken: () => Promise<string | null>;
  },
  initialEntries: string[],
) {
  const router = createAppMemoryRouter(initialEntries);

  render(
    <App
      router={router}
      convexClient={{} as never}
      useAuthHook={useAuth}
      workosClientId="client_test"
      redirectUri="http://localhost/callback"
    />,
  );

  return router;
}
