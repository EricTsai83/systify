import { useMemo, useState, type FormEvent } from "react";
import { BookOpenIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { MessageBubble } from "@/components/chat-message";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { ArtifactId, ThreadId, WorkspaceId } from "@/lib/types";
import { cn } from "@/lib/utils";

export function LibraryAskPanel({
  workspaceId,
  threadId,
  activeArtifactId,
  onThreadCreated,
  onSelectArtifact,
}: {
  workspaceId: WorkspaceId;
  threadId: ThreadId | null;
  activeArtifactId: ArtifactId | null;
  onThreadCreated: (threadId: ThreadId) => void;
  onSelectArtifact: (artifactId: ArtifactId) => void;
}) {
  const createAskThread = useMutation(api.chat.threads.createAskThread);
  const sendMessage = useMutation(api.chat.send.sendMessage);
  const messages = useQuery(api.chat.threads.listMessages, threadId ? { threadId } : "skip");
  const activeMessageStream = useQuery(api.chat.streaming.getActiveMessageStream, threadId ? { threadId } : "skip");
  const [input, setInput] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latestAssistantInFlight = useMemo(() => {
    if (!messages) return false;
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return latestAssistant?.status === "pending" || latestAssistant?.status === "streaming";
  }, [messages]);

  const ensureThread = async (): Promise<ThreadId> => {
    if (threadId) return threadId;
    const created = await createAskThread({
      workspaceId,
      artifactContext: activeArtifactId ? [activeArtifactId] : undefined,
      title: "Library Ask",
    });
    onThreadCreated(created as ThreadId);
    return created as ThreadId;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || latestAssistantInFlight) return;
    setError(null);
    setIsSending(true);
    try {
      const targetThreadId = await ensureThread();
      await sendMessage({
        threadId: targetThreadId,
        content,
        mode: "ask",
      });
      setInput("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to ask Library.");
    } finally {
      setIsSending(false);
      setIsStarting(false);
    }
  };

  return (
    <aside
      className={cn(
        "flex h-full w-[360px] shrink-0 flex-col border-l border-amber-500/40 bg-background shadow-xl",
        "motion-safe:animate-in motion-safe:slide-in-from-right-4",
      )}
      aria-label="Library Ask"
    >
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
          Ask a follow-up about the open artifact or the whole workspace artifact library.
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
          <Button
            type="submit"
            size="sm"
            disabled={!input.trim() || isSending || latestAssistantInFlight}
            onClick={() => setIsStarting(!threadId)}
          >
            <PaperPlaneTiltIcon size={14} weight="fill" />
            {isSending || isStarting ? "Asking..." : "Ask"}
          </Button>
        </div>
      </form>
    </aside>
  );
}
