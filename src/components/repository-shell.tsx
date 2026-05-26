import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { ArchiveIcon, ArrowCounterClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { ArtifactPanel } from "@/components/artifact-panel";
import { TopBar } from "@/components/top-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AppNotice } from "@/components/app-notice";
import { ChatContainer } from "@/components/chat-panel";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { StatusPanel } from "@/components/status-panel";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import { useWorkspacePersistence } from "@/components/chat-shell-shared/use-workspace-persistence";
import { useCheckForUpdates } from "@/hooks/use-check-for-updates";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useRepositoryLifecycle } from "@/hooks/use-repository-lifecycle";
import { useChatMode } from "@/hooks/use-service-mode";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import type {
  ArtifactId,
  ChatMode,
  RepositoryId,
  SandboxModeStatus,
  ThreadId,
  ThreadMode,
  WorkspaceId,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DEFAULT_AUTHENTICATED_PATH,
  discussPath,
  libraryArtifactPath,
  libraryPath,
  modeAwareThreadPath,
  withLibraryAskParam,
  workspacePath,
} from "@/route-paths";

type RepositoryWorkspaceStatus = "initializing" | "ready";
const DESKTOP_LAYOUT_QUERY = "(min-width: 1280px)";

/**
 * Mobile drawer height. 95dvh keeps a 5dvh sliver of the underlying page
 * visible so the user reads "this is a drawer I can dismiss," not "I have
 * navigated to a new screen." `dvh` (not `vh`) accounts for mobile browser
 * chrome — `100vh` would extend behind the URL bar on iOS Safari.
 *
 * Set on `height` directly so the inner flex chain (drawer → wrapper →
 * panel → ScrollArea) inherits a bounded container. Without an explicit
 * height the drawer would size to content and the ScrollArea inside the
 * panel would have no parent to scroll within.
 */
const MOBILE_DRAWER_HEIGHT_CLASS = "h-[95dvh] data-[vaul-drawer-direction=bottom]:max-h-[95dvh]";

/**
 * URL ↔ workspace-state bridge. The route layer (`/chat`, `/w/:workspaceId`,
 * `/w/:workspaceId/t/:threadId`) hands us the params; everything else in the
 * workspace is derived from them so that selection stays a single source of
 * truth and a shareable URL always restores the same view.
 *
 * Resolution order:
 *
 * 1. `urlWorkspaceId` is the highest-priority signal — it identifies which
 *    workspace's chrome we're rendering. Each repo workspace is 1:1 with its
 *    repository, so the repo id resolves *synchronously* by looking the
 *    workspace up in the cached `listWorkspaces` query. This is what kills
 *    the previous workspace-switch flicker: the TopBar can paint the right
 *    repo title from the very first render after a workspace transition,
 *    instead of waiting on `getThreadContext` to tell us which repo this
 *    thread belongs to.
 * 2. `urlThreadId` selects a specific thread within the workspace. When
 *    omitted (`/w/:workspaceId`), the redirect-to-most-recent-thread effect
 *    sends the user to a canonical thread URL.
 * 3. Neither set (`/chat`) → redirect into the most recently used workspace,
 *    which then redirects into its most recent thread.
 * 4. Workspace exists but has no threads → render the empty state with the
 *    dual CTA.
 *
 * `activeWorkspaceId` (state) is no longer the primary driver; it carries the
 * "last known good" workspace id used as a fallback for the workspaceless
 * `/chat` route and for first-paint before Convex hydrates. The URL is the
 * source of truth whenever it carries a workspace id, and a small effect
 * keeps `activeWorkspaceId` (plus its localStorage mirror and the DB
 * preference) in sync with whichever workspace the URL is showing.
 */
export function RepositoryShell({
  urlWorkspaceId,
  urlThreadId,
}: {
  urlWorkspaceId: WorkspaceId | null;
  urlThreadId: ThreadId | null;
}) {
  const navigate = useNavigate();
  const repositories = useQuery(api.repositories.listRepositories);

  // Workspace state — DB is the source of truth, localStorage is a
  // first-paint cache. See `useWorkspacePersistence` and
  // `docs/workspace-persistence-system-design.md` for the full reasoning.
  const { workspaces, touchWorkspace, activeWorkspaceId, currentWorkspaceId, currentWorkspace, handleSwitchWorkspace } =
    useWorkspacePersistence({ urlWorkspaceId, navigate });

  // Live id sets for the `useStorageGC` sweep (passed through the bundle).
  // Composer drafts are thread-scoped; the GC sweep needs the full owner set
  // (capped at 1000 by the query) so a thread deleted in another tab gets
  // its draft localStorage reaped on the next subscription tick.
  const ownerThreadIds = useQuery(api.chat.threads.listAllOwnerThreadIds, {});
  const liveWorkspaceIds = useMemo(
    () => (workspaces ? new Set(workspaces.map((w) => w._id as string)) : null),
    [workspaces],
  );
  const liveRepositoryIds = useMemo(
    () => (repositories ? new Set(repositories.map((r) => r._id as string)) : null),
    [repositories],
  );
  const liveThreadIds = useMemo(
    () => (ownerThreadIds ? new Set(ownerThreadIds.map((id) => id as string)) : null),
    [ownerThreadIds],
  );

  // RepositoryShell is mounted by Chat and Discuss. The redirect must
  // scope to threads of the mode the user is currently in, otherwise a
  // Library Ask thread (persisted as `mode: "library"`) would be the
  // "most recent thread" returned to the discuss-page landing and the
  // user would silently end up rendering an Ask thread inside the
  // Discuss chat panel. Library has its own shell and never routes
  // through here.
  //
  // `mode` is URL-derived (or `null` on transient URLs like
  // `/chat`, `/w/:wid`, `/w/:wid/t/:tid`); we use it to gate chrome that
  // should only appear once the URL settles on a canonical mode path.
  // `intendedChatMode` is what the workspace *should* land in once the
  // canonicalising redirect resolves. Resolution order:
  //
  //   1. URL-derived `mode` — wins whenever the URL has settled on
  //      a canonical mode path. The user is unambiguously *in* that mode.
  //   2. Workspace's `lastMode` — the mode the user was last in
  //      inside this workspace, persisted by the record-on-settle effect
  //      below. This is what makes "Archive → back to chat" return the
  //      user to the mode they came from, instead of bouncing them to the
  //      workspace's structural default.
  //   3. `availability.defaultMode` — the resolver's structural
  //      pick for a workspace with no recorded user preference yet (e.g.
  //      a freshly imported repo lands in library).
  //   4. Hard fallback to "discuss" — only hits before `availability`
  //      hydrates; the loading gate in the redirect effect blocks the
  //      Tier 2 navigation until availability lands, so this is just a
  //      defensive default for the chrome filter.
  //
  // The `lastMode` step is also gated on availability: if the
  // workspace was last in "library" but the repo has since been detached,
  // library is no longer available and we should fall through to the
  // structural default instead of redirecting to a mode the user cannot
  // actually use.
  const { mode, availability } = useChatMode(currentWorkspaceId);
  const intendedChatMode = useMemo<ChatMode>(() => {
    if (mode) return mode;
    const lastMode = currentWorkspace?.lastMode ?? null;
    const lastModeAvailable = lastMode ? (availability?.modes[lastMode].enabled ?? false) : false;
    if (lastModeAvailable && lastMode) return lastMode;
    return availability?.defaultMode ?? "discuss";
  }, [mode, currentWorkspace?.lastMode, availability]);

  // `useThreadCapabilities` bridges the resolver-side ChatModeResolver /
  // ThreadContextResolver into the UI's mode/capability shape. Lives here
  // (not inside the shared lifecycle bundle) so consumers further down can
  // reference `capabilities` without forcing a giant render-order reshuffle.
  const capabilities = useThreadCapabilities(urlThreadId);

  // The right-rail ArtifactPanel — repo-scoped folder tree plus
  // sandbox-backed launchers — surfaces in Library Mode and in Discuss
  // Mode when a repository is attached (so the user can browse artifacts
  // alongside the chat). The toggle button, the desktop column, the
  // mobile drawer, and the keyboard shortcut all gate on this single
  // flag so the surface and its affordances stay consistent.
  //
  // The transient-URL case (`mode === null`, e.g. `/w/:wid` and the
  // legacy `/w/:wid/t/:tid`) falls through to `false` so the chrome
  // does not flash through the canonicalising redirect.
  const isArtifactPanelEnabled = mode === "library" || (mode === "discuss" && capabilities.attachedRepository !== null);

  // Loaded for the redirect-to-most-recent-thread logic: scope by the
  // *intended* mode (URL-derived when settled, otherwise the workspace's
  // remembered `lastMode` or the resolver-supplied default) so the redirect
  // lands on a thread the user expects to see in the destination mode.
  // Skipped once a thread is selected (we already have what we need).
  const ownerThreads = useQuery(
    api.chat.threads.listThreads,
    urlThreadId === null && currentWorkspaceId !== null
      ? { workspaceId: currentWorkspaceId, mode: intendedChatMode }
      : "skip",
  );

  const [threadToDelete, setThreadToDelete] = useState<ThreadId | null>(null);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showPermanentDeleteDialog, setShowPermanentDeleteDialog] = useState(false);
  // This shell only renders Discuss — Library has its own page
  // (`pages/library.tsx`). The chat mode is therefore always
  // `"discuss"`. Per-message grounding is the dimension the user
  // controls; `groundLibrary` / `groundSandbox` below.
  const chatMode: ChatMode = "discuss";

  // Discuss-mode per-message grounding toggles. State is keyed by
  // `threadId` so that opening a thread seeds the toggles with that
  // thread's `defaultGround*` snapshot exactly once: subsequent ticks
  // of the capabilities subscription (e.g. a sandbox flip from
  // `provisioning` → `ready`) cannot stomp on the user's mid-session
  // click, because the `threadId` key has not changed. The seeding
  // effect below the chat-shell lifecycle bundle re-seeds on genuine
  // thread switches (different `urlThreadId`, including `null` → id).
  const [groundingByThread, setGroundingByThread] = useState<{
    threadId: ThreadId | null;
    library: boolean;
    sandbox: boolean;
  }>({ threadId: urlThreadId, library: false, sandbox: false });
  const groundLibrary = groundingByThread.library;
  const groundSandbox = groundingByThread.sandbox;
  const setGroundLibrary = useCallback(
    (next: boolean) => setGroundingByThread((prev) => ({ ...prev, library: next })),
    [],
  );
  const setGroundSandbox = useCallback(
    (next: boolean) => setGroundingByThread((prev) => ({ ...prev, sandbox: next })),
    [],
  );
  const [actionError, setActionError] = useState<string | null>(null);
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
  const [isArtifactPanelOpen, setIsArtifactPanelOpen] = useLocalStorageBoolean("systify.artifactPanel.open", false);
  const [isArtifactSheetOpen, setIsArtifactSheetOpen] = useState(false);
  // Generate System Design dialog state. Mounted at the bottom of the shell
  // (gated on `effectiveSelectedRepositoryId`) so the GroundingToggleBar's
  // `library_no_artifact` CTA can pop it open. Same pattern as
  // `src/pages/library.tsx`.
  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  // StatusPanel surfaces on demand from the top-bar pill: a Popover overlay on
  // desktop, a bottom Drawer (Vaul) on mobile. Both surfaces share a single
  // open state so toggling the pill behaves identically across breakpoints.
  // State is intentionally not persisted — a returning user lands on a clean
  // chat surface instead of a panel they didn't open.
  const [isStatusOpen, setIsStatusOpen] = useState(false);
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
      // overlay doesn't hang around when the layout switches to a drawer
      // (and vice versa). The artifact panel's desktop state is persisted
      // and stays open; only the mobile drawer variant is reset on the way up.
      setIsStatusOpen(false);
      if (event.matches) {
        setIsArtifactSheetOpen(false);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  /*
   * Repo id is derived synchronously from the cached `listWorkspaces` query
   * by looking up the workspace named in the URL. Workspaces are 1:1 with
   * their bound repository, so this lookup is unambiguous. Doing it from
   * the already-cached query — instead of waiting on `getThreadContext` to
   * forward `attachedRepository.id` — is what lets the TopBar paint the
   * right title from the very first render after a workspace transition.
   *
   * `currentWorkspace` itself is resolved up near `currentWorkspaceId` so
   * the redirect logic above can read its `lastMode`; we only derive the
   * repo id from it here, where the chrome consumers expect.
   */
  const effectiveSelectedRepositoryId: RepositoryId | null = currentWorkspace?.repositoryId ?? null;

  // Close dialog states when repository changes so they can't stay open
  // for a different repository.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsGenerateDialogOpen(false);
  }, [effectiveSelectedRepositoryId]);

  const effectiveSelectedThreadId: ThreadId | null = urlThreadId;

  // Keep messages + active-stream subscriptions open for the most recently
  // viewed threads so switching between them is instant and live-reactive.
  // Convex de-duplicates subscriptions by (query, args), so this shares the
  // subscription with `ChatContainer`'s `useQuery` for the active thread.
  const recentThreadIds = useRecentThreads(effectiveSelectedThreadId);
  useWarmThreadSubscriptions(recentThreadIds);

  const repoDetail = useQuery(
    api.repositories.getRepositoryDetail,
    effectiveSelectedRepositoryId ? { repositoryId: effectiveSelectedRepositoryId } : "skip",
  );
  const isRepoMissing = effectiveSelectedRepositoryId !== null && repoDetail === null;
  const isRepoArchived = repoDetail !== null && repoDetail !== undefined && repoDetail.isArchived;
  const isRepositorySyncing =
    !isRepoArchived &&
    (repoDetail?.repository.importStatus === "queued" || repoDetail?.repository.importStatus === "running");
  const effectiveSandboxModeStatus: SandboxModeStatus | null =
    effectiveSelectedThreadId !== null ? capabilities.sandboxModeStatus : (repoDetail?.sandboxModeStatus ?? null);

  /*
   * URL canonicalisation. Two redirect tiers, both `replace` so the back
   * button skips the intermediate URLs:
   *
   *   1. `/chat` → `/w/:currentWorkspaceId`. Once we know which workspace
   *      the user is in (from `activeWorkspaceId`, hydrated from the DB
   *      preference + localStorage cache), promote them onto a workspace
   *      URL so subsequent navigation stays inside the canonical scheme.
   *
   *   2. `/w/:workspaceId` (no thread) → canonical mode URL for the
   *      workspace's intended service mode:
   *        - discuss → `/w/:wid/discuss/:mostRecent`, or the bare
   *          `/w/:wid/discuss` when the workspace has no discuss thread
   *        - library → `/w/:wid/library` (with optional `?ask=:tid` for
   *          the most recent ask thread)
   *      Going straight to the mode-aware URL — instead of the legacy
   *      mode-agnostic `/w/:wid/t/:tid` — keeps `useChatMode`'s value
   *      stable across the redirect: it stays `null` while the URL is on
   *      `/w/:wid` and settles on the canonical mode-derived value the
   *      moment we land. Without this, the chrome would briefly paint
   *      mode-dependent surfaces (StatusPill, ArtifactPanel) when
   *      availability resolved a non-discuss default, then unpaint when
   *      the redirect dropped onto a legacy URL that surfaces the
   *      "discuss" placeholder — the flash this comment exists to
   *      prevent.
   *
   * The two are written as one effect — sequencing them across two
   * effects with overlapping dependencies invited render-loop bugs when
   * the threads query was loading.
   */
  useEffect(() => {
    if (urlThreadId !== null) {
      return;
    }
    if (urlWorkspaceId === null) {
      // Workspaceless URLs (`/chat`, `/chat/:threadId`) don't mount this
      // shell — the workspaceless route group lives on `WorkspacelessChatShell`.
      // A null URL here only happens in tests that exercise the persistence
      // hook in isolation; nothing to canonicalise.
      return;
    }
    // Workspace landing to canonical mode URL. Wait for both
    // inputs the mode decision depends on:
    //   - `availability` — `intendedChatMode` falls back to "discuss"
    //     while this is undefined, which would land repo-attached
    //     workspaces in the wrong default and then re-redirect once
    //     availability hydrated (visible double-jump).
    //   - `currentWorkspace` — same risk for `lastMode`: a stored
    //     "library" pick would be ignored on first paint and the user
    //     would briefly see the structural default before bouncing.
    // Skip on `workspaces === undefined` (still loading) but not on
    // `currentWorkspace === null` (loaded, no row) — the latter means the
    // URL workspace id is stale and the URL-validation effect above will
    // bounce us out.
    if (availability === undefined) return;
    if (workspaces === undefined) return;
    // Wait for the thread list before deciding so we promote onto the most
    // recent thread when there is one. The library branch also needs this
    // because the bare `/w/:wid/library` landing should deep-link to the
    // most recent Ask thread when one exists — without the wait, an
    // unresolved `ownerThreads` would silently strip the `?ask=:tid`
    // param.
    if (ownerThreads === undefined) return;
    // Every service mode redirects off the bare `/w/:wid` landing so the
    // user always settles on a canonical mode URL. Library lands on its
    // artifact overview. Discuss lands on its most recent thread when
    // one exists; when the workspace has none, the bare `/w/:wid`
    // landing still redirects onto the bare mode URL (`/w/:wid/discuss`)
    // so a remembered discuss `lastMode` settles the user *in that
    // mode* (its empty state) instead of being stranded on the mode-less
    // `/w/:wid`, which falls back to the structural default (library for
    // a repo-attached workspace).
    if (intendedChatMode === "library") {
      const askThreadId = ownerThreads[0]?._id;
      const base = libraryPath(urlWorkspaceId);
      const target = askThreadId ? withLibraryAskParam(base, askThreadId) : base;
      void navigate(target, { replace: true });
      return;
    }
    const tid = ownerThreads[0]?._id;
    if (tid) {
      void navigate(discussPath(urlWorkspaceId, tid), { replace: true });
      return;
    }
    // No discuss thread yet — drop onto the bare `/w/:wid/discuss` so the
    // empty state can render. Once already there, stay put.
    if (mode === null) {
      void navigate(discussPath(urlWorkspaceId), { replace: true });
    }
  }, [
    navigate,
    ownerThreads,
    urlWorkspaceId,
    urlThreadId,
    activeWorkspaceId,
    mode,
    intendedChatMode,
    availability,
    workspaces,
  ]);

  /*
   * Record the URL's settled service mode on the workspace so the next
   * `/chat` → `/w/:wid` redirect lands the user back in the mode they
   * were last using. Fires only when:
   *   - the URL has settled on a canonical mode (`mode !== null`,
   *     not a transient `/chat` / `/w/:wid` / `/w/:wid/t/:tid` stop), and
   *   - the workspace row's stored mode is stale (different from URL).
   * The second guard collapses the optimistic-update echo to a single
   * write: after `touchWorkspace` runs, the local cache reflects the
   * new mode immediately, the effect re-runs, the guard short-circuits,
   * and we don't fire a redundant mutation.
   */
  useEffect(() => {
    if (currentWorkspaceId === null) return;
    if (mode === null) return;
    if (currentWorkspace === null) return;
    if (currentWorkspace.lastMode === mode) return;
    void touchWorkspace({ workspaceId: currentWorkspaceId, mode }).catch(() => {});
  }, [currentWorkspaceId, currentWorkspace, mode, touchWorkspace]);

  // Fall back gracefully when a thread URL points at an entity the viewer no
  // longer owns or that has been deleted. Bounce to the workspace landing
  // (which then forwards to the most recent surviving thread, or renders the
  // empty state). Going via the workspace URL — instead of `/chat` — keeps
  // the user inside the workspace they were just in instead of bouncing them
  // through a workspaceless detour.
  const onMissingThread = useCallback(() => {
    if (urlWorkspaceId !== null) {
      void navigate(workspacePath(urlWorkspaceId), { replace: true });
    } else {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
    }
  }, [navigate, urlWorkspaceId]);
  useThreadDeletionRecovery({
    urlThreadId,
    isMissingThread: capabilities.isMissingThread,
    onMissingThread,
  });

  // Check GitHub for new remote commits on tab-focus and repo-switch.
  useCheckForUpdates(effectiveSelectedRepositoryId);

  /*
   * `isAboutToRedirect` signals that the URL is on a transient stop along
   * the canonicalisation chain — a workspace URL waiting for the redirect
   * to settle on a canonical mode URL. The bare `/w/:wsId` landing
   * (`mode === null`) is always transient — the redirect sends it onward
   * to a mode URL regardless of thread count. A mode URL with no thread
   * (`/w/:wsId/discuss`) is only transient while it still has a thread to
   * promote onto; once `ownerThreads` resolves empty it is a settled surface
   * (the mode's empty state), not a redirect stop.
   */
  const isAboutToRedirect =
    urlThreadId === null &&
    urlWorkspaceId !== null &&
    (mode === null || ownerThreads === undefined || ownerThreads.length > 0);

  const workspaceStatus: RepositoryWorkspaceStatus =
    isRepositoriesLoading || workspaces === undefined || isAboutToRedirect ? "initializing" : "ready";

  const isChatShellLoading =
    workspaceStatus === "initializing" || (effectiveSelectedThreadId !== null && capabilities.isLoading);

  const handleSelectThread = useCallback(
    (threadId: ThreadId | null, threadMode: ThreadMode) => {
      setActionError(null);
      if (threadId === null) {
        // Drop selection but keep the user inside the current workspace
        // when one is known — the workspace-landing redirect will then
        // promote them onto the most recent surviving thread. Without a
        // workspace context, fall back to `/chat`.
        if (currentWorkspaceId !== null) {
          void navigate(workspacePath(currentWorkspaceId));
        } else {
          void navigate(DEFAULT_AUTHENTICATED_PATH);
        }
        return;
      }
      // The sidebar only surfaces threads for the current workspace, so
      // pairing the selected thread with `currentWorkspaceId` is correct.
      // Every callsite supplies the thread's stored mode (sidebar rows
      // carry the full Doc, freshly-created threads carry the mode through
      // the mutation return value), so we route straight to the canonical
      // mode-aware URL without ever bouncing through `LegacyThreadRedirect`.
      // If we ever surface cross-workspace thread links (e.g. global
      // search), this is the place to plumb the originating workspace id
      // through the callback signature.
      if (currentWorkspaceId !== null) {
        void navigate(modeAwareThreadPath(currentWorkspaceId, threadId, threadMode));
      } else {
        // Defensive: if a thread is selected before any workspace is known,
        // bounce to /chat so the canonicalising redirects can route us in.
        // Should not happen in practice — the sidebar requires a workspace
        // to render thread rows in the first place.
        void navigate(DEFAULT_AUTHENTICATED_PATH);
      }
    },
    [navigate, currentWorkspaceId],
  );

  const handleToggleArtifactPanel = useCallback(() => {
    if (!isArtifactPanelEnabled) {
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
  }, [isArtifactPanelEnabled, isDesktopLayout, setIsArtifactPanelOpen]);

  /**
   * Setter for the StatusPanel open state, shared by Radix Popover (desktop)
   * and Vaul Drawer (mobile) so onOpenChange callbacks plug in directly.
   * Carries the mobile-only mutual exclusion: opening the status drawer
   * closes the artifact drawer so two bottom-sheet backdrops never stack.
   * Desktop has no mutual exclusion — the popover overlays the chat without
   * affecting the inline artifact column.
   */
  const handleSetStatusOpen = useCallback(
    (open: boolean) => {
      if (!isArtifactPanelEnabled) {
        // Force-closed when the artifact panel surface is hidden — never
        // opens, but allow `false` so a controlled popover/drawer can
        // collapse cleanly during the transition back to the empty state.
        if (open) return;
        setIsStatusOpen(false);
        return;
      }
      if (open && !isDesktopLayout) {
        setIsArtifactSheetOpen(false);
      }
      setIsStatusOpen(open);
    },
    [isDesktopLayout, isArtifactPanelEnabled],
  );

  /**
   * Citation jump from chat (`[A#]` click) → Library Read. The Library route
   * is the single canonical long-form artifact surface.
   */
  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      if (currentWorkspaceId === null) {
        return;
      }
      void navigate(libraryArtifactPath(currentWorkspaceId, artifactId));
    },
    [navigate, currentWorkspaceId],
  );

  useEffect(() => {
    if (!isArtifactPanelEnabled) {
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
  }, [handleToggleArtifactPanel, isArtifactPanelEnabled]);

  const handleImported = useCallback(
    (_repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId, threadMode: ThreadMode | null) => {
      setActionError(null);
      // The URL→state sync effect will pull `activeWorkspaceId` and the DB
      // preference into agreement with the new workspace once we navigate;
      // we don't need to setState here. Going via the URL also means the
      // post-import landing matches what a regular workspace switch looks
      // like — fewer surfaces to keep coherent.
      //
      // `threadMode` is supplied by `createRepositoryImport`'s
      // `defaultThreadMode` field whenever the backend materialised a
      // default thread, so navigation goes straight to the canonical
      // mode-aware URL. The `null` fallback only fires when the import
      // didn't create one (rare); the workspace-landing redirect picks the
      // canonical mode from there.
      if (threadId && threadMode) {
        void navigate(modeAwareThreadPath(workspaceId, threadId, threadMode));
      } else {
        void navigate(workspacePath(workspaceId));
      }
    },
    [navigate],
  );

  const handleThreadMovedToWorkspace = useCallback(
    (workspaceId: WorkspaceId | null, mode: ThreadMode | null) => {
      if (!workspaceId) {
        return;
      }
      // The thread's workspace binding just changed — typically because the
      // user attached a repository through the AttachRepoMenu and the
      // backend re-homed the thread under that repo's workspace. Update the
      // URL to the new canonical location so the chrome (TopBar, sidebar
      // highlight, repo-scoped panels) re-anchors to the right workspace
      // synchronously. The URL→state sync effect handles the
      // `activeWorkspaceId` and DB-preference updates from there.
      //
      // `mode` rides on the `setThreadRepository` return value, so the
      // redirect lands on the canonical mode-aware URL for the post-move
      // thread mode (an attach often flips `discuss` → `ask` for repo-bound
      // threads). The `null` branch covers the no-thread case — we still
      // want to drop the user into the destination workspace's landing.
      if (urlThreadId !== null && mode) {
        void navigate(modeAwareThreadPath(workspaceId, urlThreadId, mode));
      } else {
        void navigate(workspacePath(workspaceId));
      }
    },
    [navigate, urlThreadId],
  );

  // Replace the URL with the canonical mode-aware path once the lazy first
  // send materialised a thread. `replace: true` is important: the user was on
  // a no-thread URL (`/w/:wid/discuss`) which would otherwise sit in the
  // history and bounce-redirect back here if they hit Back.
  const onAfterCreateThread = useCallback(
    (threadId: ThreadId, threadMode: ChatMode) => {
      if (currentWorkspaceId === null) return;
      void navigate(modeAwareThreadPath(currentWorkspaceId, threadId, threadMode), { replace: true });
    },
    [currentWorkspaceId, navigate],
  );

  // Sidebar "New Thread" forwards to the workspace mode URL (no thread id)
  // instead of pre-creating an orphan thread. The lazy first send turns it
  // into a real thread the moment the user types and sends.
  const handleRequestNewThread = useCallback(() => {
    if (currentWorkspaceId === null) return;
    void navigate(discussPath(currentWorkspaceId));
  }, [currentWorkspaceId, navigate]);

  // Stay inside the current workspace AND the current service mode so the
  // user keeps their context after a thread delete. Routing through `/w/:wid`
  // would land on a transient (mode-less) URL where `intendedChatMode`
  // falls back to `lastMode` or `availability.defaultMode` — the latter
  // is "library" for repo-attached workspaces, so deleting the last Discuss
  // thread would yank the user into Library. Going straight to the
  // mode-specific landing keeps `mode !== null` across the navigation; the
  // empty state for the mode renders if no threads of that mode remain.
  const onAfterDeleteThread = useCallback(() => {
    if (currentWorkspaceId !== null) {
      if (mode === "library") {
        void navigate(libraryPath(currentWorkspaceId));
      } else if (mode === "discuss") {
        void navigate(discussPath(currentWorkspaceId));
      } else {
        void navigate(workspacePath(currentWorkspaceId));
      }
    } else {
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    }
  }, [currentWorkspaceId, mode, navigate]);

  const {
    chatInput,
    setChatInput,
    isSending,
    handleSendMessage,
    isCancellingReply,
    handleCancelInFlightReply,
    isDeletingThread,
    handleDeleteThread,
  } = useChatShellLifecycle({
    urlThreadId,
    workspaceId: currentWorkspaceId,
    chatMode,
    groundLibrary,
    groundSandbox,
    liveWorkspaceIds,
    liveRepositoryIds,
    liveThreadIds,
    threadToDelete,
    setActionError,
    setThreadToDelete,
    onAfterCreateThread,
    onAfterDeleteThread,
  });

  // Re-seed Discuss grounding toggles when the URL thread changes. Depends on
  // `capabilities.defaultGround*` so the effect lives below the lifecycle
  // bundle. The `groundingByThread.threadId === urlThreadId` guard limits
  // re-seeds to one per thread switch — capability ticks (e.g. a sandbox
  // flip from `provisioning` → `ready`) within the same thread don't stomp
  // on the user's mid-session toggle clicks.
  useEffect(() => {
    if (groundingByThread.threadId === urlThreadId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGroundingByThread({
      threadId: urlThreadId,
      // `null` thread id means the bare `/w/:wid/discuss` landing; we
      // have no per-thread defaults to seed from, so start both off.
      library: urlThreadId === null ? false : capabilities.defaultGroundLibrary,
      sandbox: urlThreadId === null ? false : capabilities.defaultGroundSandbox,
    });
  }, [urlThreadId, capabilities.defaultGroundLibrary, capabilities.defaultGroundSandbox, groundingByThread.threadId]);

  const groundingState = availability?.grounding;
  // Keep the Library toggle in lockstep with availability — flipping it
  // back off when the artifact gate closes prevents a stale `true`
  // sending a doomed `groundLibrary: true` mutation.
  useEffect(() => {
    if (groundingState && !groundingState.library.enabled && groundLibrary) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroundLibrary(false);
    }
  }, [groundingState, groundLibrary, setGroundLibrary]);
  useEffect(() => {
    if (groundingState && !groundingState.sandbox.enabled && groundSandbox) {
      // Same rationale as the library auto-flip-off above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroundSandbox(false);
    }
  }, [groundingState, groundSandbox, setGroundSandbox]);

  const {
    isSyncing,
    handleSync,
    isArchivingRepo,
    handleArchiveRepo,
    isRestoringRepo,
    handleRestoreRepo,
    isPermanentDeletingRepo,
    handlePermanentDeleteRepo,
  } = useRepositoryLifecycle({
    selectedRepositoryId: effectiveSelectedRepositoryId,
    setActionError,
    setShowArchiveDialog,
    setShowPermanentDeleteDialog,
    onAfterArchiveRepo: () => {
      // Bounce out of the workspace entirely — the repo (and therefore the
      // workspace's chrome) is no longer the active surface for the user.
      // The /chat → fallback-workspace redirect chain picks the next viable
      // workspace from `listWorkspaces`.
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    },
    onAfterRestoreRepo: () => {
      // No navigation — the user stays on the workspace URL and the banner
      // disappears reactively as `repoDetail.isArchived` flips back to false.
    },
    onAfterPermanentDeleteRepo: () => {
      // Same reasoning as archive: the workspace ceases to be relevant once
      // the repo is gone, so route out and let the redirect chain pick the
      // next workspace.
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    },
  });

  // The chat surface is identical across breakpoints — only the layout
  // container (Resizable group on desktop, none on mobile) differs.
  // Defining ChatContainer once and reusing it in both branches prevents
  // prop drift between desktop and mobile renders. React still unmounts
  // and remounts on a breakpoint switch (different parent), but that
  // only happens when the viewport actually crosses 1280px.
  const chatReadOnlyHint = isRepoArchived ? "Restore this repository to send messages or run analyses." : undefined;

  const chatContainerNode = (
    <ChatContainer
      selectedThreadId={effectiveSelectedThreadId}
      workspaceId={currentWorkspaceId}
      isShellLoading={isChatShellLoading}
      chatInput={chatInput}
      setChatInput={setChatInput}
      chatMode={chatMode}
      groundLibrary={groundLibrary}
      groundSandbox={groundSandbox}
      setGroundLibrary={setGroundLibrary}
      setGroundSandbox={setGroundSandbox}
      grounding={availability?.grounding}
      onOpenGenerateSystemDesign={() => setIsGenerateDialogOpen(true)}
      isSending={isSending}
      onSendMessage={handleSendMessage}
      onCancelInFlightReply={handleCancelInFlightReply}
      isCancellingReply={isCancellingReply}
      sandboxModeStatus={effectiveSandboxModeStatus}
      isSyncing={isSyncing || isRepositorySyncing}
      onSync={() => void handleSync()}
      isArtifactPanelOpen={isDesktopLayout ? isArtifactPanelOpen : isArtifactSheetOpen}
      onToggleArtifactPanel={handleToggleArtifactPanel}
      showArtifactToggle={isArtifactPanelEnabled}
      hasAttachedRepository={capabilities.attachedRepository !== null}
      availableRepositories={repositories ?? []}
      onImported={handleImported}
      onThreadMovedToWorkspace={handleThreadMovedToWorkspace}
      onSelectArtifact={handleSelectArtifact}
      isReadOnly={isRepoArchived}
      readOnlyHint={chatReadOnlyHint}
      repositoryId={capabilities.attachedRepository?.id}
    />
  );

  return (
    <>
      <AppSidebarLeft
        repositories={repositories}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSwitchWorkspace={handleSwitchWorkspace}
        selectedThreadId={effectiveSelectedThreadId}
        onSelectThread={handleSelectThread}
        onDeleteThread={setThreadToDelete}
        onRequestNewThread={handleRequestNewThread}
        onImported={handleImported}
        onError={setActionError}
      />

      <SidebarInset>
        <TopBar
          repoDetail={repoDetail ?? undefined}
          isSyncing={isSyncing || isRepositorySyncing}
          isStatusPanelOpen={isStatusOpen}
          onSetStatusPanelOpen={handleSetStatusOpen}
          onArchiveRepo={() => setShowArchiveDialog(true)}
          onRestoreRepo={() => void handleRestoreRepo()}
          onPermanentDeleteRepo={() => setShowPermanentDeleteDialog(true)}
          threadId={effectiveSelectedThreadId}
          attachedRepository={capabilities.attachedRepository}
          isAttachedRepositoryLoading={capabilities.isLoading}
          availableRepositories={repositories ?? []}
          onThreadMovedToWorkspace={handleThreadMovedToWorkspace}
          isDesktopLayout={isDesktopLayout}
          onSync={() => void handleSync()}
          onViewArtifact={handleSelectArtifact}
          showSystemStatus={isArtifactPanelEnabled}
        />

        {isRepoArchived ? (
          <div className="border-b border-border bg-muted/40 px-6 py-3">
            <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <ArchiveIcon size={18} weight="bold" className="mt-0.5 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">This repository is archived</p>
                  <p className="text-xs text-muted-foreground">
                    Threads and artifacts stay readable. Restore to continue chatting and run analyses.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={isRestoringRepo}
                onClick={() => void handleRestoreRepo()}
              >
                <ArrowCounterClockwiseIcon weight="bold" />
                {isRestoringRepo ? "Restoring…" : "Restore"}
              </Button>
            </div>
          </div>
        ) : null}

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
         * Shown regardless of which right-rail panel is open. Hidden when
         * archived because the import-failed state is no longer actionable
         * until the user restores.
         *
         * `latestFailedImportError` is computed in `getRepositoryDetail` —
         * the UI deliberately doesn't know about the jobs table or which
         * pointer to follow (the `latestImportJobId` pointer is only written
         * on successful completion and is the wrong source for failures).
         */}
        {!isRepoArchived && repoDetail?.repository.importStatus === "failed" ? (
          <ImportFailedBanner
            errorMessage={repoDetail.latestFailedImportError}
            isSyncing={isSyncing || isRepositorySyncing}
            onRetry={() => void handleSync()}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          {isRepoMissing ? (
            <RepositoryMissingState onBack={() => void navigate(DEFAULT_AUTHENTICATED_PATH)} />
          ) : (
            <>
              {chatContainerNode}
              {isDesktopLayout && isArtifactPanelEnabled ? (
                // Status lives in the top-bar Popover, so the inline rail is
                // owned exclusively by the artifact panel — both surfaces can
                // stay open at once. Width scales up at 2xl so mermaid diagrams
                // and code blocks don't need horizontal scroll. Width (not
                // transform) is animated so chat reflows alongside the panel
                // — `will-change: width` keeps the 200ms toggle composited.
                //
                // Discuss mode opts out of the artifact panel entirely — see
                // `isArtifactPanelEnabled` above for the rationale.
                <div
                  aria-hidden={!isArtifactPanelOpen}
                  data-state={isArtifactPanelOpen ? "open" : "closed"}
                  className="shrink-0 overflow-hidden border-l border-border motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none will-change-[width] data-[state=closed]:w-0 data-[state=closed]:border-l-0 xl:data-[state=open]:w-96 2xl:data-[state=open]:w-md"
                >
                  <div className="h-full xl:w-96 2xl:w-md">
                    <ArtifactPanel
                      threadId={effectiveSelectedThreadId}
                      repositoryId={effectiveSelectedRepositoryId}
                      artifacts={repoDetail?.artifacts}
                      hasAttachedRepository={capabilities.attachedRepository !== null}
                      sandboxModeStatus={capabilities.sandboxModeStatus}
                      isVisible={isArtifactPanelOpen}
                      className="flex h-full w-full border-l-0"
                      onOpenInReader={handleSelectArtifact}
                    />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </SidebarInset>

      {!isDesktopLayout && isArtifactPanelEnabled ? (
        <Drawer open={isArtifactSheetOpen} onOpenChange={setIsArtifactSheetOpen} aria-label="artifact-drawer">
          {/*
           * Fixed height (rather than Vaul snap points) so the inner flex
           * chain has a bounded container — without this, the panel's
           * internal ScrollArea has nothing to scroll within and tall
           * content gets clipped at the bottom of the viewport.
           */}
          <DrawerContent className={cn(MOBILE_DRAWER_HEIGHT_CLASS, "rounded-t-2xl")}>
            <DrawerTitle className="sr-only">Results and artifacts</DrawerTitle>
            <DrawerDescription className="sr-only">
              Persistent results and artifacts for the current conversation and attached repository.
            </DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col">
              <ArtifactPanel
                threadId={effectiveSelectedThreadId}
                repositoryId={effectiveSelectedRepositoryId}
                artifacts={repoDetail?.artifacts}
                hasAttachedRepository={capabilities.attachedRepository !== null}
                sandboxModeStatus={capabilities.sandboxModeStatus}
                isVisible={isArtifactSheetOpen}
                className="flex h-full w-full border-l-0"
                onOpenInReader={(artifactId) => {
                  handleSelectArtifact(artifactId);
                  setIsArtifactSheetOpen(false);
                }}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}

      {!isDesktopLayout && repoDetail && isArtifactPanelEnabled ? (
        <Drawer open={isStatusOpen} onOpenChange={handleSetStatusOpen} aria-label="status-drawer">
          <DrawerContent className={cn(MOBILE_DRAWER_HEIGHT_CLASS, "rounded-t-2xl")}>
            <DrawerTitle className="sr-only">Repository status</DrawerTitle>
            <DrawerDescription className="sr-only">
              Current sync, sandbox, and analysis state, with recent activity and operation launchers.
            </DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col">
              <StatusPanel
                repository={repoDetail.repository}
                sandboxModeStatus={repoDetail.sandboxModeStatus}
                sandbox={repoDetail.sandbox}
                jobs={repoDetail.jobs}
                artifacts={repoDetail.artifacts}
                hasRemoteUpdates={repoDetail.hasRemoteUpdates}
                isSyncing={isSyncing || isRepositorySyncing}
                onSync={() => void handleSync()}
                onViewArtifact={handleSelectArtifact}
                onClose={() => setIsStatusOpen(false)}
              />
            </div>
          </DrawerContent>
        </Drawer>
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
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
        title="Archive repository"
        description="The repository disappears from your workspaces. Threads, messages, and artifacts are preserved — sandboxes are stopped to free resources. Restore any time from your archive."
        actionLabel="Archive repository"
        loadingLabel="Archiving…"
        isPending={isArchivingRepo}
        onConfirm={() => void handleArchiveRepo()}
      />

      <ConfirmDialog
        open={showPermanentDeleteDialog}
        onOpenChange={setShowPermanentDeleteDialog}
        title="Permanently delete repository?"
        description="This will permanently delete this repository and all its threads, messages, analysis artifacts, jobs, and indexed files. This action cannot be undone."
        actionLabel="Delete permanently"
        loadingLabel="Deleting…"
        isPending={isPermanentDeletingRepo}
        onConfirm={() => void handlePermanentDeleteRepo()}
      />

      {effectiveSelectedRepositoryId ? (
        <GenerateSystemDesignDialog
          open={isGenerateDialogOpen}
          onOpenChange={setIsGenerateDialogOpen}
          repositoryId={effectiveSelectedRepositoryId}
        />
      ) : null}
    </>
  );
}

function RepositoryMissingState({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <h2 className="text-base font-semibold text-foreground">This repository is unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been deleted, or you no longer have access to it.
        </p>
        <Button type="button" variant="default" size="sm" className="mt-5" onClick={onBack}>
          Back to chat
        </Button>
      </div>
    </div>
  );
}

function ImportFailedBanner({
  errorMessage,
  isSyncing,
  onRetry,
}: {
  errorMessage: string | null;
  isSyncing: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col border-b border-destructive/40 bg-destructive/5 px-6 py-3 text-destructive">
      {/*
       * The alert region is scoped to the headline + retry button only.
       * Putting the Accordion inside an `aria-live="assertive"` region
       * makes screen readers re-announce the whole banner every time the
       * user toggles "Error details", which is noisy and not actionable.
       */}
      <div role="alert" aria-live="assertive" aria-atomic="true" className="flex items-start gap-2">
        <WarningCircleIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Repository import failed</p>
          <p className="mt-0.5 text-xs leading-5">
            The latest sync did not finish. Retry to restore repo-aware features for this workspace.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          disabled={isSyncing}
          onClick={onRetry}
        >
          {isSyncing ? "Retrying…" : "Retry sync"}
        </Button>
      </div>
      {errorMessage ? (
        <Accordion type="single" collapsible className="mt-1 ml-7">
          <AccordionItem value="details" className="border-b-0">
            <AccordionTrigger className="py-1 text-[11px] font-semibold tracking-wider uppercase text-destructive/80 hover:text-destructive hover:no-underline">
              Error details
            </AccordionTrigger>
            <AccordionContent className="pt-1.5 pb-0">
              <pre className="max-h-48 overflow-auto rounded-sm border border-destructive/20 bg-destructive/10 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words text-destructive">
                {errorMessage}
              </pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}
    </div>
  );
}
