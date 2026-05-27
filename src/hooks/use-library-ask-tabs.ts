import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RepositoryId, ThreadId } from "@/lib/types";
import { readJSON, writeJSON } from "@/lib/storage";

/**
 * Library Ask "open tab" set.
 *
 * The Ask thread tab strip is an IDE-style *open set*, not the full thread
 * list: tabs are threads the user has explicitly opened, persisted to
 * localStorage so they survive a reload.
 */
export interface OpenAskThread {
  id: ThreadId;
  title: string;
}

const MAX_OPEN_ASK_TABS = 12;

function storageKey(repositoryId: RepositoryId): string {
  return `systify.library.askTabs.${repositoryId}`;
}

function isCachedAskThreadArray(v: unknown): v is Array<{ id: string; title: string }> {
  if (!Array.isArray(v)) return false;
  for (const entry of v) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      !("title" in entry) ||
      typeof entry.id !== "string" ||
      typeof entry.title !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function readCache(repositoryId: RepositoryId): OpenAskThread[] {
  const cached = readJSON(storageKey(repositoryId), isCachedAskThreadArray);
  if (!cached) return [];
  const out: OpenAskThread[] = [];
  for (const entry of cached) {
    out.push({ id: entry.id as ThreadId, title: entry.title });
  }
  return out.slice(0, MAX_OPEN_ASK_TABS);
}

function writeCache(repositoryId: RepositoryId, tabs: ReadonlyArray<OpenAskThread>): void {
  writeJSON(storageKey(repositoryId), tabs);
}

export function useLibraryAskTabs(repositoryId: RepositoryId) {
  const [openThreads, setOpenThreads] = useState<OpenAskThread[]>(() => readCache(repositoryId));
  const repositoryRef = useRef(repositoryId);

  useEffect(() => {
    if (repositoryRef.current !== repositoryId) return;
    writeCache(repositoryId, openThreads);
  }, [repositoryId, openThreads]);

  useEffect(() => {
    if (repositoryRef.current === repositoryId) return;
    repositoryRef.current = repositoryId;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenThreads(readCache(repositoryId));
  }, [repositoryId]);

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
