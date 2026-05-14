import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { AppSidebar } from "@/components/app-sidebar";
import { LibraryShell } from "@/components/library-shell";
import { ScreenState } from "@/components/screen-state";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useLibraryTabs } from "@/hooks/use-library-tabs";
import {
  DEFAULT_AUTHENTICATED_PATH,
  discussPath,
  libraryPath,
  withLibraryAskParam,
  workspacePath,
  workspaceThreadPath,
} from "@/route-paths";
import type { ArtifactId, RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";
import { toast } from "sonner";

const ACTIVE_WORKSPACE_STORAGE_KEY = "systify.activeWorkspaceId";

/**
 * Three-mode restructure — Library service mode entry point.
 *
 * Mounted at:
 *   - `/w/:workspaceId/library`               → folder overview, no
 *                                               artifact open.
 *   - `/w/:workspaceId/library/a/:artifactId` → shell with the artifact
 *                                               open in the active tab.
 *
 * The active Library Ask thread is carried as a `?ask=:threadId` query
 * param on either of those URLs — the Ask panel is always visible, so the
 * thread is secondary view-state rather than its own route. The legacy
 * `/library/ask/:threadId` route redirects to the `?ask=` form.
 *
 * Library needs neither a chat subscription nor sandbox SDK tooling, so
 * the page deliberately does NOT mount the heavy RepositoryShell. We
 * reconstruct just the workspace chrome (sidebar + workspace switcher,
 * both reused) plus the Library shell.
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
  const params = useParams<{ workspaceId?: string; artifactId?: string }>();
  const [searchParams] = useSearchParams();
  const urlWorkspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const urlArtifactId = (params.artifactId ?? null) as ArtifactId | null;
  const urlAskThreadId = (searchParams.get("ask") ?? null) as ThreadId | null;

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
      <LibraryWorkspace workspaceId={urlWorkspaceId} artifactId={urlArtifactId} askThreadId={urlAskThreadId} />
    </SidebarProvider>
  );
}

/**
 * Inner shell that owns the workspace activation effect and renders the
 * Library shell. Split from the outer page so {@link SidebarProvider} can
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
  const [, setSearchParams] = useSearchParams();

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

  // The Library tab strip drives both the document column (LibraryShell)
  // and the Ask panel's artifact context (the sidebar). State is owned
  // here and handed to both. It mounts ahead of the repo-guard redirect
  // below — that is the hooks rule, and the redirect's unmount cleanly
  // cancels this hook's debounced URL write.
  const tabs = useLibraryTabs(workspaceId, artifactId);

  const handleSwitchWorkspace = useCallback(
    (id: WorkspaceId) => {
      void navigate(workspacePath(id));
    },
    [navigate],
  );

  // Set or clear the `?ask=:threadId` query param while keeping the
  // current pathname (and any `?open=` the tab strip owns) intact. The
  // functional updater reads the live params, so this never clobbers a
  // concurrent `useLibraryTabs` write. `replace` is opt-in: an explicit
  // user thread pick is a navigation worth keeping in history; a
  // validity-guard clear is not.
  const handleSelectLibraryThread = useCallback(
    (threadId: ThreadId | null, options?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (threadId) {
            next.set("ask", threadId);
          } else {
            next.delete("ask");
          }
          return next;
        },
        { replace: options?.replace ?? false },
      );
    },
    [setSearchParams],
  );

  const handleRailError = useCallback((message: string | null) => {
    if (!message) return;
    toast.error(message);
  }, []);
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
  // the editor against a broken row. Preserve `?ask=` — the bad artifact
  // says nothing about the validity of the active Ask thread.
  const artifactProbe = useQuery(api.artifacts.getById, artifactId ? { artifactId } : "skip");
  useEffect(() => {
    if (!artifactId) return;
    if (workspaces === undefined || !currentWorkspace || !repositoryId) return;
    if (artifactProbe === undefined) return;
    if (artifactProbe === null || artifactProbe.repositoryId !== repositoryId) {
      void navigate(withLibraryAskParam(libraryPath(workspaceId), askThreadId), { replace: true });
    }
  }, [artifactId, artifactProbe, askThreadId, currentWorkspace, navigate, repositoryId, workspaceId, workspaces]);

  // Guard against a stale `?ask=` — a since-deleted thread, or one from
  // another workspace. `getThreadSummary` returns `null` instead of
  // throwing (unlike `listMessages`), so a bad bookmark clears the param
  // gracefully rather than crashing the Ask panel into the route error
  // boundary. Mirrors the artifact-id guard above; replaces history so
  // the dead URL does not linger in the back stack.
  const askThreadProbe = useQuery(api.chat.threads.getThreadSummary, askThreadId ? { threadId: askThreadId } : "skip");
  useEffect(() => {
    if (!askThreadId) return;
    if (askThreadProbe === undefined) return;
    if (askThreadProbe === null || askThreadProbe.workspaceId !== workspaceId || askThreadProbe.mode !== "ask") {
      handleSelectLibraryThread(null, { replace: true });
    }
  }, [askThreadId, askThreadProbe, handleSelectLibraryThread, workspaceId]);

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
        variant="libraryAsk"
        askThreadId={askThreadId}
        activeArtifactId={tabs.activeArtifactId}
        onSelectArtifact={tabs.openTab}
        onSelectAskThread={handleSelectLibraryThread}
        onImported={handleImported}
        onError={handleRailError}
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
          {repositoryId ? <LibraryShell repositoryId={repositoryId} tabs={tabs} /> : null}
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
