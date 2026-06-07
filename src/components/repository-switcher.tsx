import { memo, useState } from "react";
import { CaretUpDownIcon, CheckIcon, GitBranchIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { useComboboxAnchor } from "@/components/ui/use-combobox-anchor";
import { ImportRepoDialog } from "@/components/import-repo-dialog";
import { cn } from "@/lib/utils";
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
  importDisabledReason,
}: {
  repositories: Doc<"repositories">[] | undefined;
  activeRepositoryId: RepositoryId | null;
  onSwitchRepository: (id: RepositoryId) => void;
  // When supplied, the combobox surfaces a "No repository" row that
  // navigates the user back to the repoless `/chat` surface.
  onSelectNoRepository?: () => void;
  onImported: OnImportedCallback;
  importDisabledReason?: string;
}) {
  const activeRepository = repositories?.find((repo) => repo._id === activeRepositoryId);
  const isRepoless = activeRepositoryId === null;
  // Controlled so footer rows can imperatively close the popover before
  // navigating / opening a dialog.
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Owned out here (not inside the Combobox content) so the dialog survives
  // popover close — otherwise the dialog unmounts the moment its trigger row
  // disappears, before it can even render.
  const [isImportDialogOpen, setImportDialogOpen] = useState(false);
  // Explicit anchor — the popup keeps drifting away from the trigger when we
  // rely on Base UI's auto-detected trigger element through `render={<Button/>}`,
  // so we anchor the positioner to a wrapper div we own.
  const anchorRef = useComboboxAnchor();

  if (repositories === undefined) {
    return (
      <div className="min-w-0 flex-1">
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  return (
    <>
      <Combobox<Doc<"repositories">>
        items={repositories}
        value={activeRepository ?? null}
        onValueChange={(repo) => {
          if (repo && repo._id !== activeRepositoryId) onSwitchRepository(repo._id);
        }}
        itemToStringLabel={(repo) => repo.sourceRepoFullName}
        itemToStringValue={(repo) => repo._id}
        isItemEqualToValue={(item, value) => item._id === value._id}
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
      >
        <div ref={anchorRef} className="flex min-w-0 flex-1">
          <ComboboxTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full min-w-0 justify-start gap-2 bg-background px-2 active:scale-100"
              />
            }
            icon={<CaretUpDownIcon weight="bold" className="size-3.5 shrink-0 text-muted-foreground" />}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {activeRepository?.sourceRepoFullName ?? (isRepoless ? "No repository" : "Select repository")}
            </span>
          </ComboboxTrigger>
        </div>
        <ComboboxContent anchor={anchorRef} side="top" align="start" className="w-64">
          <ComboboxInput placeholder="Search repositories…" showTrigger={false} />
          {onSelectNoRepository ? (
            <button
              type="button"
              onClick={() => {
                setPopoverOpen(false);
                if (!isRepoless) onSelectNoRepository();
              }}
              className={cn(
                "relative flex w-full items-center gap-2.5 py-2 pr-9 pl-3 text-left text-sm transition-colors",
                isRepoless ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
            >
              <span className="min-w-0 flex-1 truncate">No repository</span>
              {isRepoless ? (
                <CheckIcon size={16} weight="bold" className="absolute right-2.5 shrink-0 text-primary" />
              ) : null}
            </button>
          ) : null}
          <ComboboxList>
            <ComboboxCollection>
              {(repo: Doc<"repositories">) => (
                <ComboboxItem key={repo._id} value={repo}>
                  <span className="min-w-0 flex-1 truncate">{repo.sourceRepoFullName}</span>
                </ComboboxItem>
              )}
            </ComboboxCollection>
            <ComboboxEmpty>No matches</ComboboxEmpty>
          </ComboboxList>
          <ComboboxSeparator />
          <button
            type="button"
            disabled={importDisabledReason !== undefined}
            title={importDisabledReason}
            onClick={() => {
              if (importDisabledReason) return;
              setPopoverOpen(false);
              setImportDialogOpen(true);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
              importDisabledReason ? "cursor-not-allowed text-muted-foreground/70" : "hover:bg-accent/60",
            )}
          >
            <GitBranchIcon size={16} weight="bold" className="shrink-0" />
            <span>Import repository</span>
          </button>
        </ComboboxContent>
      </Combobox>
      <ImportRepoDialog
        onImported={onImported}
        open={isImportDialogOpen}
        onOpenChange={setImportDialogOpen}
        importDisabledReason={importDisabledReason}
      />
    </>
  );
});
