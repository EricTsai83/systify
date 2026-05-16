import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ArtifactId, WorkspaceId } from "@/lib/types";
import { libraryArtifactPath, libraryPath } from "@/route-paths";

/**
 * Three-mode restructure — Library tab strip state.
 *
 * The URL is the canonical source of truth — the active tab lives in the
 * path (`/library/a/:artifactId`) and the rest of the open set in
 * `?open=id1,id2` — with localStorage as a first-paint cache so re-entering
 * the workspace restores the user's tab strip without waiting for the URL
 * to read in. This hook owns only `?open=`; it coexists with the page-owned
 * `?ask=:threadId` param (the active Library Ask thread) and preserves it
 * on every write.
 *
 * Mutation contract:
 *
 *   - `openTab(artifactId)` — adds the artifact to the open list (no-op
 *     when already open), promotes it to the active tab, and navigates
 *     to its URL. Caps the open list at {@link MAX_OPEN_TABS}; the
 *     least-recently-active tab gets evicted when the cap is hit.
 *   - `closeTab(artifactId)` — removes the artifact from the open list.
 *     If it was active, promotes the most-recently-active surviving tab
 *     (or the workspace's library landing if the strip emptied).
 *   - `activateTab(artifactId)` — same as `openTab` but skips the
 *     "evict on cap" branch; only valid when the tab is already open.
 *   - `reorderTabs(nextOrder)` — replace the open list with a permutation.
 *     Used by HTML5 native drag-and-drop.
 *
 * URL writes are debounced ({@link URL_WRITE_DEBOUNCE_MS}) so a
 * keyboard-driven multi-tab close doesn't spam history. The active tab
 * still updates immediately (it is part of the URL path, not the
 * search), so the back button always lands on the most recent active
 * tab.
 */

export const MAX_OPEN_TABS = 10;
const URL_WRITE_DEBOUNCE_MS = 200;

interface LibraryTabsState {
  /** Active tab — `null` when no tab is open (`/library` landing). */
  activeArtifactId: ArtifactId | null;
  /**
   * Open tab order, left-to-right. The active tab is always in this list
   * when non-null; promoting an already-open tab does NOT move it within
   * the order (preserves the user's chosen tab arrangement).
   */
  openArtifactIds: ReadonlyArray<ArtifactId>;
}

function storageKey(workspaceId: WorkspaceId): string {
  return `systify.library.tabs.${workspaceId}`;
}

function readCachedTabs(workspaceId: WorkspaceId | null): LibraryTabsState | null {
  if (!workspaceId || typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { openArtifactIds?: string[]; activeArtifactId?: string | null };
    if (!Array.isArray(parsed.openArtifactIds)) return null;
    // The cache is opaque strings; brand them back to `ArtifactId` for
    // the typed state. Going through `unknown` is the documented escape
    // hatch when two unrelated strings overlap structurally — Convex's
    // branded id type and a raw `string` from JSON have no shared
    // narrowing axis.
    return {
      openArtifactIds: parsed.openArtifactIds.slice(0, MAX_OPEN_TABS) as unknown as ReadonlyArray<ArtifactId>,
      activeArtifactId: (parsed.activeArtifactId ?? null) as unknown as ArtifactId | null,
    };
  } catch {
    return null;
  }
}

function writeCachedTabs(workspaceId: WorkspaceId | null, state: LibraryTabsState): void {
  if (!workspaceId || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      storageKey(workspaceId),
      JSON.stringify({
        openArtifactIds: state.openArtifactIds,
        activeArtifactId: state.activeArtifactId,
      }),
    );
  } catch {
    // Storage denied (private mode, quota). The DB-less library tab
    // strip falls back to URL-only state — acceptable degradation.
  }
}

function parseOpenParam(value: string | null): ArtifactId[] {
  if (!value) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, MAX_OPEN_TABS) as unknown as ArtifactId[];
}

function dedupe<T>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

export function useLibraryTabs(workspaceId: WorkspaceId | null, activeFromRoute: ArtifactId | null) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Seed from cache for first paint; the URL effect below reconciles to
  // canonical state once the route settles.
  const [state, setState] = useState<LibraryTabsState>(() => {
    const cached = readCachedTabs(workspaceId);
    const openFromUrl = parseOpenParam(searchParams.get("open"));
    const open = dedupe([...openFromUrl, ...(cached?.openArtifactIds ?? [])]).slice(0, MAX_OPEN_TABS);
    return {
      openArtifactIds: open,
      activeArtifactId: activeFromRoute ?? cached?.activeArtifactId ?? open[0] ?? null,
    };
  });

  // Reconcile URL-driven changes — when the user navigates to a new
  // `/library/a/:aid` (for example via the tree or quick-open), promote
  // it into the open list and mark it active. setState in an effect is
  // the right tool: the open list lives in local state (the URL only
  // names the active tab), so we cannot derive it purely from props
  // without re-introducing the URL → state oscillation. The `setState`
  // updater early-returns the same object when nothing changed, so
  // React skips the re-render in the no-op case.
  //
  // The first run is skipped so the cache-seeded `activeArtifactId` can
  // promote to the URL via the writer below — this is what restores the
  // last open tab when the user lands on `/library` directly. Subsequent
  // URL transitions (back/forward, page-level redirect after a bad
  // artifact id, explicit `closeTab`) clear `activeArtifactId` when the
  // URL drops it, so state cannot drag the URL back to a stale tab and
  // start a ping-pong with the page's artifact-validity guard.
  const hasReconciledFromUrlRef = useRef(false);
  useEffect(() => {
    if (!hasReconciledFromUrlRef.current) {
      hasReconciledFromUrlRef.current = true;
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => {
      if (activeFromRoute === null) {
        if (current.activeArtifactId === null) return current;
        return { ...current, activeArtifactId: null };
      }
      if (current.activeArtifactId === activeFromRoute && current.openArtifactIds.includes(activeFromRoute)) {
        return current;
      }
      const next = current.openArtifactIds.includes(activeFromRoute)
        ? current.openArtifactIds
        : capOpenList([...current.openArtifactIds, activeFromRoute], activeFromRoute);
      return {
        openArtifactIds: next,
        activeArtifactId: activeFromRoute,
      };
    });
  }, [activeFromRoute]);

  // Persist to localStorage immediately and to the URL on a debounce.
  // Debouncing the URL keeps a fast Cmd+W loop from filling the history
  // stack with one entry per tab close.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    writeCachedTabs(workspaceId, state);
    if (!workspaceId) return;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      // Seed the query string from the *live* URL at flush time so params
      // this hook does not own survive the write — notably `?ask=:threadId`,
      // the active Library Ask thread, which the Library page owns. This
      // hook owns only `?open=`. Reading `window.location.search` inside the
      // debounced callback (not at arm time) means we pick up whatever the
      // page committed in the meantime; the History API updates
      // `window.location` synchronously, so by flush time it is settled.
      const liveParams = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
      if (state.openArtifactIds.length > 1) {
        // `?open=…` only matters when more than one tab is open; a single
        // tab is fully described by the path's `:artifactId`.
        liveParams.set("open", state.openArtifactIds.join(","));
      } else {
        // Explicit clear: because we now seed from the live URL, a stale
        // `?open=` left over from a previous multi-tab state would linger
        // without this.
        liveParams.delete("open");
      }
      const search = liveParams.toString();
      const targetPath = state.activeArtifactId
        ? libraryArtifactPath(workspaceId, state.activeArtifactId)
        : libraryPath(workspaceId);
      const target = search ? `${targetPath}?${search}` : targetPath;
      // `replace: true` because tab management is not a navigation event
      // the user wants in their back history — back should jump to the
      // previous URL they actually navigated to (an artifact pick from
      // the tree, the workspace landing, etc.).
      void navigate(target, { replace: true });
    }, URL_WRITE_DEBOUNCE_MS);
    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [state, workspaceId, navigate]);

  const openTab = useCallback((artifactId: ArtifactId) => {
    setState((current) => {
      if (current.openArtifactIds.includes(artifactId)) {
        return { ...current, activeArtifactId: artifactId };
      }
      return {
        openArtifactIds: capOpenList([...current.openArtifactIds, artifactId], artifactId),
        activeArtifactId: artifactId,
      };
    });
  }, []);

  const activateTab = useCallback((artifactId: ArtifactId) => {
    setState((current) => {
      if (!current.openArtifactIds.includes(artifactId)) return current;
      if (current.activeArtifactId === artifactId) return current;
      return { ...current, activeArtifactId: artifactId };
    });
  }, []);

  const closeTab = useCallback((artifactId: ArtifactId) => {
    setState((current) => {
      const idx = current.openArtifactIds.indexOf(artifactId);
      if (idx < 0) return current;
      const remaining = current.openArtifactIds.filter((id) => id !== artifactId);
      let nextActive: ArtifactId | null = current.activeArtifactId;
      if (current.activeArtifactId === artifactId) {
        // Promote the neighbour to the right (or to the left if we just
        // closed the rightmost tab). Mirrors the VS Code / browser tab
        // close behaviour the user already knows.
        nextActive = remaining[idx] ?? remaining[idx - 1] ?? null;
      }
      return { openArtifactIds: remaining, activeArtifactId: nextActive };
    });
  }, []);

  const reorderTabs = useCallback((nextOrder: ReadonlyArray<ArtifactId>) => {
    setState((current) => {
      const filtered = nextOrder.filter((id) => current.openArtifactIds.includes(id));
      if (filtered.length !== current.openArtifactIds.length) return current;
      return { ...current, openArtifactIds: filtered };
    });
  }, []);

  return useMemo(
    () => ({
      openArtifactIds: state.openArtifactIds,
      activeArtifactId: state.activeArtifactId,
      openTab,
      activateTab,
      closeTab,
      reorderTabs,
    }),
    [state.activeArtifactId, state.openArtifactIds, openTab, activateTab, closeTab, reorderTabs],
  );
}

/**
 * Public shape of {@link useLibraryTabs}. The strip is owned by the Library
 * page and threaded through props to both the document column and the
 * sidebar's Ask panel, so the return type is named rather than re-derived
 * at each call site.
 */
export type LibraryTabsApi = ReturnType<typeof useLibraryTabs>;

/**
 * Enforce {@link MAX_OPEN_TABS}. When the cap is hit and a new tab needs
 * to be opened, evict the oldest tab that is NOT the new tab. The active
 * tab is always preserved; if the active tab IS the new tab we evict
 * the oldest non-active sibling. This matches VS Code's "least
 * recently used" tab eviction without us needing to track LRU order
 * separately.
 */
function capOpenList(open: ReadonlyArray<ArtifactId>, mustKeep: ArtifactId): ReadonlyArray<ArtifactId> {
  if (open.length <= MAX_OPEN_TABS) {
    return open;
  }
  const filtered = open.filter((id) => id !== mustKeep);
  // Drop the oldest sibling, then prepend `mustKeep` back at its
  // original position (we appended it above before calling this).
  filtered.shift();
  return [...filtered, mustKeep].slice(-MAX_OPEN_TABS);
}
