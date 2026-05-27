import { memo } from "react";
import { CaretUpDown, CheckIcon, GitBranchIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ImportRepoDialog } from "@/components/import-repo-dialog";
import type { OnImportedCallback, RepositoryId } from "@/lib/types";

// Repository selector — a dropdown that shows the current repository name
// and lets the user switch repositories or import new ones. Sits next to
// the compact profile avatar in the sidebar footer row.
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
  // When supplied, the dropdown surfaces a "No repository" item that
  // navigates the user back to the repoless `/chat` surface. Optional so
  // callers that don't want to expose the repoless context (none today,
  // but kept flexible) can omit it.
  onSelectNoRepository?: () => void;
  onImported: OnImportedCallback;
}) {
  const activeRepository = repositories?.find((repo) => repo._id === activeRepositoryId);
  const isRepoless = activeRepositoryId === null;

  if (repositories === undefined) {
    return (
      <div className="min-w-0 flex-1">
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-0 flex-1 justify-start gap-2 bg-background px-2 active:scale-100"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {activeRepository?.sourceRepoFullName ?? (isRepoless ? "No repository" : "Select repository")}
          </span>
          <CaretUpDown size={14} weight="bold" className="shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-56">
        {onSelectNoRepository ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                if (!isRepoless) onSelectNoRepository();
              }}
              className="gap-2"
            >
              <span className="min-w-0 flex-1 truncate">No repository</span>
              {isRepoless && <CheckIcon size={14} weight="bold" className="shrink-0 text-primary" />}
            </DropdownMenuItem>
            {repositories.length > 0 ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}

        {repositories.length > 0 && (
          <>
            {repositories.map((repo) => {
              const isActive = repo._id === activeRepositoryId;
              return (
                <DropdownMenuItem
                  key={repo._id}
                  onSelect={() => {
                    if (!isActive) onSwitchRepository(repo._id);
                  }}
                  className="gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">{repo.sourceRepoFullName}</span>
                  {isActive && <CheckIcon size={14} weight="bold" className="shrink-0 text-primary" />}
                </DropdownMenuItem>
              );
            })}

            <DropdownMenuSeparator />
          </>
        )}

        <ImportRepoDialog
          onImported={onImported}
          trigger={
            <DropdownMenuItem onSelect={(event) => event.preventDefault()} className="gap-2">
              <GitBranchIcon size={14} weight="bold" className="shrink-0" />
              <span>Import repository</span>
            </DropdownMenuItem>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
