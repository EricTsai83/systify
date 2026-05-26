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
import type { OnImportedCallback, WorkspaceId } from "@/lib/types";

// ---------------------------------------------------------------------------
// Workspace selector — a dropdown that shows the current workspace name and
// lets the user switch workspaces or import repositories. Sits next to the
// compact profile avatar in the sidebar footer row.
// ---------------------------------------------------------------------------

export const WorkspaceSelector = memo(function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onImported,
}: {
  workspaces: Doc<"workspaces">[] | undefined;
  activeWorkspaceId: WorkspaceId | null;
  onSwitchWorkspace: (id: WorkspaceId) => void;
  onImported: OnImportedCallback;
}) {
  const activeWorkspace = workspaces?.find((ws) => ws._id === activeWorkspaceId);

  if (workspaces === undefined) {
    return (
      <div className="min-w-0 flex-1">
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-0 flex-1 justify-start gap-2 bg-background px-2 active:scale-100"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {activeWorkspace?.name ?? "Select workspace"}
            </span>
            <CaretUpDown size={14} weight="bold" className="shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="top" align="start" className="w-56">
          {workspaces.length > 0 && (
            <>
              {workspaces.map((ws) => {
                const isActive = ws._id === activeWorkspaceId;
                return (
                  <DropdownMenuItem
                    key={ws._id}
                    onClick={() => {
                      if (!isActive) onSwitchWorkspace(ws._id);
                    }}
                    className="gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{ws.name}</span>
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
    </>
  );
});
