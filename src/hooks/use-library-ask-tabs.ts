import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Three-mode restructure — Library Ask "open tab" set.
 *
 * The Ask thread tab strip is an IDE-style *open set*, not the full thread
 * list: tabs are threads the user has explicitly opened, persisted to
 * localStorage so they survive a reload. The full searchable history lives
 * in `LibraryAskHistoryPopover`; the *active* tab is the page-owned `?ask=`
 * URL param.
 *
 * Tabs cache `{ id, title }` rather than bare ids because `listThreads` is
 * capped server-side — a long-lived open tab can fall out of that window,
 * and we still need its title to render the tab. The panel reconciles the
 * cached title against `listThreads` when the thread is present there, so
 * renames still propagate.
 */
export interface OpenAskThread {
  id: ThreadId;
  title: string;
}

const MAX_OPEN_ASK_TABS = 12;

function storageKey(workspaceId: WorkspaceId): string {
  return `systify.library.askTabs.${workspaceId}`;
}

function readCache(workspaceId: WorkspaceId): OpenAskThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: OpenAskThread[] = [];
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        "id" in entry &&
        "title" in entry &&
        typeof entry.id === "string" &&
        typeof entry.title === "string"
      ) {
        out.push({ id: entry.id as ThreadId, title: entry.title });
      }
    }
    return out.slice(0, MAX_OPEN_ASK_TABS);
  } catch {
    return [];
  }
}

function writeCache(workspaceId: WorkspaceId, tabs: ReadonlyArray<OpenAskThread>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(tabs));
  } catch {
    // Storage denied (private mode / quota). Tabs degrade to in-memory only.
  }
}

export function useLibraryAskTabs(workspaceId: WorkspaceId) {
  const [openThreads, setOpenThreads] = useState<OpenAskThread[]>(() => readCache(workspaceId));
  const workspaceRef = useRef(workspaceId);

  useEffect(() => {
    if (workspaceRef.current !== workspaceId) return;
    writeCache(workspaceId, openThreads);
  }, [workspaceId, openThreads]);

  // Re-seed when the workspace id changes under a reused hook instance.
  useEffect(() => {
    if (workspaceRef.current === workspaceId) return;
    workspaceRef.current = workspaceId;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenThreads(readCache(workspaceId));
  }, [workspaceId]);

  // Add a tab (or refresh its cached title on rename). Idempotent — safe to
  // call from an effect on every `listThreads` tick. Stable identity (empty
  // deps) so the memoized tab strip is not re-rendered on stream ticks.
  const ensureOpen = useCallback((thread: OpenAskThread) => {
    setOpenThreads((current) => {
      const index = current.findIndex((t) => t.id === thread.id);
      if (index >= 0) {
        if (current[index].title === thread.title) return current;
        const next = [...current];
        next[index] = thread;
        return next;
      }
      const appended = [...current, thread];
      return appended.length > MAX_OPEN_ASK_TABS ? appended.slice(appended.length - MAX_OPEN_ASK_TABS) : appended;
    });
  }, []);

  // Remove a tab. Returns the tab that should become active *if the closed
  // tab was the active one* — the right neighbour, else the left, else null.
  // The caller owns the active pointer (`?ask=`) and decides whether to act
  // on the suggestion. Depends on `openThreads` (not a ref) so the returned
  // id is always computed from current state; `openThreads` only changes when
  // tabs change, never on stream ticks, so this stays stable across the
  // panel's frequent re-renders.
  const closeTab = useCallback(
    (threadId: ThreadId): ThreadId | null => {
      const index = openThreads.findIndex((t) => t.id === threadId);
      if (index < 0) return null;
      const remaining = openThreads.filter((t) => t.id !== threadId);
      setOpenThreads(remaining);
      return remaining[index]?.id ?? remaining[index - 1]?.id ?? null;
    },
    [openThreads],
  );

  return useMemo(() => ({ openThreads, ensureOpen, closeTab }), [openThreads, ensureOpen, closeTab]);
}
