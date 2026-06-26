import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ArtifactId, RepositoryId } from "@/lib/types";
import { libraryArtifactPath, libraryPath } from "@/route-paths";
import { readJSON, writeJSON } from "@/lib/storage";

/**
 * Library tab strip state.
 *
 * The URL is the canonical source of truth — the active tab lives in the
 * path (`/library/a/:artifactId`) and the rest of the open set in
 * `?open=id1,id2` — with localStorage as a first-paint cache so re-entering
 * the repository restores the user's tab strip without waiting for the URL
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
 *     (or the repository's library landing if the strip emptied).
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

function storageKey(repositoryId: RepositoryId): string {
  return `systify.library.tabs.${repositoryId}`;
}

interface CachedLibraryTabs {
  openArtifactIds: string[];
  activeArtifactId: string | null;
}

function isCachedLibraryTabs(v: unknown): v is CachedLibraryTabs {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.openArtifactIds)) return false;
  if (!o.openArtifactIds.every((x) => typeof x === "string")) return false;
  if (o.activeArtifactId !== null && typeof o.activeArtifactId !== "string") return false;
  return true;
}

function readCachedTabs(repositoryId: RepositoryId | null): LibraryTabsState | null {
  if (!repositoryId) {
    return null;
  }
  const cached = readJSON(storageKey(repositoryId), isCachedLibraryTabs);
  if (!cached) return null;
  return {
    openArtifactIds: cached.openArtifactIds.slice(0, MAX_OPEN_TABS) as unknown as ReadonlyArray<ArtifactId>,
    activeArtifactId: cached.activeArtifactId as unknown as ArtifactId | null,
  };
}

function writeCachedTabs(repositoryId: RepositoryId | null, state: LibraryTabsState): void {
  if (!repositoryId) return;
  writeJSON(storageKey(repositoryId), {
    openArtifactIds: state.openArtifactIds,
    activeArtifactId: state.activeArtifactId,
  });
}

function seedActiveArtifactId(
  activeFromRoute: ArtifactId | null,
  cached: LibraryTabsState | null,
  openArtifactIds: ReadonlyArray<ArtifactId>,
): ArtifactId | null {
  if (activeFromRoute !== null) {
    return activeFromRoute;
  }
  if (cached !== null) {
    return cached.activeArtifactId;
  }
  return openArtifactIds[0] ?? null;
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

export function useLibraryTabs(repositoryId: RepositoryId | null, activeFromRoute: ArtifactId | null) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Seed from cache for first paint; the URL effect below reconciles to
  // canonical state once the route settles.
  const [state, setState] = useState<LibraryTabsState>(() => {
    const cached = readCachedTabs(repositoryId);
    const openFromUrl = parseOpenParam(searchParams.get("open"));
    const open = dedupe([...openFromUrl, ...(cached?.openArtifactIds ?? [])]).slice(0, MAX_OPEN_TABS);
    return {
      openArtifactIds: open,
      activeArtifactId: seedActiveArtifactId(activeFromRoute, cached, open),
    };
  });

  // Tabs are per-repository. When the active repositoryId changes, reseed
  // state from the new repo's cache *before* the persistence effect runs —
  // otherwise the previous repo's tabs would be written into the new repo's
  // storage key on the first effect tick after the switch.
  const seededRepositoryIdRef = useRef<RepositoryId | null>(repositoryId);
  const skipPersistForRepoChangeRef = useRef(false);
  const hasReconciledFromUrlRef = useRef(false);
  useEffect(() => {
    if (seededRepositoryIdRef.current === repositoryId) return;
    seededRepositoryIdRef.current = repositoryId;
    skipPersistForRepoChangeRef.current = true;
    hasReconciledFromUrlRef.current = false;
    const cached = readCachedTabs(repositoryId);
    const openFromUrl = parseOpenParam(searchParams.get("open"));
    const open = dedupe([...openFromUrl, ...(cached?.openArtifactIds ?? [])]).slice(0, MAX_OPEN_TABS);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({
      openArtifactIds: open,
      activeArtifactId: seedActiveArtifactId(activeFromRoute, cached, open),
    });
  }, [repositoryId, activeFromRoute, searchParams]);

  // Reconcile URL-driven changes — when the user navigates to a new
  // `/library/a/:aid` (for example via the tree or quick-open), promote
  // it into the open list and mark it active. setState in an effect is
  // the right tool: the open list lives in local state (the URL only
  // names the active tab), so we cannot derive it purely from props
  // without re-introducing the URL → state oscillation. The `setState`
  // updater early-returns the same object when nothing changed, so
  // React skips the re-render in the no-op case.
  //
  // First-run policy depends on whether the URL already names an active
  // artifact. When `activeFromRoute === null`, skip reconciliation so
  // the cache-seeded `activeArtifactId` can promote to the URL via the
  // writer below — this is what restores the last open tab when the
  // user lands on `/library` directly (running reconciliation here
  // would clear that cache-seeded id because the `activeFromRoute ===
  // null` branch below treats the URL as authoritative). When
  // `activeFromRoute !== null`, fall through so the active tab gets
  // added to `openArtifactIds` — handles direct navigation to
  // `/library/a/:aid` with no cache, where the seed leaves
  // `openArtifactIds` empty while `activeArtifactId` is set and the
  // tab strip would otherwise render nothing.
  //
  // Subsequent URL transitions (back/forward, page-level redirect
  // after a bad artifact id, explicit `closeTab`) clear
  // `activeArtifactId` when the URL drops it, so state cannot drag
  // the URL back to a stale tab and start a ping-pong with the page's
  // artifact-validity guard.
  useEffect(() => {
    if (!hasReconciledFromUrlRef.current) {
      hasReconciledFromUrlRef.current = true;
      if (activeFromRoute === null) return;
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
    // Skip one tick after a repositoryId switch so the previous repo's
    // state is not flushed into the new repo's storage key. The reseed
    // effect schedules a fresh `setState` whose subsequent tick re-enters
    // this effect with the new state and clears the flag.
    if (skipPersistForRepoChangeRef.current) {
      skipPersistForRepoChangeRef.current = false;
      return;
    }
    writeCachedTabs(repositoryId, state);
    if (!repositoryId) return;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      // Seed the query string from the *live* URL at flush time so params
      // this hook does not own survive the write — notably `?ask=:threadId`,
      // the active Library Ask thread, which the Library page owns. This
      // hook owns only `?open=`. Reading `window.location.search` inside the
      // debounced callback (not at arm time) means we pick up whatever the
      // page committed in the meantime; the History API updates
      // `window.location` synchronously, so by flush time it is settled.
      const liveParams = new URLSearchParams(window.location.search);
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
        ? libraryArtifactPath(repositoryId, state.activeArtifactId)
        : libraryPath(repositoryId);
      const target = search ? `${targetPath}?${search}` : targetPath;
      // `replace: true` because tab management is not a navigation event
      // the user wants in their back history — back should jump to the
      // previous URL they actually navigated to (an artifact pick from
      // the tree, the repository landing, etc.).
      void navigate(target, { replace: true });
    }, URL_WRITE_DEBOUNCE_MS);
    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [state, repositoryId, navigate]);

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

  const showOverview = useCallback(() => {
    setState((current) => {
      if (current.activeArtifactId === null) return current;
      return { ...current, activeArtifactId: null };
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
      showOverview,
    }),
    [state.activeArtifactId, state.openArtifactIds, openTab, activateTab, closeTab, reorderTabs, showOverview],
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
