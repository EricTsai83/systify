import { Link } from "react-router-dom";
import { usePaginatedQuery, useQuery } from "convex/react";
import { ArrowSquareOutIcon, ChatCircleText, ClockIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Logo } from "@/components/logo";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { formatExpiry } from "@/lib/format-expiry";
import { formatTimestamp } from "@/lib/format";
import { LANDING_PATH } from "@/route-paths";

const PUBLIC_MESSAGES_INITIAL_PAGE_SIZE = 40;
const PUBLIC_MESSAGES_NEXT_PAGE_SIZE = 40;

type PublicMessage = {
  _id: Id<"messages">;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  createdAt: number;
};

export function SharedThreadPage({ token }: { token: string }) {
  const share = useQuery(api.chat.threadShares.getPublicThreadShare, token ? { token } : "skip");
  const {
    results: messages,
    status,
    loadMore,
  } = usePaginatedQuery(api.chat.threadShares.listPublicThreadShareMessages, share ? { token } : "skip", {
    initialNumItems: PUBLIC_MESSAGES_INITIAL_PAGE_SIZE,
  });

  if (!token || share === null) {
    return <SharedThreadUnavailable />;
  }

  if (share === undefined) {
    return <SharedThreadLoading />;
  }

  const isLoadingFirstPage = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const isLoadingMore = status === "LoadingMore";

  return (
    <div className="flex h-dvh w-full flex-1 flex-col overflow-y-auto bg-background">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link
            to={LANDING_PATH}
            className="group flex min-w-0 items-center gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Systify"
          >
            <Logo size={26} />
            <span className="truncate font-mono text-[15px] font-semibold tracking-tight transition-colors group-hover:text-muted-foreground">
              Systify
            </span>
          </Link>
          <Button asChild variant="ghost" size="sm">
            <Link to={LANDING_PATH}>
              <ArrowSquareOutIcon weight="bold" />
              Open Systify
            </Link>
          </Button>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <section className="flex flex-col gap-2 border-b border-border pb-5">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <ChatCircleText size={13} weight="bold" aria-hidden="true" />
                Shared thread
              </span>
              <span>{share.repositoryLabel}</span>
              <span className="inline-flex items-center gap-1.5">
                <ClockIcon size={13} weight="bold" aria-hidden="true" />
                {formatExpiry(share.expiresAt)}
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight">{share.title}</h1>
          </section>

          {isLoadingFirstPage ? (
            <PublicMessagesSkeleton />
          ) : (messages as PublicMessage[]).length === 0 ? (
            <div className="border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              This shared thread has no transcript messages.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {(messages as PublicMessage[]).map((message) => (
                <PublicMessageRow key={message._id} message={message} />
              ))}
            </div>
          )}

          {canLoadMore || isLoadingMore ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canLoadMore || isLoadingMore}
                onClick={() => loadMore(PUBLIC_MESSAGES_NEXT_PAGE_SIZE)}
              >
                {isLoadingMore ? <Spinner size={13} /> : null}
                <ButtonStateText current={isLoadingMore ? "Loading" : "Load more"} states={["Load more", "Loading"]} />
              </Button>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function PublicMessageRow({ message }: { message: PublicMessage }) {
  const isUser = message.role === "user";
  return (
    <article className="flex flex-col gap-2 border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase text-muted-foreground">{isUser ? "User" : "Assistant"}</div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{formatTimestamp(message.createdAt)}</span>
          {message.status !== "completed" ? <span>{formatStatus(message.status)}</span> : null}
        </div>
      </div>
      {isUser ? (
        <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
      ) : (
        <Markdown className="text-sm leading-6">{message.content}</Markdown>
      )}
    </article>
  );
}

function SharedThreadLoading() {
  return (
    <div className="flex h-dvh w-full items-center justify-center px-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size={14} />
        Loading shared thread
      </div>
    </div>
  );
}

function SharedThreadUnavailable() {
  return (
    <div className="flex h-dvh w-full items-center justify-center px-6">
      <div className="w-full max-w-md border border-border bg-card p-6 text-center">
        <div className="mx-auto mb-5 flex justify-center">
          <Logo size={42} />
        </div>
        <h1 className="text-lg font-semibold">Shared thread unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This link may have expired, been revoked, or pointed to a thread that no longer exists.
        </p>
        <Button asChild className="mt-5">
          <Link to={LANDING_PATH}>Go to Systify</Link>
        </Button>
      </div>
    </div>
  );
}

function PublicMessagesSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="border border-border bg-card p-4">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatStatus(status: PublicMessage["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "streaming":
      return "Streaming";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
  }
}
