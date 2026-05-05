import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { AppSidebar } from "@/components/app-sidebar";
import { ArtifactPanel } from "@/components/artifact-panel";
import { TopBar } from "@/components/top-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { AppNotice } from "@/components/app-notice";
import { ChatPanel } from "@/components/chat-panel";
import { StatusPanel } from "@/components/status-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useCheckForUpdates } from "@/hooks/use-check-for-updates";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { useRepositoryActions } from "@/hooks/use-repository-actions";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import type { ArtifactId, RepositoryId, ThreadId, WorkspaceId, ChatMode, SandboxModeStatus } from "@/lib/types";
import { toUserErrorMessage } from "@/lib/errors";

type RepositoryWorkspaceStatus = "initializing" | "no-repo" | "ready";
const DESKTOP_LAYOUT_QUERY = "(min-width: 1280px)";

/**
 * Optimistic mirror of the server-side `touchWorkspace` mutation. Defined at
 * module scope (not inside the component) so React's purity rules treat the
 * `Date.now()` call as a runtime concern rather than memoization-time impurity,
 * and so the function reference is stable for `withOptimisticUpdate`.
 *
 * It updates the same two pieces of state the real mutation touches:
 *   1. `userPreferences.lastActiveWorkspaceId` — keeps the canonical
 *      "current workspace" pointer aligned with the user's intent so the
 *      reconciliation effect in `RepositoryShell` doesn't see a stale DB
 *      snapshot during the in-flight window.
 *   2. `workspaces.lastAccessedAt` (with a re-sort) — snaps the sidebar's
 *      most-recent ordering into place immediately. The DB index is
 *      descending on `lastAccessedAt`, so we sort the same way.
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

const DeepAnalysisDialog = lazy(() =>
  import("@/components/deep-analysis-dialog").then((module) => ({ default: module.DeepAnalysisDialog })),
);

/**
 * URL ↔ workspace-state bridge. The route layer (`/chat`, `/t/:threadId`,
 * `/r/:repoId`) hands us the params; everything else in the workspace is
 * derived from them so that selection stays a single source of truth and a
 * shareable URL always restores the same view.
 *
 * Resolution order:
 *
 * 1. `urlThreadId` is the highest-priority hint. The thread's own
 *    `repositoryId` (loaded via `getThreadContext`) drives the repo panel —
 *    repo-less threads show the chat input but no repo-scoped tabs.
 * 2. `urlRepositoryId` (no thread) shows the repo's overview without forcing
 *    a thread selection; the user picks a thread from the sidebar.
 * 3. Neither set (`/chat`) and the user has at least one thread → redirect to
 *    `/t/:mostRecent` so the URL always reflects the visible thread (PRD US 27).
 * 4. Neither set and the user has no threads → render the empty state with
 *    the dual CTA (PRD US 9).
 */
export function RepositoryShell({
  urlThreadId,
  urlRepositoryId,
}: {
  urlThreadId: ThreadId | null;
  urlRepositoryId: RepositoryId | null;
}) {
  const navigate = useNavigate();
  const repositories = useQuery(api.repositories.listRepositories);
  const createThreadMutation = useMutation(api.chat.threads.createThread);

  // -------------------------------------------------------------------------
  // Workspace state — DB is the source of truth, localStorage is a
  // first-paint cache.
  //
  // Resolution order (see docs/workspace-persistence-system-design.md):
  //   1. Render immediately with whatever localStorage has so we avoid a
  //      blank-shell flash while Convex hydrates.
  //   2. When `getViewerPreferences` resolves with a stored
  //      `lastActiveWorkspaceId`, reconcile to the DB value — that is the
  //      canonical "current workspace" and the only thing that survives a
  //      different device or a cleared cache.
  //   3. If the active id is missing or no longer valid (workspace deleted),
  //      fall back to the most-recently-touched workspace, then promote that
  //      pick into the DB so future loads converge instantly.
  // -------------------------------------------------------------------------
  const workspaces = useQuery(api.workspaces.listWorkspaces);
  const viewerPreferences = useQuery(api.userPreferences.getViewerPreferences);
  const initializeWorkspaces = useMutation(api.workspaces.initializeWorkspaces);
  // `touchWorkspace` carries `applyTouchWorkspaceOptimistic` so the local
  // query cache reflects the user's switch the same render they click.
  // Without it, the reconciliation effect below would briefly observe a stale
  // `viewerPreferences` (still pointing at the previous workspace) and bounce
  // the user back. With it, the local query cache and the local React state
  // agree on the new workspace within the same render, which both eliminates
  // the in-flight race and lets us drop the one-shot reconciliation guard so
  // genuine cross-tab pushes propagate live.
  const baseTouchWorkspace = useMutation(api.workspaces.touchWorkspace);
  const touchWorkspace = useMemo(
    () => baseTouchWorkspace.withOptimisticUpdate(applyTouchWorkspaceOptimistic),
    [baseTouchWorkspace],
  );
  const initializationAttemptedRef = useRef(false);

  // First-paint cache. Rendering with this avoids a one-frame flicker before
  // `viewerPreferences` arrives. The cache is *only* trusted until the DB
  // value lands; after that, the DB wins on conflict.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<WorkspaceId | null>(() => {
    try {
      const stored = localStorage.getItem("systify.activeWorkspaceId");
      return stored ? (stored as WorkspaceId) : null;
    } catch {
      return null;
    }
  });

  // Mirror every active-workspace change back into localStorage so the
  // first-paint cache stays warm for the next load. This is best-effort: if
  // the write fails (private mode quota, storage disabled, …), the DB still
  // carries the canonical value.
  useEffect(() => {
    try {
      if (activeWorkspaceId) {
        localStorage.setItem("systify.activeWorkspaceId", activeWorkspaceId);
      } else {
        localStorage.removeItem("systify.activeWorkspaceId");
      }
    } catch {
      // Ignore storage errors.
    }
  }, [activeWorkspaceId]);

  // Auto-initialize or repair the default Home workspace once per load. The
  // mutation is idempotent, so existing users with legacy General workspaces
  // get normalized without a separate migration step.
  useEffect(() => {
    if (workspaces === undefined || initializationAttemptedRef.current) return;
    initializationAttemptedRef.current = true;
    void initializeWorkspaces({});
  }, [workspaces, initializeWorkspaces]);

  // DB-wins reconciliation. Re-runs whenever the DB-side selection changes,
  // which is also the cross-tab live-sync path: a switch in another tab pushes
  // the new `viewerPreferences` row through Convex's subscription, this effect
  // observes the diff, and adopts the new value here. The race that used to
  // need a one-shot ref (a stale `viewerPreferences` arriving after the user's
  // local switch and bouncing them back) is now neutralised by the optimistic
  // update on `touchWorkspace`, which keeps the local query cache aligned with
  // the user's intent during the in-flight window.
  useEffect(() => {
    if (workspaces === undefined || viewerPreferences === undefined) return;
    const dbWorkspaceId = viewerPreferences?.lastActiveWorkspaceId ?? null;
    if (!dbWorkspaceId) return;
    const dbWorkspaceExists = workspaces.some((ws) => ws._id === dbWorkspaceId);
    if (!dbWorkspaceExists) return;
    if (dbWorkspaceId !== activeWorkspaceId) {
      // setState in an effect, but the only practical alternative is to
      // derive `activeWorkspaceId` purely during render, which would require
      // dropping the localStorage-cached first-paint state and re-introducing
      // a flash on every load. The guard above ensures this only fires when
      // the DB and local state actually disagree, so it's a one-shot per
      // genuine cross-tab/cross-device push, not a render loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveWorkspaceId(dbWorkspaceId);
    }
  }, [workspaces, viewerPreferences, activeWorkspaceId]);

  // Auto-select the most recent workspace if none is active or the active
  // one no longer exists (e.g. deleted on another device). We also seed the
  // DB preference here so cross-device convergence works even for users who
  // never explicitly switch — without this, a brand-new browser would pick
  // its own fallback and never publish it as the canonical selection.
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return;
    // Wait for the reconciliation pass before considering fallback so we
    // don't briefly select the wrong workspace and then bounce to the DB
    // value once `viewerPreferences` resolves.
    if (viewerPreferences === undefined) return;
    const activeExists = workspaces.some((ws) => ws._id === activeWorkspaceId);
    if (activeExists) return;
    const fallback = workspaces[0]._id;
    // setState in an effect is normally a smell, but here it's the right tool:
    // the fallback choice depends on async query data (`workspaces`) and on a
    // sibling DB query (`viewerPreferences`), which can't be derived purely
    // during render without re-introducing the original race. The early
    // returns above guarantee at most one setState per workspaces snapshot,
    // and after this fires `activeExists` becomes true on the next run so the
    // effect short-circuits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveWorkspaceId(fallback);
    if (viewerPreferences?.lastActiveWorkspaceId !== fallback) {
      void touchWorkspace({ workspaceId: fallback }).catch(() => {});
    }
  }, [workspaces, viewerPreferences, activeWorkspaceId, touchWorkspace]);

  const handleSwitchWorkspace = useCallback(
    (workspaceId: WorkspaceId) => {
      // Optimistic local update for instant UI; `touchWorkspace` then
      // promotes the same value into the DB inside a single Convex
      // transaction (bumps `lastAccessedAt` *and* writes
      // `userPreferences.lastActiveWorkspaceId` together).
      setActiveWorkspaceId(workspaceId);
      void touchWorkspace({ workspaceId }).catch(() => {});
      // Navigate to /chat so the redirect-to-most-recent-thread logic kicks in
      // for the new workspace.
      void navigate("/chat");
    },
    [navigate, touchWorkspace],
  );

  // useThreadCapabilities is the canonical bridge between the resolver-side
  // ChatModeResolver / ThreadContextResolver and the UI's mode selector.
  // It also forwards the attached repository summary, so we do not need a
  // second `getThreadContext` subscription here.
  const capabilities = useThreadCapabilities(urlThreadId);

  // Loaded only on the no-selection landing (`/chat`) so we can redirect to
  // the most recent thread when one exists. Workspace-scoped when one is active.
  const ownerThreads = useQuery(
    api.chat.threads.listThreads,
    urlThreadId === null && urlRepositoryId === null
      ? activeWorkspaceId
        ? { workspaceId: activeWorkspaceId }
        : {}
      : "skip",
  );

  const [threadToDelete, setThreadToDelete] = useState<ThreadId | null>(null);
  const [showDeleteRepoDialog, setShowDeleteRepoDialog] = useState(false);
  const [analysisPrompt, setAnalysisPrompt] = useState(
    "Summarize the main modules, data flow, and risk areas for this repository.",
  );
  const [chatInput, setChatInput] = useState("");
  // The user's last explicit mode pick, scoped to the thread it was made for.
  // When `urlThreadId` changes, the scope check fails and the effective mode
  // collapses to the new thread's resolver-supplied default — no effect or
  // setState required, so the per-thread default behaviour stays a pure
  // derivation. We also drop the pick if it became unavailable for the same
  // thread (e.g. the user picked `sandbox` and then the sandbox expired).
  const [pickedChatMode, setPickedChatMode] = useState<{
    threadId: ThreadId | null;
    mode: ChatMode;
  } | null>(null);
  const chatMode: ChatMode =
    pickedChatMode &&
    pickedChatMode.threadId === urlThreadId &&
    capabilities.availableModes.includes(pickedChatMode.mode)
      ? pickedChatMode.mode
      : capabilities.defaultMode;
  const setChatMode = useCallback(
    (mode: ChatMode) => {
      setPickedChatMode({ threadId: urlThreadId, mode });
    },
    [urlThreadId],
  );
  const [showAnalysisDialog, setShowAnalysisDialog] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  /**
   * Transient info-level banner — used to confirm async background work was
   * successfully queued (e.g. "Deep analysis queued") even before the next
   * Convex tick reflects the new active job in the deck and timeline. Auto-
   * dismisses on a timer so the surface doesn't accumulate stale notices;
   * any new notice replaces the previous one and resets the timer.
   */
  const [actionNotice, setActionNotice] = useState<{ title: string; message: string } | null>(null);
  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);
  const [isArtifactPanelOpen, setIsArtifactPanelOpen, isArtifactPanelHydrated] = useLocalStorageBoolean(
    "systify.artifactPanel.open",
    true,
  );
  const [isArtifactSheetOpen, setIsArtifactSheetOpen] = useState(false);
  // StatusPanel surfaces on demand from the top-bar pill: a Popover overlay on
  // desktop, a bottom Sheet on mobile. Both surfaces share a single open state
  // so toggling the pill behaves identically across breakpoints. State is
  // intentionally not persisted — a returning user lands on a clean chat
  // surface instead of a panel they didn't open.
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  /**
   * Plan 02 inline citation jump target. Set by `handleSelectArtifact` when
   * the user clicks an `[A#]` citation in an assistant reply; the artifact
   * panel watches this for "scroll into view + transient highlight". See
   * `handleSelectArtifact` below for the full transient highlight lifecycle
   * (open the panel, publish the id, and the consume callback that clears
   * this back to `null` once the highlight animation settles). This value
   * persists across thread changes — `handleSelectThread` does not clear it
   * and there is no `urlThreadId`-keyed cleanup effect. That persistence is
   * acceptable because the artifact panel filters cards by thread, so a
   * stale id from another thread matches no card and renders nothing.
   */
  const [selectedArtifactId, setSelectedArtifactId] = useState<ArtifactId | null>(null);
  const [isDesktopLayout, setIsDesktopLayout] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.matchMedia(DESKTOP_LAYOUT_QUERY).matches;
  });

  const isRepositoriesLoading = repositories === undefined;

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktopLayout(event.matches);
      // Reset the status surface across the breakpoint so a popover-anchored
      // overlay doesn't hang around when the layout switches to a sheet
      // (and vice versa). The artifact panel's desktop state is persisted
      // and stays open; only the mobile sheet variant is reset on the way up.
      setIsStatusOpen(false);
      if (event.matches) {
        setIsArtifactSheetOpen(false);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // /t/:threadId → use thread's repository (if any). /r/:repoId → use the
  // URL repo. /chat → null until the redirect-to-most-recent effect runs.
  const effectiveSelectedRepositoryId: RepositoryId | null =
    urlRepositoryId ?? capabilities.attachedRepository?.id ?? null;

  const effectiveSelectedThreadId: ThreadId | null = urlThreadId;

  const selectedRepoName = repositories?.find(
    (repository: Doc<"repositories">) => repository._id === effectiveSelectedRepositoryId,
  )?.sourceRepoFullName;

  const repoDetail = useQuery(
    api.repositories.getRepositoryDetail,
    effectiveSelectedRepositoryId ? { repositoryId: effectiveSelectedRepositoryId } : "skip",
  );
  const isRepositorySyncing =
    repoDetail?.repository.importStatus === "queued" || repoDetail?.repository.importStatus === "running";
  const effectiveSandboxModeStatus: SandboxModeStatus | null =
    effectiveSelectedThreadId !== null ? capabilities.sandboxModeStatus : (repoDetail?.sandboxModeStatus ?? null);

  // PRD US 27: most recent thread loads on landing. Runs only on `/chat` when
  // the owner has at least one thread; the redirect is `replace` so the user
  // can still hit Back to leave the workspace without bouncing through /chat.
  useEffect(() => {
    if (urlThreadId !== null || urlRepositoryId !== null) {
      return;
    }
    if (!ownerThreads || ownerThreads.length === 0) {
      return;
    }
    void navigate(`/t/${ownerThreads[0]._id}`, { replace: true });
  }, [navigate, ownerThreads, urlRepositoryId, urlThreadId]);

  // Fall back gracefully when a thread URL points at an entity the viewer no
  // longer owns or that has been deleted. Matches the empty-state recovery
  // path so the user sees actionable CTAs instead of a broken workspace.
  useEffect(() => {
    if (urlThreadId === null) {
      return;
    }
    if (capabilities.isMissingThread) {
      void navigate("/chat", { replace: true });
    }
  }, [capabilities.isMissingThread, navigate, urlThreadId]);

  // Check GitHub for new remote commits on tab-focus and repo-switch.
  useCheckForUpdates(effectiveSelectedRepositoryId);

  const messages = useQuery(
    api.chat.threads.listMessages,
    effectiveSelectedThreadId ? { threadId: effectiveSelectedThreadId } : "skip",
  );
  const activeMessageStream = useQuery(
    api.chat.streaming.getActiveMessageStream,
    effectiveSelectedThreadId ? { threadId: effectiveSelectedThreadId } : "skip",
  );

  const isOnLanding = urlThreadId === null && urlRepositoryId === null;
  const isLandingResolving = isOnLanding && (ownerThreads === undefined || ownerThreads.length > 0);

  const workspaceStatus: RepositoryWorkspaceStatus =
    isRepositoriesLoading || isLandingResolving
      ? "initializing"
      : isOnLanding && ownerThreads?.length === 0
        ? "no-repo"
        : effectiveSelectedRepositoryId === null && effectiveSelectedThreadId === null
          ? "no-repo"
          : "ready";

  const isChatLoading =
    workspaceStatus === "initializing" ||
    (effectiveSelectedThreadId !== null && (messages === undefined || capabilities.isLoading));

  const handleSelectThread = useCallback(
    (threadId: ThreadId | null) => {
      setActionError(null);
      setAnalysisError(null);
      if (threadId === null) {
        void navigate("/chat");
      } else {
        void navigate(`/t/${threadId}`);
      }
    },
    [navigate],
  );

  const handleToggleArtifactPanel = useCallback(() => {
    if (workspaceStatus === "no-repo") {
      return;
    }
    if (isDesktopLayout) {
      // Status now overlays via the top-bar popover, so the desktop artifact
      // column is free to coexist — no mutual-exclusion needed.
      setIsArtifactPanelOpen((open) => !open);
      return;
    }
    // Mobile keeps mutual exclusion because two bottom sheets would stack and
    // the second one's backdrop would obscure the first.
    setIsArtifactSheetOpen((open) => {
      const next = !open;
      if (next) {
        setIsStatusOpen(false);
      }
      return next;
    });
  }, [isDesktopLayout, setIsArtifactPanelOpen, workspaceStatus]);

  /**
   * Setter for the StatusPanel open state, shared by Radix Popover (desktop)
   * and Sheet (mobile) so onOpenChange callbacks plug in directly. Carries
   * the mobile-only mutual exclusion: opening the status sheet closes the
   * artifact sheet so two bottom-sheet backdrops never stack. Desktop has no
   * mutual exclusion — the popover overlays the chat without affecting the
   * inline artifact column.
   */
  const handleSetStatusOpen = useCallback(
    (open: boolean) => {
      if (workspaceStatus === "no-repo") {
        // Force-closed in no-repo state — never opens, but allow `false` so a
        // controlled popover/sheet can collapse cleanly during the transition
        // back to the empty state.
        if (open) return;
        setIsStatusOpen(false);
        return;
      }
      if (open && !isDesktopLayout) {
        setIsArtifactSheetOpen(false);
      }
      setIsStatusOpen(open);
    },
    [isDesktopLayout, workspaceStatus],
  );

  /**
   * Plan 02: a user clicked `[A#]` inside an assistant reply. Force the
   * artifact panel open (desktop) or the sheet open (mobile) so the target
   * is visible, then publish the id so the panel can scroll/highlight. The
   * panel calls `onArtifactSelectionConsumed` itself once the highlight
   * animation settles, which clears `selectedArtifactId` back to `null` —
   * we don't need a thread-change cleanup effect because the artifact
   * panel filters by thread, so a stale id from another thread simply
   * matches no card and renders nothing.
   */
  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      if (workspaceStatus === "no-repo") {
        return;
      }
      if (isDesktopLayout) {
        setIsArtifactPanelOpen(true);
        // Close the status popover too so a "View analysis" click from inside
        // the panel hands the focus over to the artifact card without leaving
        // a stale overlay floating above the chat. This is no longer mutual
        // exclusion (status doesn't compete with the artifact column for
        // space) — it's a deliberate handoff for the citation/CTA flow.
        setIsStatusOpen(false);
      } else {
        setIsArtifactSheetOpen(true);
        setIsStatusOpen(false);
      }
      setSelectedArtifactId(artifactId);
    },
    [isDesktopLayout, setIsArtifactPanelOpen, workspaceStatus],
  );

  /**
   * Stable handler the artifact panel calls once the highlight animation
   * finishes. Must be referentially stable across renders: `ArtifactCard`'s
   * scroll-into-view effect lists this callback in its dependency array, and
   * a fresh inline arrow on every parent render would re-fire the effect on
   * every re-render — including the many that happen mid-stream as the
   * `getActiveMessageStream` subscription ticks. That re-firing both
   * re-triggers `scrollIntoView` and reschedules the 1.6s consume timer, so
   * the selection ring would stay visible until streaming stops instead of
   * fading on schedule.
   */
  const handleArtifactSelectionConsumed = useCallback(() => {
    setSelectedArtifactId(null);
  }, []);

  /**
   * Surface 4 follow-up: artifact card "Ask about this …" affordance. We
   * pre-fill the chat input with a templated question so the user can edit
   * before sending; if `docs` mode is available we flip there so the
   * artifact is in scope for the next reply (docs mode auto-includes
   * thread artifacts in the prompt). On mobile we close the artifact sheet
   * so the chat input becomes visible — without that the user would tap
   * the button and see nothing change because the sheet still covers the
   * chat panel.
   *
   * If the user is mid-typing in the chat input, append the prompt rather
   * than overwriting — silently discarding unsent text would feel like
   * stolen work. We use `setChatInput` callback form so we read the latest
   * value and never race a parallel update.
   */
  const handleAskAboutArtifact = useCallback(
    (artifact: Doc<"artifacts">) => {
      const prompt = `Tell me more about "${artifact.title}". What should I take away from it, and what follow-ups should we consider?`;
      setChatInput((current) => (current.trim() ? `${current.trimEnd()}\n\n${prompt}` : prompt));
      if (capabilities.availableModes.includes("docs")) {
        setPickedChatMode({ threadId: urlThreadId, mode: "docs" });
      }
      if (!isDesktopLayout) {
        setIsArtifactSheetOpen(false);
      }
    },
    [capabilities.availableModes, isDesktopLayout, urlThreadId],
  );

  useEffect(() => {
    if (workspaceStatus === "no-repo") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key !== "." || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (target instanceof HTMLElement) {
        if (target.isContentEditable || target.closest('[contenteditable="true"], [role="textbox"], .monaco-editor')) {
          return;
        }
      }

      event.preventDefault();
      handleToggleArtifactPanel();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleToggleArtifactPanel, workspaceStatus]);

  const handleImported = useCallback(
    (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => {
      setActionError(null);
      setAnalysisError(null);
      setActiveWorkspaceId(workspaceId);
      void touchWorkspace({ workspaceId }).catch(() => {});

      if (threadId) {
        void navigate(`/t/${threadId}`);
      } else {
        void navigate(`/r/${repoId}`);
      }
    },
    [navigate, touchWorkspace],
  );

  const handleThreadMovedToWorkspace = useCallback(
    (workspaceId: WorkspaceId | null) => {
      if (!workspaceId) {
        return;
      }
      setActiveWorkspaceId(workspaceId);
      void touchWorkspace({ workspaceId }).catch(() => {});
    },
    [touchWorkspace],
  );

  // Empty-state CTA: create a no-repo thread and navigate into it (PRD US 1
  // and US 9). We intentionally let the backend choose the repo-less default
  // mode so the empty-state CTA stays in lockstep with `chat.createThread`;
  // the user can attach a repo later via
  // AttachRepoMenu, at which point the mode selector unlocks `docs` and
  // potentially `sandbox`. Errors surface in the workspace's standard
  // `actionError` slot.
  const [isStartingConversation, handleStartConversation] = useAsyncCallback(
    useCallback(async () => {
      setActionError(null);
      try {
        const newThreadId = await createThreadMutation({
          workspaceId: activeWorkspaceId ?? undefined,
        });
        void navigate(`/t/${newThreadId}`);
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to start a conversation."));
      }
    }, [createThreadMutation, navigate, activeWorkspaceId]),
  );

  const {
    isSending,
    handleSendMessage,
    isCancellingReply,
    handleCancelInFlightReply,
    isRunningAnalysis,
    handleRunAnalysis,
    isSyncing,
    handleSync,
    isDeletingThread,
    handleDeleteThread,
    isDeletingRepo,
    handleDeleteRepo,
  } = useRepositoryActions({
    selectedRepositoryId: effectiveSelectedRepositoryId,
    selectedThreadId: effectiveSelectedThreadId,
    threadToDelete,
    analysisPrompt,
    chatInput,
    chatMode,
    setChatInput,
    setActionError,
    setAnalysisError,
    setActionNotice,
    onAfterDeleteThread: () => {
      // After deletion the thread no longer exists. Send the user back to the
      // landing so the redirect-to-most-recent or empty-state logic re-resolves.
      void navigate("/chat");
    },
    onAfterDeleteRepo: () => {
      void navigate("/chat");
    },
    setThreadToDelete,
    setShowDeleteRepoDialog,
    setShowAnalysisDialog,
  });

  return (
    <>
      <AppSidebar
        repositories={repositories}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSwitchWorkspace={handleSwitchWorkspace}
        selectedThreadId={effectiveSelectedThreadId}
        onSelectThread={handleSelectThread}
        onDeleteThread={setThreadToDelete}
        onImported={handleImported}
        onError={setActionError}
      />

      <SidebarInset>
        <TopBar
          repoDetail={repoDetail}
          repoName={selectedRepoName}
          isSyncing={isSyncing || isRepositorySyncing}
          isStatusPanelOpen={isStatusOpen}
          onSetStatusPanelOpen={handleSetStatusOpen}
          onDeleteRepo={() => setShowDeleteRepoDialog(true)}
          threadId={effectiveSelectedThreadId}
          attachedRepository={capabilities.attachedRepository}
          availableRepositories={repositories ?? []}
          onThreadMovedToWorkspace={handleThreadMovedToWorkspace}
          isDesktopLayout={isDesktopLayout}
          onSync={() => void handleSync()}
          onRunAnalysis={() => {
            if (!repoDetail || repoDetail.sandboxModeStatus.reasonCode !== "available") {
              return;
            }
            setAnalysisError(null);
            setShowAnalysisDialog(true);
          }}
          onViewArtifact={handleSelectArtifact}
        />

        {actionError ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice title="Action failed" message={actionError} tone="error" />
          </div>
        ) : actionNotice ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice title={actionNotice.title} message={actionNotice.message} tone="info" />
          </div>
        ) : null}

        {/*
         * Import-failed banner. The only state we proactively surface above
         * the chat — sync/sandbox/update statuses live in the StatusPill
         * because the user can keep working around them, but a failed
         * import means the repo is genuinely unusable until it is retried.
         * Shown regardless of which right-rail panel is open.
         */}
        {repoDetail?.repository.importStatus === "failed" ? (
          <div className="border-b border-destructive/40 bg-destructive/5 px-6 py-3">
            <AppNotice
              title="Repository import failed"
              message="The latest sync did not finish. Retry to restore repo-aware features for this workspace."
              tone="error"
              actionLabel={isSyncing || isRepositorySyncing ? "Retrying…" : "Retry sync"}
              actionDisabled={isSyncing || isRepositorySyncing}
              onAction={() => void handleSync()}
            />
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          {workspaceStatus === "no-repo" ? (
            <EmptyState
              onStartConversation={() => void handleStartConversation()}
              onImported={handleImported}
              isStartingConversation={isStartingConversation}
            />
          ) : (
            <>
              <ChatPanel
                selectedThreadId={effectiveSelectedThreadId}
                messages={messages}
                activeMessageStream={activeMessageStream}
                isChatLoading={isChatLoading}
                chatInput={chatInput}
                setChatInput={setChatInput}
                chatMode={chatMode}
                setChatMode={setChatMode}
                availableModes={capabilities.availableModes}
                disabledModeReasons={capabilities.disabledReasons}
                isSending={isSending}
                onSendMessage={handleSendMessage}
                onCancelInFlightReply={handleCancelInFlightReply}
                isCancellingReply={isCancellingReply}
                sandboxModeStatus={effectiveSandboxModeStatus}
                isSyncing={isSyncing || isRepositorySyncing}
                onSync={() => void handleSync()}
                isArtifactPanelOpen={isDesktopLayout ? isArtifactPanelOpen : isArtifactSheetOpen}
                onToggleArtifactPanel={handleToggleArtifactPanel}
                showArtifactToggle
                hasAttachedRepository={capabilities.attachedRepository !== null}
                availableRepositories={repositories ?? []}
                onImported={handleImported}
                onThreadMovedToWorkspace={handleThreadMovedToWorkspace}
                onSelectArtifact={handleSelectArtifact}
                analysisNudge={
                  // Only nudge when there is genuinely something to do: a repo
                  // is attached, no deep-analysis artifact exists yet, no
                  // analysis is currently running, and the sandbox is ready
                  // (otherwise the CTA would just bounce off the dialog's
                  // disabled state). The card stays out of the way once any
                  // of those conditions flips so the empty state declutters
                  // as the user advances.
                  repoDetail &&
                  !repoDetail.artifacts.some((artifact) => artifact.kind === "deep_analysis") &&
                  !repoDetail.activeDeepAnalysisJob &&
                  repoDetail.sandboxModeStatus.reasonCode === "available"
                    ? {
                        onStart: () => {
                          setAnalysisError(null);
                          setShowAnalysisDialog(true);
                        },
                      }
                    : null
                }
              />
              {isDesktopLayout ? (
                // The desktop right rail is now a single inline column for
                // artifacts. Status lives in the top-bar Popover, so the two
                // surfaces no longer compete for this slot — Artifacts can
                // stay open while the user opens Status, and vice versa.
                <div
                  aria-hidden={!(isArtifactPanelHydrated && isArtifactPanelOpen)}
                  data-state={isArtifactPanelHydrated && isArtifactPanelOpen ? "open" : "closed"}
                  className="shrink-0 overflow-hidden border-l border-border transition-[width] duration-300 ease-out data-[state=closed]:w-0 data-[state=closed]:border-l-0 data-[state=open]:w-80"
                >
                  <div className="h-full w-80">
                    <ArtifactPanel
                      threadId={effectiveSelectedThreadId}
                      repositoryArtifacts={repoDetail?.artifacts}
                      hasAttachedRepository={capabilities.attachedRepository !== null}
                      sandboxModeStatus={capabilities.sandboxModeStatus}
                      isVisible={isArtifactPanelHydrated && isArtifactPanelOpen}
                      className="h-full w-80 border-l-0 lg:flex"
                      selectedArtifactId={selectedArtifactId}
                      onArtifactSelectionConsumed={handleArtifactSelectionConsumed}
                      onAskAboutArtifact={handleAskAboutArtifact}
                    />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </SidebarInset>

      {workspaceStatus !== "no-repo" && !isDesktopLayout ? (
        <Sheet open={isArtifactSheetOpen} onOpenChange={setIsArtifactSheetOpen}>
          <SheetContent side="bottom" className="h-[min(75vh,34rem)] rounded-t-2xl border-x border-t p-0" hideClose>
            <SheetTitle className="sr-only">Results and artifacts</SheetTitle>
            <SheetDescription className="sr-only">
              Persistent results and artifacts for the current conversation and attached repository.
            </SheetDescription>
            <ArtifactPanel
              threadId={effectiveSelectedThreadId}
              repositoryArtifacts={repoDetail?.artifacts}
              hasAttachedRepository={capabilities.attachedRepository !== null}
              sandboxModeStatus={capabilities.sandboxModeStatus}
              isVisible={isArtifactSheetOpen}
              className="flex h-full w-full border-l-0"
              selectedArtifactId={selectedArtifactId}
              onArtifactSelectionConsumed={handleArtifactSelectionConsumed}
              onAskAboutArtifact={handleAskAboutArtifact}
            />
          </SheetContent>
        </Sheet>
      ) : null}

      {workspaceStatus !== "no-repo" && !isDesktopLayout && repoDetail ? (
        <Sheet open={isStatusOpen} onOpenChange={handleSetStatusOpen}>
          <SheetContent side="bottom" className="h-[min(75vh,34rem)] rounded-t-2xl border-x border-t p-0" hideClose>
            <SheetTitle className="sr-only">Repository status</SheetTitle>
            <SheetDescription className="sr-only">
              Current sync, sandbox, and analysis state, with recent activity and operation launchers.
            </SheetDescription>
            <StatusPanel
              repository={repoDetail.repository}
              sandboxModeStatus={repoDetail.sandboxModeStatus}
              sandbox={repoDetail.sandbox}
              jobs={repoDetail.jobs}
              activeDeepAnalysisJob={repoDetail.activeDeepAnalysisJob}
              artifacts={repoDetail.artifacts}
              hasRemoteUpdates={repoDetail.hasRemoteUpdates}
              isSyncing={isSyncing || isRepositorySyncing}
              onSync={() => void handleSync()}
              onRunAnalysis={() => {
                if (repoDetail.sandboxModeStatus?.reasonCode !== "available") {
                  return;
                }
                setAnalysisError(null);
                setShowAnalysisDialog(true);
              }}
              onViewArtifact={handleSelectArtifact}
              onClose={() => setIsStatusOpen(false)}
            />
          </SheetContent>
        </Sheet>
      ) : null}

      <ConfirmDialog
        open={threadToDelete !== null}
        onOpenChange={(open) => !open && setThreadToDelete(null)}
        title="Delete thread"
        description="This will permanently delete this thread and all its messages. This action cannot be undone."
        actionLabel="Delete thread"
        loadingLabel="Deleting…"
        isPending={isDeletingThread}
        onConfirm={() => void handleDeleteThread()}
      />

      <ConfirmDialog
        open={showDeleteRepoDialog}
        onOpenChange={setShowDeleteRepoDialog}
        title="Delete repository"
        description="This will permanently delete this repository and all its threads, messages, analysis artifacts, jobs, and indexed files. This action cannot be undone."
        actionLabel="Delete repository"
        loadingLabel="Deleting…"
        isPending={isDeletingRepo}
        onConfirm={() => void handleDeleteRepo()}
      />

      {showAnalysisDialog ? (
        <Suspense fallback={<DeepAnalysisDialogSkeleton />}>
          <DeepAnalysisDialog
            open={showAnalysisDialog}
            onOpenChange={(open) => {
              setShowAnalysisDialog(open);
              if (!open) {
                setAnalysisError(null);
              }
            }}
            analysisPrompt={analysisPrompt}
            onAnalysisPromptChange={setAnalysisPrompt}
            sandboxModeStatus={
              effectiveSandboxModeStatus ?? {
                reasonCode: "missing_sandbox",
                message: "A live sandbox is unavailable right now. Sync the repository to provision a fresh sandbox.",
              }
            }
            errorMessage={analysisError}
            isRunning={isRunningAnalysis}
            onRun={handleRunAnalysis}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function DeepAnalysisDialogSkeleton() {
  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deep analysis</DialogTitle>
          <DialogDescription>Loading the analysis workspace…</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
