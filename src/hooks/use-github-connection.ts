import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useGitHubConnection() {
  const status = useQuery(api.github.getGitHubConnectionStatus);

  return {
    isLoading: status === undefined,
    isConnected: status?.isConnected ?? false,
    installationId: status?.installationId ?? null,
    accountLogin: status?.accountLogin ?? null,
    repositorySelection: status?.repositorySelection ?? null,
    installationStatus: status?.installationStatus ?? null,
    isSuspended: status?.installationStatus === "suspended",
  };
}
