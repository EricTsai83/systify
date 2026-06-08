/* eslint-disable react-refresh/only-export-components */
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";

// Modified to match WorkOS's auth hook structure
type UseAuth = () => {
  isLoading: boolean;
  user: unknown;
  getAccessToken: () => Promise<string | null>;
};

type ConvexAuthStatus = {
  authError: string | null;
};

const AUTH_TOKEN_ERROR_MESSAGE = "Your session could not be validated. Sign in again to reconnect your account.";

const ConvexAuthStatusContext = createContext<ConvexAuthStatus | null>(null);

export function useConvexAuthStatus() {
  const value = useContext(ConvexAuthStatusContext);
  if (value === null) {
    throw new Error("useConvexAuthStatus must be used within ConvexProviderWithAuthKit.");
  }
  return value;
}

/**
 * A wrapper React component which provides a {@link ConvexReactClient}
 * authenticated with WorkOS AuthKit.
 *
 * It must be wrapped by a configured `AuthKitProvider`, from
 * `@workos-inc/authkit-react`.
 *
 * @public
 */
export function ConvexProviderWithAuthKit({
  children,
  client,
  useAuth,
}: {
  children: ReactNode;
  client: ConvexReactClient;
  useAuth: UseAuth;
}) {
  const [authError, setAuthError] = useState<string | null>(null);
  const useAuthFromWorkOS = useUseAuthFromAuthKit(useAuth, setAuthError);
  const authStatus = useMemo(() => ({ authError }), [authError]);

  return (
    <ConvexAuthStatusContext.Provider value={authStatus}>
      <ConvexProviderWithAuth client={client} useAuth={useAuthFromWorkOS}>
        {children}
      </ConvexProviderWithAuth>
    </ConvexAuthStatusContext.Provider>
  );
}

function useUseAuthFromAuthKit(useAuth: UseAuth, setAuthError: (nextError: string | null) => void) {
  return useMemo(
    () =>
      function useAuthFromWorkOS() {
        const { isLoading, user, getAccessToken } = useAuth();

        const fetchAccessToken = useCallback(async () => {
          try {
            const token = await getAccessToken();
            setAuthError(null);
            return token;
          } catch (error) {
            console.error("Error fetching WorkOS access token:", error);
            setAuthError(AUTH_TOKEN_ERROR_MESSAGE);
            return null;
          }
        }, [getAccessToken]);

        return useMemo(
          () => ({
            isLoading,
            isAuthenticated: !!user,
            fetchAccessToken,
          }),
          [isLoading, user, fetchAccessToken],
        );
      },
    [setAuthError, useAuth],
  );
}
