import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import { ArchiveIcon, ArrowCounterClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { AppSidebar } from "@/components/app-sidebar";
import { ArtifactPanel } from "@/components/artifact-panel";
import { TopBar } from "@/components/top-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { AppNotice } from "@/components/app-notice";
import { ChatContainer } from "@/components/chat-panel";
import { StatusPanel } from "@/components/status-panel";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useCheckForUpdates } from "@/hooks/use-check-for-updates";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useRepositoryActions } from "@/hooks/use-repository-actions";
import { useServiceMode } from "@/hooks/use-service-mode";
import { useStorageGC } from "@/hooks/use-storage-gc";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import type {
  ArtifactId,
  RepositoryId,
  ServiceMode,
  ThreadId,
  WorkspaceId,
  ChatMode,
  SandboxModeStatus,
} from "@/lib/types";
import { toUserErrorMessage } from "@/lib/errors";
import { readString, removeKey, writeString } from "@/lib/storage";
import { cn } from "@/lib/utils";
import {
  DEFAULT_AUTHENTICATED_PATH,
  discussPath,
  labPath,
  libraryArtifactPath,
  libraryPath,
  modeAwareThreadPath,
  withLibraryAskParam,
  workspacePath,
  workspaceThreadPath,
  type ThreadMode,
} from "@/route-paths";

type RepositoryWorkspaceStatus = "initializing" | "no-repo" | "ready";
const DESKTOP_LAYOUT_QUERY = "(min-width: 1280px)";

/**
 * Service-mode → thread-mode mapping for the workspace-landing
 * most-recent-thread query. Each service mode owns one thread mode
 * (Discuss → discuss threads, Library → ask threads, Lab → lab threads);
 * the workspace shell scopes the listThreads query by the *intended*
 * service mode (URL-derived when on a canonical mode path, otherwise
 * `availability.defaultServiceMode`) so the redirect lands on a thread
 * the user expects to see in the destination mode.
 */
const SERVICE_MODE_TO_REDIRECT_THREAD_MODE: Record<ServiceMode, "discuss" | "ask" | "lab"> = {
  discuss: "discuss",
  library: "ask",
  lab: "lab",
};

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

const ACTIVE_WORKSPACE_STORAGE_KEY = "systify.activeWorkspaceId";

/**
 * Optimistic mirror of the server-side `touchWorkspace` mutation. Defined at
 * module scope (not inside the component) so React's purity rules treat the
 * `Date.now()` call as a runtime concern rather than memoization-time impurity,
 * and so the function reference is stable for `withOptimisticUpdate`.
 *
 * It updates the same three pieces of state the real mutation touches:
 *   1. `userPreferences.lastActiveWorkspaceId` — keeps the canonical
 *      "current workspace" pointer aligned with the user's intent so the
 *      reconciliation effect in `RepositoryShell` doesn't see a stale DB
 *      snapshot during the in-flight window.
 *   2. `workspaces.lastAccessedAt` (with a re-sort) — snaps the sidebar's
 *      most-recent ordering into place immediately. The DB index is
 *      descending on `lastAccessedAt`, so we sort the same way.
 *   3. `workspaces.lastServiceMode` (when provided) — lets the Tier 2
 *      workspace-landing redirect read the user's just-picked mode on the
 *      same render without waiting for the server roundtrip. Without this,
 *      a fast Archive → back round-trip would still race the network and
 *      send the user to the workspace's structural default mode on first
 *      paint, then re-redirect once the server-side update propagated.
 */
function applyTouchWorkspaceOptimistic(
  store: OptimisticLocalStore,
  args: { workspaceId: Id<"workspaces">; serviceMode?: ServiceMode },
) {
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
      .map((ws) =>
        ws._id === args.workspaceId
          ? {
              ...ws,
              lastAccessedAt: now,
              ...(args.serviceMode !== undefined ? { lastServiceMode: args.serviceMode } : {}),
            }
          : ws,
      )
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    store.setQuery(api.workspaces.listWorkspaces, queryArgs, updated);
  }
}

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
 *    sends the user to a canonical thread URL. PRD #19 user story 27.
 * 3. Neither set (`/chat`) → redirect into the most recently used workspace,
 *    which then redirects into its most recent thread.
 * 4. Workspace exists but has no threads → render the empty state with the
 *    dual CTA. PRD #19 user story 9.
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
    const stored = readString(ACTIVE_WORKSPACE_STORAGE_KEY);
    return stored ? (stored as WorkspaceId) : null;
  });

  // Mirror every active-workspace change back into localStorage so the
  // first-paint cache stays warm for the next load. This is best-effort: if
  // the write fails (private mode quota, storage disabled, …), the DB still
  // carries the canonical value.
  useEffect(() => {
    if (activeWorkspaceId) {
      writeString(ACTIVE_WORKSPACE_STORAGE_KEY, activeWorkspaceId);
    } else {
      removeKey(ACTIVE_WORKSPACE_STORAGE_KEY);
    }
  }, [activeWorkspaceId]);

  // Sweep orphan per-workspace / per-repository localStorage keys whenever
  // the live id sets change. Pass `null` while the upstream query is still
  // loading so we don't treat the initial undefined as "everything is an
  // orphan." Cross-tab/device deletions propagate here via the same Convex
  // subscriptions, so a workspace deleted in another tab gets its tab-strip
  // cache reaped here without an extra handshake.
  const liveWorkspaceIds = useMemo(
    () => (workspaces ? new Set(workspaces.map((w) => w._id as string)) : null),
    [workspaces],
  );
  const liveRepositoryIds = useMemo(
    () => (repositories ? new Set(repositories.map((r) => r._id as string)) : null),
    [repositories],
  );
  useStorageGC({ liveWorkspaceIds, liveRepositoryIds });

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
      // Navigate to the workspace landing — the URL-driven sync effect below
      // mirrors the new id into `activeWorkspaceId` (and the DB preference
      // via `touchWorkspace`), and the workspace-landing redirect drops the
      // user onto its most recent thread. Going through the URL here is what
      // makes workspace switches flicker-free: the TopBar resolves the new
      // repo synchronously from `urlWorkspaceId` instead of waiting for
      // `getThreadContext` to tell us which repo we're now in.
      void navigate(workspacePath(workspaceId));
    },
    [navigate],
  );

  /*
   * URL → state sync. When the URL carries a workspace id, treat it as the
   * canonical "current workspace" and pull `activeWorkspaceId` (plus its
   * localStorage mirror via the existing effect, and the DB preference via
   * `touchWorkspace`) into agreement. This is what lets workspace switches
   * be a single `navigate(workspacePath(id))` call: the URL change drives
   * the rest of the system here, instead of every callsite needing to
   * remember to update three places at once.
   *
   * The DB-wins reconciliation effect above still runs — it handles the
   * cross-tab path (a switch on another device pushes a new
   * `lastActiveWorkspaceId` through the subscription) — but the common case
   * (user clicks a workspace in this tab) flows through here.
   */
  useEffect(() => {
    if (urlWorkspaceId === null) return;
    // Wait for `listWorkspaces` to hydrate before deciding — without this
    // guard, `workspaces?.some(...)` returns `undefined` while the query is
    // loading, the negation flips to `true`, and we redirect away from a
    // perfectly valid URL on first paint.
    if (workspaces === undefined) return;
    // Validate the URL before adopting it. A stale id (deleted workspace,
    // copy/paste from another device) would otherwise oscillate with the
    // fallback effect: this effect would write the stale id into
    // `activeWorkspaceId`, the fallback effect would observe `activeExists ===
    // false` and re-pick a surviving workspace, and we'd bounce back here on
    // the next render forever. The validation must run *before* the
    // `urlWorkspaceId === activeWorkspaceId` short-circuit so that a
    // localStorage-cached stale id pinned in `activeWorkspaceId` still gets
    // recovered.
    const urlWorkspaceExists = workspaces.some((ws) => ws._id === urlWorkspaceId);
    if (!urlWorkspaceExists) {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
      return;
    }
    if (urlWorkspaceId === activeWorkspaceId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveWorkspaceId(urlWorkspaceId);
    void touchWorkspace({ workspaceId: urlWorkspaceId }).catch(() => {});
  }, [urlWorkspaceId, activeWorkspaceId, touchWorkspace, workspaces, navigate]);

  // useThreadCapabilities is the canonical bridge between the resolver-side
  // ChatModeResolver / ThreadContextResolver and the UI's mode selector.
  // It also forwards the attached repository summary, so we do not need a
  // second `getThreadContext` subscription here.
  const capabilities = useThreadCapabilities(urlThreadId);

  /*
   * `currentWorkspaceId` resolves "which workspace is the user in?" without
   * forcing every consumer to remember the URL/state precedence. The URL
   * wins whenever it has a workspace id (including during the brief render
   * window before the sync effect mirrors it into `activeWorkspaceId`); the
   * state value is the fallback for `/chat` (where the URL carries no
   * workspace) and for first-paint before Convex hydrates.
   */
  const currentWorkspaceId: WorkspaceId | null = urlWorkspaceId ?? activeWorkspaceId;

  /*
   * Resolved workspace row for `currentWorkspaceId`. Defined here (rather
   * than alongside the repo-id derivation lower in the component) because
   * the Tier 2 redirect just below needs `lastServiceMode` off this row to
   * decide where to send the user. `workspaces` is `undefined` until the
   * query hydrates; treat that as "no row yet" so consumers fall through
   * to their fallbacks rather than failing closed.
   */
  const currentWorkspace = currentWorkspaceId
    ? (workspaces?.find((ws) => ws._id === currentWorkspaceId) ?? null)
    : null;

  // RepositoryShell is mounted by Chat, Discuss, and Lab — three of the
  // service modes. The redirect must scope to threads of the mode the
  // user is currently in, otherwise a Library Ask thread (mode="ask")
  // would be the "most recent thread" returned to the discuss-page
  // landing and the user would silently end up rendering an Ask thread
  // inside the Discuss chat panel. Library has its own shell and never
  // routes through here.
  //
  // `serviceMode` is URL-derived (or `null` on transient URLs like
  // `/chat`, `/w/:wid`, `/w/:wid/t/:tid`); we use it to gate chrome that
  // should only appear once the URL settles on a canonical mode path.
  // `intendedServiceMode` is what the workspace *should* land in once the
  // canonicalising redirect resolves. Resolution order:
  //
  //   1. URL-derived `serviceMode` — wins whenever the URL has settled on
  //      a canonical mode path. The user is unambiguously *in* that mode.
  //   2. Workspace's `lastServiceMode` — the mode the user was last in
  //      inside this workspace, persisted by the record-on-settle effect
  //      below. This is what makes "Archive → back to chat" return the
  //      user to the mode they came from, instead of bouncing them to the
  //      workspace's structural default.
  //   3. `availability.defaultServiceMode` — the resolver's structural
  //      pick for a workspace with no recorded user preference yet (e.g.
  //      a freshly imported repo lands in library).
  //   4. Hard fallback to "discuss" — only hits before `availability`
  //      hydrates; the loading gate in the redirect effect blocks the
  //      Tier 2 navigation until availability lands, so this is just a
  //      defensive default for the chrome filter.
  //
  // The `lastServiceMode` step is also gated on availability: if the
  // workspace was last in "library" but the repo has since been detached,
  // library is no longer available and we should fall through to the
  // structural default instead of redirecting to a mode the user cannot
  // actually use.
  const { serviceMode, availability } = useServiceMode(currentWorkspaceId);
  const lastServiceMode = currentWorkspace?.lastServiceMode ?? null;
  const lastServiceModeAvailable = lastServiceMode
    ? (availability?.availableServiceModes.includes(lastServiceMode) ?? false)
    : false;
  const intendedServiceMode: ServiceMode =
    serviceMode ?? (lastServiceModeAvailable ? lastServiceMode : null) ?? availability?.defaultServiceMode ?? "discuss";
  const redirectThreadMode = SERVICE_MODE_TO_REDIRECT_THREAD_MODE[intendedServiceMode];

  // Discuss is "free-form discussion with no repository grounding" per
  // docs/service-modes-library-lab-system-design.md. The right-rail
  // ArtifactPanel — repo-scoped folder tree plus sandbox-backed launchers
  // — is therefore mounted only outside Discuss. The toggle button, the
  // desktop column, the mobile drawer, and the keyboard shortcut all gate
  // on this single flag so the surface and its affordances stay
  // consistent.
  //
  // We gate on URL-derived `serviceMode` being explicitly `library` or
  // `lab` (not just `!== "discuss"`). `null` is the transient-URL case
  // and intentionally falls through to `false`: on `/w/:wid` and the
  // legacy `/w/:wid/t/:tid` the user is mid-canonicalisation and the
  // chrome we'd paint here is mode-dependent. Waiting for the URL to
  // settle on a canonical mode path keeps the StatusPill, artifact
  // column, and toggle button stable through the redirect window.
  const isArtifactPanelEnabled = serviceMode === "library" || serviceMode === "lab";

  // Loaded for the redirect-to-most-recent-thread logic: scope by the
  // workspace the user is currently "in" so the sidebar/empty-state CTAs
  // and the redirect target all line up. Skipped once a thread is selected
  // (we already have what we need).
  const ownerThreads = useQuery(
    api.chat.threads.listThreads,
    urlThreadId === null && currentWorkspaceId !== null
      ? { workspaceId: currentWorkspaceId, mode: redirectThreadMode }
      : "skip",
  );

  const [threadToDelete, setThreadToDelete] = useState<ThreadId | null>(null);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showPermanentDeleteDialog, setShowPermanentDeleteDialog] = useState(false);
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
   * their bound repository (the no-repo "Home" workspace simply has no
   * `repositoryId`), so this lookup is unambiguous. Doing it from the
   * already-cached query — instead of waiting on `getThreadContext` to
   * forward `attachedRepository.id` — is what lets the TopBar paint the
   * right title from the very first render after a workspace transition.
   *
   * `currentWorkspace` itself is resolved up near `currentWorkspaceId` so
   * the redirect logic above can read its `lastServiceMode`; we only
   * derive the repo id from it here, where the chrome consumers expect.
   */
  const effectiveSelectedRepositoryId: RepositoryId | null = currentWorkspace?.repositoryId ?? null;

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
   *        - discuss → `/w/:wid/discuss/:mostRecent` (if threads exist)
   *        - library → `/w/:wid/library` (with optional `?ask=:tid` for
   *          the most recent ask thread)
   *        - lab     → `/w/:wid/lab/:mostRecent` (if threads exist)
   *      Going straight to the mode-aware URL — instead of the legacy
   *      mode-agnostic `/w/:wid/t/:tid` — keeps `useServiceMode`'s value
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
      // Tier 1 — `/chat` to a workspace URL. Wait for `activeWorkspaceId` to
      // hydrate before redirecting; the fallback effect above will
      // populate it from the DB preference / first available workspace.
      if (activeWorkspaceId === null) return;
      void navigate(workspacePath(activeWorkspaceId), { replace: true });
      return;
    }
    // Tier 2 — workspace landing to canonical mode URL. Wait for both
    // inputs the mode decision depends on:
    //   - `availability` — `intendedServiceMode` falls back to "discuss"
    //     while this is undefined, which would land repo-attached
    //     workspaces in the wrong default and then re-redirect once
    //     availability hydrated (visible double-jump).
    //   - `currentWorkspace` — same risk for `lastServiceMode`: a stored
    //     "library" pick would be ignored on first paint and the user
    //     would briefly see the structural default before bouncing.
    // Skip on `workspaces === undefined` (still loading) but not on
    // `currentWorkspace === null` (loaded, no row) — the latter means the
    // URL workspace id is stale and the URL-validation effect above will
    // bounce us out.
    if (availability === undefined) return;
    if (workspaces === undefined) return;
    // Library always redirects (the artifact overview is its landing
    // surface); discuss and lab only redirect when a thread of the
    // matching mode exists so empty workspaces stay on `/w/:wid` and
    // render their EmptyState.
    if (intendedServiceMode === "library") {
      const askThreadId = ownerThreads?.[0]?._id;
      const base = libraryPath(urlWorkspaceId);
      const target = askThreadId ? withLibraryAskParam(base, askThreadId) : base;
      void navigate(target, { replace: true });
      return;
    }
    if (!ownerThreads || ownerThreads.length === 0) return;
    const tid = ownerThreads[0]._id;
    const target = intendedServiceMode === "lab" ? labPath(urlWorkspaceId, tid) : discussPath(urlWorkspaceId, tid);
    void navigate(target, { replace: true });
  }, [
    navigate,
    ownerThreads,
    urlWorkspaceId,
    urlThreadId,
    activeWorkspaceId,
    intendedServiceMode,
    availability,
    workspaces,
  ]);

  /*
   * Record the URL's settled service mode on the workspace so the next
   * `/chat` → `/w/:wid` redirect lands the user back in the mode they
   * were last using. Fires only when:
   *   - the URL has settled on a canonical mode (`serviceMode !== null`,
   *     not a transient `/chat` / `/w/:wid` / `/w/:wid/t/:tid` stop), and
   *   - the workspace row's stored mode is stale (different from URL).
   * The second guard collapses the optimistic-update echo to a single
   * write: after `touchWorkspace` runs, the local cache reflects the
   * new mode immediately, the effect re-runs, the guard short-circuits,
   * and we don't fire a redundant mutation.
   */
  useEffect(() => {
    if (currentWorkspaceId === null) return;
    if (serviceMode === null) return;
    if (currentWorkspace === null) return;
    if (currentWorkspace.lastServiceMode === serviceMode) return;
    void touchWorkspace({ workspaceId: currentWorkspaceId, serviceMode }).catch(() => {});
  }, [currentWorkspaceId, currentWorkspace, serviceMode, touchWorkspace]);

  // Fall back gracefully when a thread URL points at an entity the viewer no
  // longer owns or that has been deleted. We bounce back to the workspace
  // landing (which then forwards to the most recent surviving thread, or
  // renders the empty state). Going via the workspace URL — instead of
  // `/chat` — keeps the user inside the workspace they were just in
  // instead of bouncing them through a workspaceless detour.
  useEffect(() => {
    if (urlThreadId === null) {
      return;
    }
    if (!capabilities.isMissingThread) {
      return;
    }
    if (urlWorkspaceId !== null) {
      void navigate(workspacePath(urlWorkspaceId), { replace: true });
    } else {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
    }
  }, [capabilities.isMissingThread, navigate, urlThreadId, urlWorkspaceId]);

  // Check GitHub for new remote commits on tab-focus and repo-switch.
  useCheckForUpdates(effectiveSelectedRepositoryId);

  /*
   * `isAboutToRedirect` signals that the URL is on a transient stop along
   * the canonicalisation chain — `/chat` waiting for `activeWorkspaceId` to
   * promote into `/w/:wsId`, or `/w/:wsId` waiting for `ownerThreads` to
   * resolve so the most-recent-thread redirect can fire. Either way, the
   * shell is "initializing" because the surface we ultimately render is one
   * navigation away.
   */
  const isAboutToRedirect =
    urlThreadId === null &&
    ((urlWorkspaceId === null && activeWorkspaceId !== null) ||
      (urlWorkspaceId !== null && (ownerThreads === undefined || ownerThreads.length > 0)));

  const workspaceStatus: RepositoryWorkspaceStatus =
    isRepositoriesLoading || workspaces === undefined || isAboutToRedirect
      ? "initializing"
      : effectiveSelectedRepositoryId === null && effectiveSelectedThreadId === null
        ? "no-repo"
        : "ready";

  const isChatShellLoading =
    workspaceStatus === "initializing" || (effectiveSelectedThreadId !== null && capabilities.isLoading);

  const handleSelectThread = useCallback(
    (threadId: ThreadId | null, threadMode?: ThreadMode) => {
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
      // If we ever surface cross-workspace thread links (e.g. global
      // search), this is the place to plumb the originating workspace id
      // through the callback signature.
      //
      // When the caller knows the thread's stored mode (sidebar rows carry
      // the full Doc, fresh thread creation inherits the rail's active
      // filter), route directly to the canonical mode URL — picking a Lab
      // thread while already in Lab keeps `LabPage` mounted with only a
      // params change. Falling back to `workspaceThreadPath` for mode-less
      // callers (e.g. a future global search hit) still works through
      // `LegacyThreadRedirect`.
      if (currentWorkspaceId !== null) {
        const target = threadMode
          ? modeAwareThreadPath(currentWorkspaceId, threadId, threadMode)
          : workspaceThreadPath(currentWorkspaceId, threadId);
        void navigate(target);
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
    if (workspaceStatus === "no-repo" || !isArtifactPanelEnabled) {
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
  }, [isArtifactPanelEnabled, isDesktopLayout, setIsArtifactPanelOpen, workspaceStatus]);

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
      if (workspaceStatus === "no-repo") {
        // Force-closed in no-repo state — never opens, but allow `false` so a
        // controlled popover/drawer can collapse cleanly during the transition
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
   * Citation jump from chat (`[A#]` click) → Library Read. The Library route
   * is the single canonical long-form artifact surface.
   */
  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      if (workspaceStatus === "no-repo" || currentWorkspaceId === null) {
        return;
      }
      void navigate(libraryArtifactPath(currentWorkspaceId, artifactId));
    },
    [navigate, currentWorkspaceId, workspaceStatus],
  );

  useEffect(() => {
    if (workspaceStatus === "no-repo" || !isArtifactPanelEnabled) {
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
  }, [handleToggleArtifactPanel, isArtifactPanelEnabled, workspaceStatus]);

  const handleImported = useCallback(
    (_repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => {
      setActionError(null);
      // The URL→state sync effect will pull `activeWorkspaceId` and the DB
      // preference into agreement with the new workspace once we navigate;
      // we don't need to setState here. Going via the URL also means the
      // post-import landing matches what a regular workspace switch looks
      // like — fewer surfaces to keep coherent.
      if (threadId) {
        void navigate(workspaceThreadPath(workspaceId, threadId));
      } else {
        void navigate(workspacePath(workspaceId));
      }
    },
    [navigate],
  );

  const handleThreadMovedToWorkspace = useCallback(
    (workspaceId: WorkspaceId | null) => {
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
      if (urlThreadId !== null) {
        void navigate(workspaceThreadPath(workspaceId, urlThreadId));
      } else {
        void navigate(workspacePath(workspaceId));
      }
    },
    [navigate, urlThreadId],
  );

  // Empty-state CTA: create a no-repo thread and navigate into it (PRD US 1
  // and US 9). We intentionally let the backend choose the repo-less default
  // mode so the empty-state CTA stays in lockstep with `chat.createThread`;
  // the user can attach a repo later via
  // AttachRepoMenu, at which point the mode selector unlocks `docs` and
  // potentially `sandbox`. Errors surface in the workspace's standard
  // `actionError` slot.
  //
  // The new thread is created in `currentWorkspaceId` (the workspace the
  // user is presently in — usually Home for this empty-state CTA), and we
  // navigate to its canonical workspace-scoped URL so the chrome can paint
  // the right context immediately.
  const [isStartingConversation, handleStartConversation] = useAsyncCallback(
    useCallback(async () => {
      setActionError(null);
      try {
        const newThreadId = await createThreadMutation({
          workspaceId: currentWorkspaceId ?? undefined,
        });
        if (currentWorkspaceId !== null) {
          void navigate(workspaceThreadPath(currentWorkspaceId, newThreadId));
        } else {
          // Backend creates a thread without a workspace binding when none
          // is supplied; the workspace-landing redirects can't help here,
          // so route to /chat and let the canonicalising redirects sort it.
          void navigate(DEFAULT_AUTHENTICATED_PATH);
        }
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to start a conversation."));
      }
    }, [createThreadMutation, navigate, currentWorkspaceId]),
  );

  const {
    isSending,
    handleSendMessage,
    isCancellingReply,
    handleCancelInFlightReply,
    isSyncing,
    handleSync,
    isDeletingThread,
    handleDeleteThread,
    isArchivingRepo,
    handleArchiveRepo,
    isRestoringRepo,
    handleRestoreRepo,
    isPermanentDeletingRepo,
    handlePermanentDeleteRepo,
  } = useRepositoryActions({
    selectedRepositoryId: effectiveSelectedRepositoryId,
    selectedThreadId: effectiveSelectedThreadId,
    threadToDelete,
    chatInput,
    chatMode,
    setChatInput,
    setActionError,
    onAfterDeleteThread: () => {
      // Stay inside the current workspace so the user keeps their context
      // (sidebar selection, repo chrome). The workspace-landing redirect
      // forwards to whichever thread is now most recent, or shows the empty
      // state if this was the last one.
      if (currentWorkspaceId !== null) {
        void navigate(workspacePath(currentWorkspaceId));
      } else {
        void navigate(DEFAULT_AUTHENTICATED_PATH);
      }
    },
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
    setThreadToDelete,
    setShowArchiveDialog,
    setShowPermanentDeleteDialog,
  });

  // The chat surface is identical across breakpoints — only the layout
  // container (Resizable group on desktop, none on mobile) differs.
  // Defining ChatContainer once and reusing it in both branches prevents
  // prop drift between desktop and mobile renders. React still unmounts
  // and remounts on a breakpoint switch (different parent), but that
  // only happens when the viewport actually crosses 1280px.
  const isLegacyThreadLocked = capabilities.lockedAt !== null;
  const chatReadOnlyHint = isRepoArchived
    ? "Restore this repository to send messages or run analyses."
    : isLegacyThreadLocked
      ? "This archived Design Docs thread is read-only. Continue in Library Ask or open a new Lab thread."
      : undefined;

  const chatContainerNode = (
    <ChatContainer
      selectedThreadId={effectiveSelectedThreadId}
      isShellLoading={isChatShellLoading}
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
      showArtifactToggle={isArtifactPanelEnabled}
      hasAttachedRepository={capabilities.attachedRepository !== null}
      availableRepositories={repositories ?? []}
      onImported={handleImported}
      onThreadMovedToWorkspace={handleThreadMovedToWorkspace}
      onSelectArtifact={handleSelectArtifact}
      isReadOnly={isRepoArchived || isLegacyThreadLocked}
      readOnlyHint={chatReadOnlyHint}
      repositoryId={capabilities.attachedRepository?.id}
    />
  );

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
         */}
        {!isRepoArchived && repoDetail?.repository.importStatus === "failed" ? (
          <div
            className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/5 px-6 py-3 text-destructive"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
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
              disabled={isSyncing || isRepositorySyncing}
              onClick={() => void handleSync()}
            >
              {isSyncing || isRepositorySyncing ? "Retrying…" : "Retry sync"}
            </Button>
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          {isRepoMissing ? (
            <RepositoryMissingState onBack={() => void navigate(DEFAULT_AUTHENTICATED_PATH)} />
          ) : workspaceStatus === "no-repo" ? (
            <EmptyState
              onStartConversation={() => void handleStartConversation()}
              onImported={handleImported}
              isStartingConversation={isStartingConversation}
            />
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

      {workspaceStatus !== "no-repo" && !isDesktopLayout && isArtifactPanelEnabled ? (
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

      {workspaceStatus !== "no-repo" && !isDesktopLayout && repoDetail ? (
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
