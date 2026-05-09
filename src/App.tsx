import type { ComponentProps } from "react";
import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import { ConvexReactClient } from "convex/react";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ConvexProviderWithAuthKit } from "@/providers/convex-provider-with-auth-kit";
import { ErrorBoundary } from "@/providers/error-boundary";
import { ThemeProvider } from "@/providers/theme-provider";
import { createAppRouter } from "@/router";
import { AUTH_CALLBACK_PATH } from "@/route-paths";

type AppRouter = ComponentProps<typeof RouterProvider>["router"];
type ConvexClient = ComponentProps<typeof ConvexProviderWithAuthKit>["client"];
type AuthHook = ComponentProps<typeof ConvexProviderWithAuthKit>["useAuth"];

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
const router = createAppRouter();
const workosRedirectUri = new URL(AUTH_CALLBACK_PATH, window.location.origin).toString();

type AppProps = {
  router?: AppRouter;
  convexClient?: ConvexClient;
  useAuthHook?: AuthHook;
  workosClientId?: string;
  redirectUri?: string;
};

export function App({
  router: appRouter = router,
  convexClient = convex,
  useAuthHook = useAuth,
  workosClientId = import.meta.env.VITE_WORKOS_CLIENT_ID,
  redirectUri = workosRedirectUri,
}: AppProps = {}) {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
        <AuthKitProvider clientId={workosClientId} redirectUri={redirectUri}>
          <ConvexProviderWithAuthKit client={convexClient} useAuth={useAuthHook}>
            <RouterProvider router={appRouter} />
            <Toaster />
          </ConvexProviderWithAuthKit>
        </AuthKitProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
