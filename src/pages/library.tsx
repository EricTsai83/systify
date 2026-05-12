import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { AppSidebar } from "@/components/app-sidebar";
import { LibraryShell } from "@/components/library-shell";
import { ScreenState } from "@/components/screen-state";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  DEFAULT_AUTHENTICATED_PATH,
  discussPath,
  libraryPath,
  libraryAskPath,
  workspacePath,
  workspaceThreadPath,
} from "@/route-paths";
import type { ArtifactId, RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";

const ACTIVE_WORKSPACE_STORAGE_KEY = "systify.activeWorkspaceId";

/**
 * Three-mode restructure — Library service mode entry point.
 *
 * Mounted at:
 *   - `/w/:workspaceId/library`                    → folder overview
 *                                                    placeholder.
 *   - `/w/:workspaceId/library/a/:artifactId`      → IDE shell with the
 *                                                    artifact open in
 *                                                    the active tab.
 *   - `/w/:workspaceId/library/ask/:threadId`      → Library Ask panel
 *                                                    (Phase 2 wires the
 *                                                    UI; Phase 1 routes
 *                                                    to a placeholder).
 *
 * Library Read needs neither a chat subscription nor sandbox SDK
 * tooling, so the page deliberately does NOT mount the heavy
 * RepositoryShell. We reconstruct just the workspace chrome (sidebar
 * + workspace switcher, both reused) plus the Library IDE.
 *
 * Two cost-transparency invariants the page honours:
 *
 *   1. Entering Library NEVER provisions a sandbox. The Library shell
 *      doesn't even import the chat panel that would attempt a sandbox
 *      lease.
 *   2. The page guards against entering Library for a workspace
 *      without an attached repo / artifact — the resolver-level check
 *      in `useServiceMode` greys the Library button out, but a direct
 *      URL hit from a browser bookmark still needs a graceful redirect
 *      to Discuss.
 */
export function LibraryPage() {
  const params = useParams<{ workspaceId?: string; artifactId?: string; threadId?: string }>();
  const urlWorkspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const urlArtifactId = (params.artifactId ?? null) as ArtifactId | null;
  const urlThreadId = (params.threadId ?? null) as ThreadId | null;

  if (!urlWorkspaceId) {
    return (
      <ScreenState
        title="Missing workspace"
        description="The link is missing a workspace id. Return to your chat to continue."
      />
    );
  }

  return (
    <SidebarProvider>
      <LibraryWorkspace workspaceId={urlWorkspaceId} artifactId={urlArtifactId} askThreadId={urlThreadId} />
    </SidebarProvider>
  );
}

/**
 * Inner shell that owns the workspace activation effect and renders the
 * Library IDE. Split from the outer page so {@link SidebarProvider} can
 * mount before any sidebar-aware hook runs.
 */
function LibraryWorkspace({
  workspaceId,
  artifactId,
  askThreadId,
}: {
  workspaceId: WorkspaceId;
  artifactId: ArtifactId | null;
  askThreadId: ThreadId | null;
}) {
  const navigate = useNavigate();
  const [isAskOpen, setIsAskOpen] = useState(askThreadId !== null);
  const repositories = useQuery(api.repositories.listRepositories);
  const workspaces = useQuery(api.workspaces.listWorkspaces);
  const baseTouchWorkspace = useMutation(api.workspaces.touchWorkspace);
  const touchWorkspace = useMemo(
    () => baseTouchWorkspace.withOptimisticUpdate(applyTouchWorkspaceOptimistic),
    [baseTouchWorkspace],
  );

  // Persist workspace activity so re-entering /chat lands the user back
  // on this workspace. Mirrors the RepositoryShell behaviour without
  // pulling in its 1000+ line state graph.
  useEffect(() => {
    if (!workspaceId) return;
    try {
      window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
    } catch {
      // Storage denied — DB still owns the canonical pointer.
    }
    void touchWorkspace({ workspaceId }).catch(() => {});
  }, [touchWorkspace, workspaceId]);

  const currentWorkspace = useMemo(
    () => workspaces?.find((ws) => ws._id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );
  const repositoryId = currentWorkspace?.repositoryId ?? null;

  const handleSwitchWorkspace = useCallback(
    (id: WorkspaceId) => {
      void navigate(workspacePath(id));
    },
    [navigate],
  );

  const handleSelectThread = useCallback(
    (threadId: ThreadId | null) => {
      if (threadId === null) {
        void navigate(workspacePath(workspaceId));
        return;
      }
      // From the Library shell, picking a thread bounces back to the
      // canonical thread URL — the workspace shell then routes the user
      // to the right service mode based on the thread's persisted mode.
      // Phase 3 will add the thread-mode → service-mode redirect.
      void navigate(workspaceThreadPath(workspaceId, threadId));
    },
    [navigate, workspaceId],
  );

  const handleImported = useCallback(
    (_repoId: RepositoryId, threadId: ThreadId | null, importedWorkspaceId: WorkspaceId) => {
      if (threadId) {
        void navigate(workspaceThreadPath(importedWorkspaceId, threadId));
      } else {
        void navigate(libraryPath(importedWorkspaceId));
      }
    },
    [navigate],
  );

  // Library only renders when the workspace has a repository attached
  // (and at least one artifact, but the shell itself paints a useful
  // empty state if the artifact list comes back empty). For workspaces
  // without a repo, route the user to Discuss — a stale bookmark
  // should land them somewhere usable rather than on a permanently
  // empty Library.
  useEffect(() => {
    if (workspaces === undefined || currentWorkspace === undefined) return;
    if (currentWorkspace === null) {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
      return;
    }
    if (!repositoryId) {
      void navigate(discussPath(workspaceId), { replace: true });
    }
  }, [currentWorkspace, repositoryId, workspaces, navigate, workspaceId]);

  // If the URL carries an artifact id but it is missing / not in this
  // workspace, drop back to the Library landing rather than mounting
  // the editor against a broken row.
  const artifactProbe = useQuery(api.artifacts.getById, artifactId ? { artifactId } : "skip");
  useEffect(() => {
    if (!artifactId) return;
    if (workspaces === undefined || !currentWorkspace || !repositoryId) return;
    if (artifactProbe === undefined) return;
    if (artifactProbe === null || artifactProbe.repositoryId !== repositoryId) {
      void navigate(libraryPath(workspaceId), { replace: true });
    }
  }, [artifactId, artifactProbe, currentWorkspace, navigate, repositoryId, workspaceId, workspaces]);

  if (workspaces === undefined || repositories === undefined) {
    return <ScreenState title="Loading…" description="Loading your workspace." isLoading />;
  }

  return (
    <>
      <AppSidebar
        repositories={repositories}
        workspaces={workspaces}
        activeWorkspaceId={workspaceId}
        onSwitchWorkspace={handleSwitchWorkspace}
        selectedThreadId={null}
        onSelectThread={handleSelectThread}
        onDeleteThread={() => {
          /* Library doesn't surface threads for deletion — handled in chat. */
        }}
        onImported={handleImported}
        onError={() => {
          /* Errors from the sidebar's import dialog bubble through Sonner; Library has no banner slot of its own yet. */
        }}
      />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
          <SidebarTrigger />
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground md:text-base">
            {currentWorkspace?.name ?? "Library"}
          </h1>
          <span className="shrink-0 text-[11px] text-muted-foreground">Read Only</span>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">
          {repositoryId ? (
            <LibraryShell
              workspaceId={workspaceId}
              repositoryId={repositoryId}
              activeArtifactId={artifactId}
              isAskOpen={isAskOpen || askThreadId !== null}
              askThreadId={askThreadId}
              onOpenAsk={() => setIsAskOpen(true)}
              onCloseAsk={() => {
                setIsAskOpen(false);
                if (askThreadId) {
                  void navigate(libraryPath(workspaceId));
                }
              }}
              onAskThreadCreated={(threadId) => {
                setIsAskOpen(true);
                void navigate(libraryAskPath(workspaceId, threadId));
              }}
            />
          ) : null}
        </div>
      </SidebarInset>
    </>
  );
}

/**
 * Optimistic mirror for `touchWorkspace`. Same behaviour as the helper
 * in `repository-shell.tsx`; duplicated here so the Library page does
 * not have to import the heavy shell just to reuse one helper.
 */
function applyTouchWorkspaceOptimistic(store: OptimisticLocalStore, args: { workspaceId: Id<"workspaces"> }) {
  const now = Date.now();
  for (const { args: queryArgs } of store.getAllQueries(api.userPreferences.getViewerPreferences)) {
    store.setQuery(api.userPreferences.getViewerPreferences, queryArgs, {
      lastActiveWorkspaceId: args.workspaceId,
      lastActiveWorkspaceUpdatedAt: now,
    });
  }
  for (const { args: queryArgs, value } of store.getAllQueries(api.workspaces.listWorkspaces)) {
    if (value === undefined) continue;
    const updated = value
      .map((ws) => (ws._id === args.workspaceId ? { ...ws, lastAccessedAt: now } : ws))
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    store.setQuery(api.workspaces.listWorkspaces, queryArgs, updated);
  }
}
