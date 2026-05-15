import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpenIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { MessageBubble } from "@/components/chat-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LibraryAskHistoryDialog } from "@/components/library-ask-history-dialog";
import { LibraryAskThreadTabs } from "@/components/library-ask-thread-tabs";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useLibraryAskTabs } from "@/hooks/use-library-ask-tabs";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId, ThreadId, WorkspaceId } from "@/lib/types";
import { toast } from "sonner";

export function LibraryAskPanel({
  workspaceId,
  threadId,
  activeArtifactId,
  onSelectArtifact,
  onSelectThread,
}: {
  workspaceId: WorkspaceId;
  threadId: ThreadId | null;
  activeArtifactId: ArtifactId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  /**
   * Set or clear the active Ask thread (`?ask=`). Used for tab clicks, the
   * `+` create flow, history-dialog picks, and advancing the active tab
   * when the current one is closed or deleted.
   */
  onSelectThread: (threadId: ThreadId | null) => void;
}) {
  const createAskThread = useMutation(api.chat.threads.createAskThread);
  const sendMessage = useMutation(api.chat.send.sendMessage);
  const deleteThread = useMutation(api.chat.threads.deleteThread);
  const setThreadPinned = useMutation(api.chat.threads.setThreadPinned);

  const threads = useQuery(api.chat.threads.listThreads, { workspaceId, mode: "ask" });
  // Dual-purpose: confirms the active thread exists (so the message queries
  // below can be gated and never throw the route into its error boundary)
  // and supplies the tab title when the thread has aged out of `listThreads`.
  const activeThreadProbe = useQuery(api.chat.threads.getThreadSummary, threadId ? { threadId } : "skip");
  // `listMessages` / `getActiveMessageStream` THROW for a missing or
  // unauthorized thread. Only subscribe once the probe has confirmed the
  // thread exists; a stale `?ask=` bookmark then degrades to the empty
  // state instead of tearing down the Library route.
  const confirmedThreadId = threadId && activeThreadProbe ? threadId : null;
  const messages = useQuery(
    api.chat.threads.listMessages,
    confirmedThreadId ? { threadId: confirmedThreadId } : "skip",
  );
  const activeMessageStream = useQuery(
    api.chat.streaming.getActiveMessageStream,
    confirmedThreadId ? { threadId: confirmedThreadId } : "skip",
  );

  const { openThreads, ensureOpen, closeTab } = useLibraryAskTabs(workspaceId);

  const [input, setInput] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<ThreadId | null>(null);
  const [isDeletingThread, setIsDeletingThread] = useState(false);
  const submissionLockRef = useRef(false);

  const threadsById = useMemo(() => {
    const map = new Map<ThreadId, Doc<"threads">>();
    for (const thread of threads ?? []) {
      map.set(thread._id as ThreadId, thread);
    }
    return map;
  }, [threads]);

  // Tabs render the open set with the freshest title available — the live
  // `listThreads` title when the thread is in that (capped) window, else the
  // title cached in localStorage when the tab was opened.
  const tabs = useMemo(
    () =>
      openThreads.map((tab) => {
        const live = threadsById.get(tab.id);
        return live ? { id: tab.id, title: live.title } : tab;
      }),
    [openThreads, threadsById],
  );

  // Whatever becomes the active thread (`?ask=`) must show as a tab. Title
  // comes from `listThreads` when present, else the existence probe — which
  // covers a thread bookmarked after it aged out of `listThreads`.
  const activeTitle = (threadId ? threadsById.get(threadId)?.title : undefined) ?? activeThreadProbe?.title ?? null;
  useEffect(() => {
    if (threadId && activeTitle) {
      ensureOpen({ id: threadId, title: activeTitle });
    }
  }, [threadId, activeTitle, ensureOpen]);

  // The Ask panel no longer remounts when the active thread changes — the
  // thread is a `?ask=` query param on the same route. Clear the in-progress
  // draft + any stale error explicitly so they don't bleed between threads.
  useEffect(() => {
    setInput("");
    setError(null);
  }, [threadId]);

  const [isCreatingThread, handleCreateThread] = useAsyncCallback(
    useCallback(async () => {
      setError(null);
      try {
        // The "+" creates a bare thread not tied to the open artifact —
        // mirrors the WorkspaceThreadsRail "New thread" affordance. The
        // server defaults the title to "Library Ask".
        const created = (await createAskThread({ workspaceId })) as ThreadId;
        ensureOpen({ id: created, title: "Library Ask" });
        onSelectThread(created);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to start an Ask thread.");
      }
    }, [createAskThread, ensureOpen, onSelectThread, workspaceId]),
  );

  const handleCloseTab = useCallback(
    (id: ThreadId) => {
      const nextActive = closeTab(id);
      // Closing the active tab advances `?ask=` to the neighbour (or clears
      // it). Closing a background tab leaves the active thread alone.
      if (id === threadId) {
        onSelectThread(nextActive);
      }
    },
    [closeTab, onSelectThread, threadId],
  );

  const handleSelectFromHistory = useCallback(
    (thread: Doc<"threads">) => {
      // Add the tab immediately so it appears before `?ask=` round-trips.
      ensureOpen({ id: thread._id as ThreadId, title: thread.title });
      onSelectThread(thread._id as ThreadId);
    },
    [ensureOpen, onSelectThread],
  );

  const handleTogglePin = useCallback(
    (id: ThreadId, pinned: boolean) => {
      void setThreadPinned({ threadId: id, pinned }).catch((caught) => {
        toast.error(toUserErrorMessage(caught, pinned ? "Failed to pin thread." : "Failed to unpin thread."));
      });
    },
    [setThreadPinned],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeleteThreadId) return;
    const target = pendingDeleteThreadId;
    setIsDeletingThread(true);
    try {
      await deleteThread({ threadId: target });
      setPendingDeleteThreadId(null);
      // Drop it from the open-tab set; if it was the active thread, advance
      // `?ask=` to the neighbour the close suggests.
      const nextActive = closeTab(target);
      if (target === threadId) {
        onSelectThread(nextActive);
      }
    } catch (caught) {
      toast.error(toUserErrorMessage(caught, "Failed to delete thread."));
    } finally {
      setIsDeletingThread(false);
    }
  }, [closeTab, deleteThread, onSelectThread, pendingDeleteThreadId, threadId]);

  const latestAssistantInFlight = useMemo(() => {
    if (!messages) return false;
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return latestAssistant?.status === "pending" || latestAssistant?.status === "streaming";
  }, [messages]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submissionLockRef.current) return;
    const content = input.trim();
    if (!content || latestAssistantInFlight) return;
    submissionLockRef.current = true;
    setError(null);
    setIsStarting(!threadId);
    setIsSending(true);
    try {
      // Create the thread (if needed) and persist the user message BEFORE
      // telling the parent to flip `?ask=`. Switching the active thread no
      // longer remounts this panel (the thread is a query param on the same
      // route), so this is not a remount-safety requirement anymore — but
      // the ordering still matters: flipping `?ask=` re-keys `listMessages`
      // to the new thread, and we want that query to resolve with the
      // freshly persisted user + pending-assistant pair on its first read.
      let targetThreadId = threadId;
      let createdNew = false;
      if (!targetThreadId) {
        const created = await createAskThread({
          workspaceId,
          artifactContext: activeArtifactId ? [activeArtifactId] : undefined,
          title: "Library Ask",
        });
        targetThreadId = created as ThreadId;
        createdNew = true;
      }
      await sendMessage({
        threadId: targetThreadId,
        content,
        mode: "ask",
      });
      setInput("");
      if (createdNew) {
        ensureOpen({ id: targetThreadId, title: "Library Ask" });
        onSelectThread(targetThreadId);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to ask Library.");
    } finally {
      submissionLockRef.current = false;
      setIsSending(false);
      setIsStarting(false);
    }
  };

  return (
    // Plain container, not a landmark: this panel renders inside the app
    // sidebar's <aside>, so its own section is just content within it.
    <div className="flex h-full w-full flex-col bg-background">
      <LibraryAskThreadTabs
        tabs={tabs}
        activeThreadId={threadId}
        onSelectTab={onSelectThread}
        onCloseTab={handleCloseTab}
        onNewThread={() => void handleCreateThread()}
        onOpenHistory={() => setIsHistoryOpen(true)}
        isCreating={isCreatingThread}
      />

      <div className="border-b border-border bg-amber-500/5 px-4 py-3">
        <div className="flex items-center gap-2">
          <BookOpenIcon size={16} weight="duotone" className="text-amber-600" />
          <h2 className="text-sm font-semibold text-foreground">Library Ask</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Answers use retrieved artifact chunks only. For current code state, open the question in Lab.
        </p>
      </div>

      {threadId ? (
        <ScrollArea className="min-h-0 flex-1 px-4 py-3">
          <div className="space-y-3">
            {(messages ?? []).map((message) => (
              <MessageBubble
                key={message._id}
                message={message}
                activeMessageStream={activeMessageStream ?? null}
                onSelectArtifact={onSelectArtifact}
              />
            ))}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center px-4 text-sm text-muted-foreground">
          Pick an Ask thread above, or ask a question below to start a new one.
        </div>
      )}

      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        className="border-t border-border p-3"
      >
        {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={activeArtifactId ? "Question about the open artifact..." : "Question about this library..."}
          className="min-h-24 resize-none text-sm"
          disabled={isSending || latestAssistantInFlight}
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" disabled={!input.trim() || isSending || latestAssistantInFlight}>
            <PaperPlaneTiltIcon size={14} weight="fill" />
            {isSending || isStarting ? "Asking..." : "Ask"}
          </Button>
        </div>
      </form>

      <LibraryAskHistoryDialog
        open={isHistoryOpen}
        onOpenChange={setIsHistoryOpen}
        threads={threads}
        activeThreadId={threadId}
        onSelectThread={handleSelectFromHistory}
        onTogglePin={handleTogglePin}
        onDeleteThread={setPendingDeleteThreadId}
      />

      <ConfirmDialog
        open={pendingDeleteThreadId !== null}
        onOpenChange={(open) => !open && setPendingDeleteThreadId(null)}
        title="Delete thread"
        description="This will permanently delete this thread and all its messages. This action cannot be undone."
        actionLabel="Delete thread"
        loadingLabel="Deleting…"
        isPending={isDeletingThread}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}
