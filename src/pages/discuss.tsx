import { useParams } from "react-router-dom";
import { RepositoryShell } from "@/components/repository-shell";
import type { RepositoryId, ThreadId } from "@/lib/types";

/**
 * Discuss service mode entry point.
 *
 * Mounted at:
 *   - `/r/:repositoryId/discuss`              → repository landing.
 *   - `/r/:repositoryId/discuss/:threadId`    → canonical thread URL.
 */
export function DiscussPage() {
  const params = useParams<{ repositoryId?: string; threadId?: string }>();
  const urlRepositoryId = (params.repositoryId ?? null) as RepositoryId | null;
  const urlThreadId = (params.threadId ?? null) as ThreadId | null;

  return <RepositoryShell urlRepositoryId={urlRepositoryId} urlThreadId={urlThreadId} />;
}
