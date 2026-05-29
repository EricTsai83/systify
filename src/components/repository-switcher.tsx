import { memo, useState } from "react";
import { CaretUpDownIcon, CheckIcon, GitBranchIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Combobox, ComboboxActionRow } from "@/components/combobox";
import { ImportRepoDialog } from "@/components/import-repo-dialog";
import type { OnImportedCallback, RepositoryId } from "@/lib/types";

// Repository selector — popover-based combobox that shows the current
// repository name and lets the user switch repositories, jump back to the
// repoless `/chat` surface, or import a new repository. Sits next to the
// compact profile avatar in the sidebar footer row.
export const RepositorySelector = memo(function RepositorySelector({
  repositories,
  activeRepositoryId,
  onSwitchRepository,
  onSelectNoRepository,
  onImported,
}: {
  repositories: Doc<"repositories">[] | undefined;
  activeRepositoryId: RepositoryId | null;
  onSwitchRepository: (id: RepositoryId) => void;
  // When supplied, the combobox surfaces a "No repository" header item that
  // navigates the user back to the repoless `/chat` surface.
  onSelectNoRepository?: () => void;
  onImported: OnImportedCallback;
}) {
  const activeRepository = repositories?.find((repo) => repo._id === activeRepositoryId);
  const isRepoless = activeRepositoryId === null;
  // Owned out here (not inside Combobox's footer) so the dialog survives
  // popover close — otherwise the dialog unmounts the moment its trigger row
  // disappears, before it can even render.
  const [isImportDialogOpen, setImportDialogOpen] = useState(false);

  if (repositories === undefined) {
    return (
      <div className="min-w-0 flex-1">
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  return (
    <>
      <Combobox
        items={repositories}
        getItemKey={(repo) => repo._id}
        getSearchText={(repo) => repo.sourceRepoFullName}
        isItemActive={(repo) => repo._id === activeRepositoryId}
        onSelect={(repo) => {
          if (repo._id !== activeRepositoryId) onSwitchRepository(repo._id);
        }}
        renderItem={(repo, { isActive }) => (
          <>
            <span className="min-w-0 flex-1 truncate">{repo.sourceRepoFullName}</span>
            {isActive ? <CheckIcon size={14} weight="bold" className="shrink-0 text-primary" /> : null}
          </>
        )}
        side="top"
        align="start"
        contentClassName="w-56"
        searchPlaceholder="Search repositories…"
        emptyHint="No repositories yet."
        ariaLabel="Search repositories"
        header={
          onSelectNoRepository ? (
            <ComboboxActionRow
              onSelect={() => {
                if (!isRepoless) onSelectNoRepository();
              }}
              isActive={isRepoless}
            >
              <span className="min-w-0 flex-1 truncate">No repository</span>
              {isRepoless ? <CheckIcon size={14} weight="bold" className="shrink-0 text-primary" /> : null}
            </ComboboxActionRow>
          ) : undefined
        }
        footer={
          <ComboboxActionRow onSelect={() => setImportDialogOpen(true)}>
            <GitBranchIcon size={14} weight="bold" className="shrink-0" />
            <span>Import repository</span>
          </ComboboxActionRow>
        }
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-0 flex-1 justify-start gap-2 bg-background px-2 active:scale-100"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {activeRepository?.sourceRepoFullName ?? (isRepoless ? "No repository" : "Select repository")}
            </span>
            <CaretUpDownIcon size={14} weight="bold" className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <ImportRepoDialog onImported={onImported} open={isImportDialogOpen} onOpenChange={setImportDialogOpen} />
    </>
  );
});
