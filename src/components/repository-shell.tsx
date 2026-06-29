import { ArchiveIcon, ArrowCounterClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { AppNotice } from "@/components/app-notice";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { ChatContainer } from "@/components/chat-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { StatusPanel } from "@/components/status-panel";
import { ThreadSearchDialog } from "@/components/thread-search-dialog";
import { TopBar } from "@/components/top-bar";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { SidebarInset } from "@/components/ui/sidebar";
import { useRepositoryWorkspaceState } from "@/components/chat-shell-shared/use-repository-workspace-state";
import type { RepositoryId, ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

const MOBILE_DRAWER_HEIGHT_CLASS = "h-[95dvh] data-[vaul-drawer-direction=bottom]:max-h-[95dvh]";

export function RepositoryShell({
  urlRepositoryId,
  urlThreadId,
  isNewThreadRoute = false,
}: {
  urlRepositoryId: RepositoryId | null;
  urlThreadId: ThreadId | null;
  isNewThreadRoute?: boolean;
}) {
  const workspace = useRepositoryWorkspaceState({ urlRepositoryId, urlThreadId, isNewThreadRoute });
  const repositorySource = workspace.repoDetail?.repository
    ? {
        repositoryId: workspace.repoDetail.repository._id,
        sourceRepoFullName: workspace.repoDetail.repository.sourceRepoFullName,
        defaultBranch: workspace.repoDetail.repository.defaultBranch,
        lastSyncedCommitSha: workspace.repoDetail.repository.lastSyncedCommitSha,
      }
    : undefined;

  const chatContainerNode = (
    <ChatContainer
      selectedThreadId={workspace.selectedThreadId}
      isShellLoading={workspace.isChatShellLoading}
      composer={workspace.composer}
      chatMode={workspace.chatMode}
      hasAttachedRepository={workspace.capabilities.attachedRepository !== null}
      onSelectArtifact={workspace.panels.artifact.selectArtifact}
      repositorySource={repositorySource}
      attachedRepositoryId={workspace.capabilities.attachedRepository?.id}
    />
  );

  return (
    <>
      <AppSidebarLeft
        repositories={workspace.repositories}
        activeRepositoryId={workspace.selectedRepositoryId}
        onSwitchRepository={workspace.handlers.switchRepository}
        selectedThreadId={workspace.selectedThreadId}
        onSelectThread={workspace.handlers.selectThread}
        onDeleteThread={workspace.handlers.requestArchiveThread}
        onRequestNewThread={workspace.handlers.requestNewThread}
        onImported={workspace.handlers.imported}
        onError={workspace.handlers.setActionError}
        importDisabledReason={workspace.importDisabledReason}
      />

      <SidebarInset>
        <TopBar
          repoDetail={workspace.repoDetail ?? undefined}
          isRepoDetailLoading={workspace.selectedRepositoryId !== null && workspace.repoDetail === undefined}
          isSyncing={workspace.isSyncing}
          isStatusPanelOpen={workspace.panels.status.isOpen}
          onSetStatusPanelOpen={workspace.panels.status.setOpen}
          onArchiveRepo={workspace.handlers.requestArchiveRepository}
          onRestoreRepo={workspace.handlers.restoreRepository}
          onPermanentDeleteRepo={workspace.handlers.requestPermanentDeleteRepository}
          threadId={workspace.selectedThreadId}
          attachedRepository={workspace.capabilities.attachedRepository}
          availableRepositories={workspace.repositories ?? []}
          onThreadMovedToRepository={workspace.handlers.threadMovedToRepository}
          isDesktopLayout={workspace.isDesktopLayout}
          onSearchThreads={workspace.panels.threadSearch.open}
          onNewThread={workspace.handlers.requestNewThread}
          onSync={workspace.handlers.sync}
          syncDisabledReason={workspace.syncDisabledReason}
          onViewArtifact={workspace.panels.artifact.selectArtifact}
          showSystemStatus={workspace.isRepositoryStatusEnabled}
        />

        <ThreadSearchDialog
          open={workspace.panels.threadSearch.isOpen}
          onOpenChange={workspace.panels.threadSearch.setOpen}
          repositoryId={workspace.selectedRepositoryId}
          mode={workspace.chatMode}
          selectedThreadId={workspace.selectedThreadId}
          onSelectThread={workspace.handlers.selectThread}
        />

        {workspace.isRepoArchived ? (
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
                disabled={workspace.isRestoringRepository}
                onClick={workspace.handlers.restoreRepository}
              >
                <ArrowCounterClockwiseIcon weight="bold" />
                <ButtonStateText
                  current={workspace.isRestoringRepository ? "Restoring…" : "Restore"}
                  states={["Restore", "Restoring…"]}
                />
              </Button>
            </div>
          </div>
        ) : null}

        {workspace.actionError ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice
              title="Action failed"
              message={workspace.actionError}
              tone="error"
              onDismiss={workspace.handlers.dismissActionError}
              dismissLabel="Dismiss action error"
            />
          </div>
        ) : workspace.actionNotice ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice title={workspace.actionNotice.title} message={workspace.actionNotice.message} tone="info" />
          </div>
        ) : null}

        {!workspace.isRepoArchived && workspace.repoDetail?.repository.importStatus === "failed" ? (
          <ImportFailedBanner
            errorMessage={workspace.repoDetail.latestFailedImportError}
            isSyncing={workspace.isSyncing}
            syncDisabledReason={workspace.syncDisabledReason}
            onRetry={workspace.handlers.sync}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          {workspace.isRepoMissing ? (
            <RepositoryMissingState onBack={workspace.handlers.backToDefault} />
          ) : (
            chatContainerNode
          )}
        </div>
      </SidebarInset>

      {!workspace.isDesktopLayout && workspace.repoDetail && workspace.isRepositoryStatusEnabled ? (
        <Drawer
          open={workspace.panels.status.isOpen}
          onOpenChange={workspace.panels.status.setOpen}
          aria-label="status-drawer"
        >
          <DrawerContent className={cn(MOBILE_DRAWER_HEIGHT_CLASS, "rounded-t-2xl")}>
            <DrawerTitle className="sr-only">Repository status</DrawerTitle>
            <DrawerDescription className="sr-only">
              Current sync, sandbox, and analysis state, with recent activity and operation launchers.
            </DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col">
              <StatusPanel
                repository={workspace.repoDetail.repository}
                sandboxModeStatus={workspace.repoDetail.sandboxModeStatus}
                sandbox={workspace.repoDetail.sandbox}
                jobs={workspace.repoDetail.jobs}
                artifacts={workspace.repoDetail.artifacts}
                hasRemoteUpdates={workspace.repoDetail.hasRemoteUpdates}
                isSyncing={workspace.isSyncing}
                onSync={workspace.handlers.sync}
                syncDisabledReason={workspace.syncDisabledReason}
                onViewArtifact={workspace.panels.artifact.selectArtifact}
                onClose={workspace.panels.status.close}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={workspace.dialogs.threadArchive.isOpen}
        onOpenChange={workspace.dialogs.threadArchive.setOpen}
        title="Archive thread"
        description="This removes the thread from active history. You can restore or permanently delete it from Archive."
        actionLabel="Archive thread"
        loadingLabel="Archiving…"
        isPending={workspace.dialogs.threadArchive.isPending}
        onConfirm={workspace.dialogs.threadArchive.confirm}
      />

      <ConfirmDialog
        open={workspace.dialogs.repositoryArchive.isOpen}
        onOpenChange={workspace.dialogs.repositoryArchive.setOpen}
        title="Archive repository"
        description="The repository disappears from your sidebar. Threads, messages, and artifacts are preserved — sandboxes are stopped to free resources. Restore any time from your archive."
        actionLabel="Archive repository"
        loadingLabel="Archiving…"
        isPending={workspace.dialogs.repositoryArchive.isPending}
        onConfirm={workspace.dialogs.repositoryArchive.confirm}
      />

      <ConfirmDialog
        open={workspace.dialogs.permanentDelete.isOpen}
        onOpenChange={workspace.dialogs.permanentDelete.setOpen}
        title="Permanently delete repository?"
        description="This will permanently delete this repository and all its threads, messages, analysis artifacts, jobs, and indexed files. This action cannot be undone."
        actionLabel="Delete permanently"
        loadingLabel="Deleting…"
        isPending={workspace.dialogs.permanentDelete.isPending}
        onConfirm={workspace.dialogs.permanentDelete.confirm}
      />

      {workspace.selectedRepositoryId ? (
        <GenerateSystemDesignDialog
          open={workspace.dialogs.generateSystemDesign.isOpen}
          onOpenChange={workspace.dialogs.generateSystemDesign.setOpen}
          repositoryId={workspace.selectedRepositoryId}
          disabledReason={workspace.generateSystemDesignDisabledReason}
          premiumModelsDisabledReason={workspace.premiumModelsDisabledReason}
          highReasoningDisabledReason={workspace.highReasoningDisabledReason}
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
  syncDisabledReason,
  onRetry,
}: {
  errorMessage: string | null;
  isSyncing: boolean;
  syncDisabledReason?: string;
  onRetry: () => void;
}) {
  const retryDisabled = isSyncing || syncDisabledReason !== undefined;
  return (
    <div className="flex shrink-0 flex-col border-b border-destructive/40 bg-destructive/5 px-6 py-3 text-destructive">
      <div role="alert" aria-live="assertive" aria-atomic="true" className="flex items-start gap-2">
        <WarningCircleIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Repository import failed</p>
          <p className="mt-0.5 text-xs leading-5">
            The latest sync did not finish. Retry to restore repo-aware features for this repository.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          disabled={retryDisabled}
          title={syncDisabledReason}
          onClick={onRetry}
        >
          <ButtonStateText current={isSyncing ? "Retrying…" : "Retry sync"} states={["Retry sync", "Retrying…"]} />
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
