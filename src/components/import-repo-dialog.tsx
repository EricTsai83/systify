import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  PlusIcon,
  LockIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  CircleNotchIcon,
  CheckCircleIcon,
  ArrowsClockwiseIcon,
  GithubLogoIcon,
  EyeIcon,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
// Tabs removed — connected state uses a single unified repo list (Vercel-style).
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { useGitHubConnection } from "@/hooks/use-github-connection";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { readString, removeKey, writeString } from "@/lib/storage";
import type { ThreadMode } from "@/route-paths";
import type { RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";

// ---------------------------------------------------------------------------
// sessionStorage flag: fallback for when the popup-based GitHub install is
// blocked. Persisted before a full-page redirect so the dialog can auto-open
// when the user returns. This survives the multi-redirect chain
// (GitHub → callback → / → /chat) that otherwise drops URL search params.
// All storage access goes through `@/lib/storage` per docs/client-storage-strategy.md.
// ---------------------------------------------------------------------------
const PENDING_IMPORT_KEY = "systify.github.pendingImport";

function markPendingImport() {
  writeString(PENDING_IMPORT_KEY, "true", "session");
}

/** Consume the flag. Returns `true` exactly once per redirect. */
function consumePendingImport(): boolean {
  if (readString(PENDING_IMPORT_KEY, "session") !== "true") return false;
  removeKey(PENDING_IMPORT_KEY, "session");
  return true;
}

const STATIC_PLACEHOLDER = "Search any GitHub repo or paste a URL...";

type ImportSummary = {
  importStatus: string;
  lastImportedAt: number | undefined;
  hasRemoteUpdates: boolean;
};

type RepoInfo = {
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string | null;
  htmlUrl: string;
  updatedAt: string;
  ownerAvatarUrl?: string;
};

function formatRelativeDate(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isGitHubUrl(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.includes("github.com/") || /^https?:\/\//.test(trimmed);
}

// ---------------------------------------------------------------------------
// Shared repo row component
// ---------------------------------------------------------------------------

function RepoRow({
  repo,
  isImporting,
  onImport,
  importSummary,
}: {
  repo: RepoInfo;
  isAuthorized: boolean;
  isImporting: boolean;
  onImport: () => void;
  importSummary?: ImportSummary;
}) {
  const ownerInitial = (repo.fullName.split("/")[0] ?? "?")[0].toUpperCase();
  const hasCompletedImport = importSummary?.importStatus === "completed" || importSummary?.lastImportedAt !== undefined;
  const isRunning = importSummary?.importStatus === "queued" || importSummary?.importStatus === "running";
  const hasUpdates = hasCompletedImport && !!importSummary?.hasRemoteUpdates;
  const canRetryFailedSync = hasCompletedImport && importSummary?.importStatus === "failed";
  const runningLabel = hasCompletedImport ? "Syncing…" : "Importing…";

  return (
    <div
      className={`flex min-w-0 items-center gap-3 border-b border-border/50 px-1 py-3 last:border-b-0 ${hasCompletedImport && !isRunning && !hasUpdates && !canRetryFailedSync ? "opacity-60" : ""}`}
    >
      <Avatar className="shrink-0">
        <AvatarImage src={repo.ownerAvatarUrl} alt="" />
        <AvatarFallback className="text-xs font-semibold">{ownerInitial}</AvatarFallback>
      </Avatar>

      {/* Repo name + metadata */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{repo.fullName}</span>
        {repo.isPrivate && <LockIcon size={12} className="shrink-0 text-muted-foreground" weight="bold" />}
        <span className="shrink-0 text-xs text-muted-foreground">· {formatRelativeDate(repo.updatedAt)}</span>
      </div>

      {/* Action area: status badge or import/sync button */}
      {isRunning ? (
        <Badge variant="muted" className="shrink-0 gap-1">
          <CircleNotchIcon size={12} className="animate-spin" />
          {runningLabel}
        </Badge>
      ) : hasCompletedImport ? (
        hasUpdates ? (
          <Button
            variant="outline"
            size="sm"
            className="min-w-30 shrink-0 justify-center gap-1 text-xs"
            disabled={isImporting}
            onClick={onImport}
          >
            <ArrowsClockwiseIcon size={12} weight="bold" />
            {isImporting ? "Syncing…" : "Sync"}
          </Button>
        ) : canRetryFailedSync ? (
          <Button
            variant="outline"
            size="sm"
            className="min-w-30 shrink-0 justify-center gap-1 text-xs"
            disabled={isImporting}
            onClick={onImport}
          >
            <ArrowsClockwiseIcon size={12} weight="bold" />
            {isImporting ? "Syncing…" : "Retry sync"}
          </Button>
        ) : (
          <Badge variant="outline" className="min-w-30 shrink-0 justify-center gap-1 px-2.5 py-1.5 text-xs">
            <CheckCircleIcon size={12} weight="fill" />
            <span>Imported</span>
          </Badge>
        )
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="min-w-30 shrink-0 justify-center text-xs"
          disabled={isImporting}
          onClick={onImport}
        >
          {isImporting ? "Importing…" : "Import"}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function ImportRepoDialog({
  onImported,
  trigger,
}: {
  /**
   * Fires once the backend has accepted the import and queued the workflow.
   * `threadMode` is the stored mode of the freshly-created default thread
   * (or `null` when the backend chose not to materialise one yet); the shell
   * uses it to navigate straight to the canonical mode-aware URL instead of
   * bouncing through `LegacyThreadRedirect`.
   */
  onImported: (
    repoId: RepositoryId,
    threadId: ThreadId | null,
    workspaceId: WorkspaceId,
    threadMode: ThreadMode | null,
  ) => void;
  /**
   * Optional custom trigger element. Used by the EmptyState's dual-CTA layout
   * (PRD US 9) where the "Import repository" button needs to read as a primary
   * action rather than the compact "+" icon used in the sidebar.
   */
  trigger?: ReactElement;
}) {
  const createRepositoryImport = useMutation(api.repositories.createRepositoryImport);
  const initiateGitHubInstall = useAction(api.githubAppNode.initiateGitHubInstall);
  const listRepos = useAction(api.githubAppNode.listInstallationRepos);
  const searchReposAction = useAction(api.githubAppNode.searchGitHubRepos);
  const verifyAccess = useAction(api.githubAppNode.verifyRepoAccess);
  const importedSummaries = useQuery(api.repositories.getImportedRepoSummaries);
  const { isConnected, installationId, isLoading: isConnectionLoading } = useGitHubConnection();
  const [open, setOpen] = useState(false);

  // --- Auto-open after GitHub connection redirect (fallback path) ---
  // When the popup is blocked, handleConnectGitHub falls back to a full-page
  // redirect. Before leaving, it stashes a flag in sessionStorage. Once the
  // redirect chain resolves and this component mounts with a confirmed
  // connection, auto-open the dialog so the user can continue importing.
  const pendingImportConsumedRef = useRef(false);
  useEffect(() => {
    // Wait for the connection query to settle so we know the install succeeded.
    if (isConnectionLoading) return;
    // Only run once per component lifecycle.
    if (pendingImportConsumedRef.current) return;

    if (consumePendingImport()) {
      pendingImportConsumedRef.current = true;
      if (isConnected) {
        setOpen(true);
        // Stay on the default "public" tab — the user might have connected
        // GitHub to import any repo (public or private), and the public
        // search already surfaces authorized private repos in results.
      }
    }
  }, [isConnectionLoading, isConnected]);

  // --- Shared state ---
  const [importError, setImportError] = useState<string | null>(null);
  const [importingRepo, setImportingRepo] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // --- Authorized repos (fetched once on dialog open) ---
  const [authorizedRepos, setAuthorizedRepos] = useState<RepoInfo[] | null>(null);
  const [isLoadingAuthorized, setIsLoadingAuthorized] = useState(false);
  const [authorizedError, setAuthorizedError] = useState<string | null>(null);

  // Derived: set of authorized repo fullNames for O(1) badge lookup
  const authorizedSet = useMemo(() => {
    if (!authorizedRepos) return new Set<string>();
    return new Set(authorizedRepos.map((r) => r.fullName));
  }, [authorizedRepos]);

  // Derived: all authorized repos sorted so not-yet-imported repos appear
  // first and imported ones sink to the bottom.
  const sortedAuthorizedRepos = useMemo(() => {
    if (!authorizedRepos) return null;
    if (!importedSummaries) return authorizedRepos;
    return authorizedRepos.slice().sort((a, b) => {
      const aImported = a.fullName in importedSummaries ? 1 : 0;
      const bImported = b.fullName in importedSummaries ? 1 : 0;
      return aImported - bImported;
    });
  }, [authorizedRepos, importedSummaries]);

  // --- Public tab state ---
  const [publicInput, setPublicInput] = useState("");
  const [branch, setBranch] = useState("");
  const [importStage, setImportStage] = useState<"idle" | "verifying" | "importing">("idle");
  const [searchResults, setSearchResults] = useState<RepoInfo[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const isUrlMode = isGitHubUrl(publicInput);

  // Client-side filtered authorized repos (filter by search input).
  const filteredAuthorizedRepos = useMemo(() => {
    if (!sortedAuthorizedRepos) return null;
    const query = publicInput.trim().toLowerCase();
    if (!query || isUrlMode) return sortedAuthorizedRepos;
    return sortedAuthorizedRepos.filter((r) => r.fullName.toLowerCase().includes(query));
  }, [sortedAuthorizedRepos, publicInput, isUrlMode]);

  // GitHub search results excluding repos already in the authorized list.
  const externalSearchResults = useMemo(() => {
    if (!searchResults || !filteredAuthorizedRepos) return null;
    const visibleAuthorizedSet = new Set(filteredAuthorizedRepos.map((r) => r.fullName));
    return searchResults.filter((r) => !visibleAuthorizedSet.has(r.fullName));
  }, [searchResults, filteredAuthorizedRepos]);

  // Open the GitHub App installation settings in a popup so the user can
  // grant access to additional repos. The existing window-focus listener
  // auto-refreshes the repo list when the user returns.
  const handleAdjustPermissions = useCallback(() => {
    if (!installationId) return;
    const url = `https://github.com/settings/installations/${installationId}`;
    window.open(url, "systify-github-permissions", "width=1020,height=720,popup=yes");
  }, [installationId]);

  // Track the latest search request to avoid stale results
  const inputRef = useRef<HTMLInputElement>(null);
  const latestSearchRef = useRef(0);

  // Track whether we're waiting for the popup-based GitHub install to
  // complete. While `true`, the dialog shows a "Waiting for authorization…"
  // state instead of the default "Connect GitHub" button.
  const [isAwaitingPopup, setIsAwaitingPopup] = useState(false);
  const popupRef = useRef<Window | null>(null);

  // When the Convex subscription flips `isConnected` from false → true while
  // we're still waiting on the popup, the install succeeded — clean up.
  useEffect(() => {
    if (isAwaitingPopup && isConnected) {
      setIsAwaitingPopup(false);
      popupRef.current?.close();
      popupRef.current = null;
    }
  }, [isAwaitingPopup, isConnected]);

  // Poll for popup closure so we can reset the waiting state if the user
  // closes the popup without finishing (or if a popup blocker prevented it
  // from opening in the first place).
  useEffect(() => {
    if (!isAwaitingPopup) return;
    const timer = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        popupRef.current = null;
        setIsAwaitingPopup(false);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [isAwaitingPopup]);

  const [isConnectingGitHub, handleConnectGitHub] = useAsyncCallback(async () => {
    setConnectError(null);
    try {
      const redirectUrl = await initiateGitHubInstall({
        returnTo: window.location.href,
      });

      // Attempt popup first — dialog stays open, user never leaves the page.
      // Falls back to full-page redirect when the popup is blocked.
      const popup = window.open(redirectUrl, "systify-github-install", "width=1020,height=720,popup=yes");

      if (popup && !popup.closed) {
        popupRef.current = popup;
        setIsAwaitingPopup(true);
        // The Convex reactive query will flip `isConnected` once the
        // callback handler saves the installation — the effect above
        // cleans up the popup and resets the state automatically.
      } else {
        // Popup blocked — fall back to full-page redirect.
        markPendingImport();
        window.location.assign(redirectUrl);
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Failed to connect GitHub.");
    }
  });

  // Fetch authorized repos
  const fetchAuthorizedRepos = useCallback(async () => {
    setIsLoadingAuthorized(true);
    setAuthorizedError(null);
    try {
      const result = await listRepos({});
      setAuthorizedRepos(result.repos);
    } catch (err) {
      setAuthorizedError(err instanceof Error ? err.message : "Failed to load repos");
    } finally {
      setIsLoadingAuthorized(false);
    }
  }, [listRepos]);

  // Fetch authorized repos when the dialog is open and the connection becomes
  // available. This covers the race condition where the dialog opens before
  // the GitHub connection status query has resolved — without this effect
  // fetchAuthorizedRepos would never be called and the Private tab stays empty.
  useEffect(() => {
    if (open && isConnected && !authorizedRepos && !isLoadingAuthorized) {
      void fetchAuthorizedRepos();
    }
  }, [open, isConnected, authorizedRepos, isLoadingAuthorized, fetchAuthorizedRepos]);

  // Auto-refresh authorized repos when the user returns to the window (e.g.
  // after configuring repos on GitHub in another tab).
  useEffect(() => {
    if (!open || !isConnected) return;

    const handleFocus = () => {
      void fetchAuthorizedRepos();
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [open, isConnected, fetchAuthorizedRepos]);

  // Debounced search effect
  useEffect(() => {
    const trimmed = publicInput.trim();

    if (isUrlMode || trimmed.length < 2) {
      // Increment requestId to invalidate any pending search requests
      latestSearchRef.current++;
      setSearchResults(null);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const requestId = ++latestSearchRef.current;

    const timer = setTimeout(() => {
      searchReposAction({ query: trimmed })
        .then((result) => {
          if (requestId === latestSearchRef.current) {
            setSearchResults(result.repos);
            setSearchError(null);
          }
        })
        .catch((err) => {
          if (requestId === latestSearchRef.current) {
            setSearchError(err instanceof Error ? err.message : "Search failed");
            setSearchResults(null);
          }
        })
        .finally(() => {
          if (requestId === latestSearchRef.current) {
            setIsSearching(false);
          }
        });
    }, 500);

    return () => clearTimeout(timer);
  }, [publicInput, isUrlMode, searchReposAction]);

  // Check if the URL-mode repo is authorized
  const urlRepoAuthorized = useMemo(() => {
    if (!isUrlMode || !publicInput.trim()) return false;
    try {
      const match = publicInput.match(/github\.com\/([^/]+\/[^/\s#?]+)/);
      if (match) {
        const fullName = match[1].replace(/\.git$/, "");
        return authorizedSet.has(fullName);
      }
    } catch {
      // ignore parse errors
    }
    return false;
  }, [isUrlMode, publicInput, authorizedSet]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen && isConnected) {
        void fetchAuthorizedRepos();
      }
      if (!nextOpen) {
        setPublicInput("");
        setBranch("");
        setImportError(null);
        setConnectError(null);
        setImportingRepo(null);
        setSearchResults(null);
        setSearchError(null);
        setImportStage("idle");
        // Clean up popup if the user closes the dialog mid-flow.
        if (popupRef.current) {
          popupRef.current.close();
          popupRef.current = null;
        }
        setIsAwaitingPopup(false);
      }
    },
    [fetchAuthorizedRepos, isConnected],
  );

  // Import by URL
  async function handleImportByUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setImportError(null);
    setImportStage("verifying");
    try {
      await verifyAccess({ url: publicInput });
      setImportStage("importing");
      const result = await createRepositoryImport({
        url: publicInput,
        branch: branch.trim() || undefined,
      });
      setPublicInput("");
      setBranch("");
      // Navigate first, close dialog second. `onImported` calls `navigate()`
      // synchronously, so the route change and the dialog state update batch
      // into the same React render — the dialog unmounts as part of the
      // route transition instead of playing its close animation against a
      // page that's already swapping out.
      onImported(
        result.repositoryId,
        result.defaultThreadId ?? null,
        result.workspaceId,
        result.defaultThreadId ? result.defaultThreadMode : null,
      );
      setOpen(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImportStage("idle");
    }
  }

  // Import from list (search result or authorized repo)
  async function handleImportFromList(repo: RepoInfo) {
    setImportingRepo(repo.fullName);
    setImportError(null);
    try {
      const result = await createRepositoryImport({
        url: `https://github.com/${repo.fullName}`,
      });
      // See `handleImportByUrl` for why navigation happens before `setOpen(false)`.
      onImported(
        result.repositoryId,
        result.defaultThreadId ?? null,
        result.workspaceId,
        result.defaultThreadId ? result.defaultThreadMode : null,
      );
      setOpen(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImportingRepo(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="secondary" size="icon" aria-label="Add repository" title="Add repository">
            <PlusIcon weight="bold" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="flex h-[560px] flex-col overflow-y-hidden data-[state=open]:animate-none">
        <DialogHeader className="shrink-0">
          <DialogTitle>Import Repository</DialogTitle>
          {!isConnected && <DialogDescription>Install the Systify GitHub App to get started.</DialogDescription>}
        </DialogHeader>

        {!isConnected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6">
            {isAwaitingPopup ? (
              /* ---- Waiting for popup authorization ---- */
              <>
                <div className="flex flex-col items-center gap-3 text-center">
                  <CircleNotchIcon size={28} className="animate-spin text-primary" />
                  <p className="text-sm font-medium text-foreground">Waiting for GitHub&hellip;</p>
                  <p className="max-w-xs text-xs text-muted-foreground">Complete the setup in the popup window.</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  onClick={() => {
                    popupRef.current?.close();
                    popupRef.current = null;
                    setIsAwaitingPopup(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              /* ---- Initial connect prompt ---- */
              <>
                {/* Feature highlights */}
                <div className="flex w-full max-w-xs flex-col gap-3">
                  {[
                    {
                      icon: <EyeIcon size={16} weight="duotone" className="text-primary" />,
                      text: "Read-only access to your repository contents",
                    },
                    {
                      icon: <ShieldCheckIcon size={16} weight="duotone" className="text-primary" />,
                      text: "Code is never stored beyond the active session",
                    },
                    {
                      icon: <ArrowsClockwiseIcon size={16} weight="duotone" className="text-primary" />,
                      text: "Change repo access anytime in GitHub Settings",
                    },
                  ].map((item, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-3.5 py-2.5"
                    >
                      <span className="flex shrink-0 items-center justify-center rounded-md border border-border/60 bg-background p-1.5">
                        {item.icon}
                      </span>
                      <span className="text-[13px] leading-snug text-muted-foreground">{item.text}</span>
                    </div>
                  ))}
                </div>

                {/* Connect button */}
                <Button
                  type="button"
                  variant="default"
                  className="gap-2 px-8 shadow-md shadow-primary/20"
                  disabled={isConnectingGitHub}
                  onClick={() => void handleConnectGitHub()}
                >
                  {isConnectingGitHub ? (
                    <>
                      <CircleNotchIcon size={15} className="animate-spin" />
                      Connecting…
                    </>
                  ) : (
                    <>
                      <GithubLogoIcon size={15} weight="fill" />
                      Install GitHub App
                    </>
                  )}
                </Button>
                {connectError ? <p className="text-xs text-destructive">{connectError}</p> : null}
              </>
            )}
          </div>
        ) : (
          /* ---- Connected: unified repo list (Vercel-style) ---- */
          <>
            {/* Search / URL input */}
            <div className="relative shrink-0">
              <MagnifyingGlassIcon
                size={14}
                weight="bold"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={inputRef}
                value={publicInput}
                onChange={(e) => {
                  setPublicInput(e.target.value);
                  setImportError(null);
                }}
                placeholder={STATIC_PLACEHOLDER}
                aria-label={STATIC_PLACEHOLDER}
                className="pl-8"
              />
            </div>

            {/* URL import mode */}
            {isUrlMode ? (
              <form
                className="mt-3 flex min-h-0 flex-1 flex-col gap-3"
                onSubmit={(e) => {
                  void handleImportByUrl(e);
                }}
              >
                {urlRepoAuthorized && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheckIcon size={14} weight="fill" className="text-primary" />
                    <span>This repo is in your authorized list.</span>
                  </div>
                )}
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="Branch (leave empty for repo default)"
                />

                {importError && <p className="text-xs text-destructive">{importError}</p>}

                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="secondary">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    type="submit"
                    variant="default"
                    className="min-w-36"
                    disabled={importStage !== "idle" || !publicInput.trim()}
                  >
                    {importStage === "verifying"
                      ? "Checking access…"
                      : importStage === "importing"
                        ? "Queuing import…"
                        : "Import"}
                  </Button>
                </DialogFooter>
              </form>
            ) : (
              /* Repo list */
              <div className="flex min-h-0 flex-1 flex-col pt-1">
                {isLoadingAuthorized && !authorizedRepos ? (
                  /* Loading skeletons */
                  <div className="space-y-3 px-1">
                    {Array.from({ length: 4 }, (_, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 border-b border-border/50 py-3 last:border-b-0"
                      >
                        <Skeleton className="h-8 w-8 rounded-full" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <Skeleton className="h-4 w-40" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                        <Skeleton className="h-8 w-28" />
                      </div>
                    ))}
                  </div>
                ) : authorizedError ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2">
                    <p className="text-sm text-destructive">{authorizedError}</p>
                    <Button variant="ghost" size="sm" onClick={() => void fetchAuthorizedRepos()}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <ScrollArea className="min-h-0 flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
                    <div className="flex flex-col pr-3">
                      {/* Authorized repos (filtered client-side by search input) */}
                      {filteredAuthorizedRepos &&
                        filteredAuthorizedRepos.length > 0 &&
                        filteredAuthorizedRepos.map((repo) => (
                          <RepoRow
                            key={repo.fullName}
                            repo={repo}
                            isAuthorized={true}
                            isImporting={importingRepo === repo.fullName}
                            onImport={() => void handleImportFromList(repo)}
                            importSummary={importedSummaries?.[repo.fullName]}
                          />
                        ))}

                      {/* GitHub-wide search results (excludes already-authorized) */}
                      {publicInput.trim().length >= 2 && (
                        <>
                          {isSearching && !searchResults ? (
                            <div className="flex items-center justify-center gap-2 py-6">
                              <CircleNotchIcon size={16} className="animate-spin text-muted-foreground" />
                              <p className="text-sm text-muted-foreground">Searching GitHub…</p>
                            </div>
                          ) : searchError ? (
                            <p className="py-4 text-center text-sm text-destructive">{searchError}</p>
                          ) : externalSearchResults && externalSearchResults.length > 0 ? (
                            <>
                              {isSearching && (
                                <div className="flex items-center justify-center gap-1.5 border-b border-border/50 py-2.5">
                                  <CircleNotchIcon size={12} className="animate-spin text-muted-foreground" />
                                  <span className="text-[11px] text-muted-foreground">Updating…</span>
                                </div>
                              )}
                              <p className="mb-1 mt-3 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                                More on GitHub
                              </p>
                              {externalSearchResults.map((repo) => (
                                <RepoRow
                                  key={repo.fullName}
                                  repo={repo}
                                  isAuthorized={false}
                                  isImporting={importingRepo === repo.fullName}
                                  onImport={() => void handleImportFromList(repo)}
                                  importSummary={importedSummaries?.[repo.fullName]}
                                />
                              ))}
                            </>
                          ) : null}
                        </>
                      )}

                      {/* Empty state: no authorized repos and no search */}
                      {(!filteredAuthorizedRepos || filteredAuthorizedRepos.length === 0) &&
                        !isSearching &&
                        publicInput.trim().length < 2 && (
                          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                            <p className="text-sm text-muted-foreground">No repositories yet.</p>
                            <p className="text-xs text-muted-foreground">
                              Grant access below, or search any public repo above.
                            </p>
                          </div>
                        )}

                      {/* No results for a search query */}
                      {publicInput.trim().length >= 2 &&
                        (!filteredAuthorizedRepos || filteredAuthorizedRepos.length === 0) &&
                        searchResults &&
                        searchResults.length === 0 &&
                        !isSearching && (
                          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                            <p className="text-sm text-muted-foreground">
                              No repositories found for &ldquo;{publicInput.trim()}&rdquo;
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Try a different term, or paste a full GitHub URL.
                            </p>
                          </div>
                        )}
                    </div>
                  </ScrollArea>
                )}

                {importError && <p className="mt-2 shrink-0 text-xs text-destructive">{importError}</p>}
              </div>
            )}

            {/* Footer: adjust permissions (Vercel-style) */}
            {!isUrlMode && installationId && (
              <div className="shrink-0 border-t border-border/50 pt-3 text-[13px] text-muted-foreground">
                Missing a repository?{" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-[13px] font-medium"
                  onClick={handleAdjustPermissions}
                >
                  Adjust GitHub App Permissions
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
