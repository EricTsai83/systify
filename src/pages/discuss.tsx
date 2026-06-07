import { useParams } from "react-router-dom";
import { RepositoryShell } from "@/components/repository-shell";
import type { RepositoryId, ThreadId } from "@/lib/types";
import { NEW_DISCUSS_THREAD_SEGMENT } from "@/route-paths";

/**
 * Discuss service mode entry point.
 *
 * Mounted at:
 *   - `/r/:repositoryId/discuss`              → repository landing.
 *   - `/r/:repositoryId/discuss/new`          → lazy-create draft.
 *   - `/r/:repositoryId/discuss/:threadId`    → canonical thread URL.
 */
export function DiscussPage() {
  const params = useParams<{ repositoryId?: string; threadId?: string }>();
  const urlRepositoryId = (params.repositoryId ?? null) as RepositoryId | null;
  const isNewThreadRoute = params.threadId === NEW_DISCUSS_THREAD_SEGMENT;
  const urlThreadId = isNewThreadRoute ? null : ((params.threadId ?? null) as ThreadId | null);

  return (
    <RepositoryShell urlRepositoryId={urlRepositoryId} urlThreadId={urlThreadId} isNewThreadRoute={isNewThreadRoute} />
  );
}
