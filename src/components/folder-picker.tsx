import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CaretDownIcon, CheckIcon, FolderIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { FOLDER_NAME_MAX_LENGTH } from "../../convex/lib/artifactFolderDefaults";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { buildFolderTree, type FolderTreeNode } from "@/lib/artifact-folders";
import type { FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

type FolderPickerProps = {
  repositoryId: RepositoryId | null;
  value: FolderId | null;
  onChange: (folderId: FolderId | null) => void;
  /**
   * Optional helper text shown under the selector. Useful when the dialog
   * needs to explain why a folder is suggested ("Defaulted from this
   * thread's last artifact placement").
   */
  hint?: string;
  /**
   * Optional class name for the trigger button — lets the dialog align
   * with the rest of its form fields without forcing a wrapper div.
   */
  className?: string;
  /**
   * Disabled state. The picker still renders so the dialog layout doesn't
   * jump; the trigger and "+ New folder" affordance are inert.
   */
  disabled?: boolean;
};

/**
 * Folder selector for generation dialogs (failure-mode analysis, deep
 * analyses, …). Two interactions:
 *
 *   1. Pick from existing — popover lists every folder in the repo as a
 *      flat (dot-separated) path so nested folders are still pickable in
 *      one click. "Repository root" is always available as the no-folder
 *      option.
 *   2. Create new — bottom of the popover has an inline input + "Create"
 *      button. On submit we create the folder, then immediately set the
 *      picker to the new id so the user can confirm the dialog without a
 *      second round-trip.
 *
 * The repo level kinds (manifest, architecture_overview, …) bypass this
 * picker entirely — they auto-place at the navigator's "Repository" root
 * in the write path, so the picker is only mounted for feature-level kinds
 * where folder placement is meaningful.
 */
export function FolderPicker({ repositoryId, value, onChange, hint, className, disabled }: FolderPickerProps) {
  const folders = useQuery(api.artifactFolders.listByRepository, repositoryId ? { repositoryId } : "skip");
  const createFolder = useMutation(api.artifactFolders.create);
  const [isOpen, setIsOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const flat = useMemo(() => flattenFolderTree(buildFolderTree(folders ?? [])), [folders]);
  const selected = value ? flat.find((entry) => entry.id === value) : null;
  const isNameTooLong = newFolderName.length > FOLDER_NAME_MAX_LENGTH;

  const [isCreating, runCreate] = useAsyncCallback(async () => {
    if (!repositoryId) return;
    const name = newFolderName.trim();
    if (!name) return;
    if (name.length > FOLDER_NAME_MAX_LENGTH) return;
    setCreateError(null);
    try {
      // The currently picked folder doubles as the parent — "create under
      // the thing I'm pointing at" matches the Navigator's selection-aware
      // create. `null` (Repository root) means no parent, so it lands as a
      // top-level folder.
      const folderId = await createFolder({
        repositoryId,
        name,
        parentFolderId: value ?? undefined,
      });
      onChange(folderId);
      setNewFolderName("");
      setIsOpen(false);
    } catch (error) {
      setCreateError(toUserErrorMessage(error, "Failed to create folder."));
    }
  });

  const triggerLabel = selected ? selected.path : "Repository root";

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !repositoryId}
            className="justify-between gap-2"
          >
            <span className="flex items-center gap-2 truncate">
              <FolderIcon size={13} weight="duotone" />
              <span className="truncate">{triggerLabel}</span>
            </span>
            <CaretDownIcon size={11} weight="bold" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-0" align="start">
          <ScrollArea className="max-h-72">
            <div className="flex flex-col">
              <FolderOption
                isSelected={value === null}
                label="Repository root"
                description="No folder. Repository-level artifacts always live here."
                onSelect={() => {
                  onChange(null);
                  setIsOpen(false);
                }}
              />
              {flat.length > 0 ? <div className="mt-1 border-t border-border" /> : null}
              {flat.map((entry) => (
                <FolderOption
                  key={entry.id}
                  isSelected={value === entry.id}
                  label={entry.path}
                  description={entry.description}
                  onSelect={() => {
                    onChange(entry.id);
                    setIsOpen(false);
                  }}
                />
              ))}
            </div>
          </ScrollArea>

          <div className="border-t border-border p-2">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  maxLength={FOLDER_NAME_MAX_LENGTH}
                  placeholder="New folder name"
                  className="h-8 flex-1 text-[12px]"
                  disabled={isCreating || !repositoryId}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !isNameTooLong) {
                      event.preventDefault();
                      void runCreate();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="h-8 gap-1"
                  disabled={isCreating || !newFolderName.trim() || !repositoryId || isNameTooLong}
                  onClick={() => void runCreate()}
                >
                  <FolderPlusIcon size={13} weight="bold" />
                  <ButtonStateText current={isCreating ? "Creating…" : "Create"} states={["Create", "Creating…"]} />
                </Button>
              </div>
              {isNameTooLong ? (
                <p className="text-[11px] text-destructive">
                  Folder name must be at most {FOLDER_NAME_MAX_LENGTH} characters.
                </p>
              ) : createError ? (
                <p className="text-[11px] text-destructive">{createError}</p>
              ) : null}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function FolderOption({
  isSelected,
  label,
  description,
  onSelect,
}: {
  isSelected: boolean;
  label: string;
  description?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-start gap-2 px-3 py-2 text-left text-[12px] hover:bg-muted/60",
        isSelected ? "bg-muted/60" : "",
      )}
      onClick={onSelect}
    >
      <span className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center text-primary">
        {isSelected ? <CheckIcon size={11} weight="bold" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-foreground">{label}</span>
        {description ? <span className="truncate text-[10px] text-muted-foreground">{description}</span> : null}
      </span>
    </button>
  );
}

type FlatFolderEntry = {
  id: FolderId;
  path: string;
  description?: string;
};

function flattenFolderTree(roots: FolderTreeNode[]): FlatFolderEntry[] {
  const out: FlatFolderEntry[] = [];
  const walk = (node: FolderTreeNode, prefix: string[]) => {
    const path = [...prefix, node.name].join(" / ");
    out.push({ id: node.id as FolderId, path, description: node.description });
    for (const child of node.children) {
      walk(child, [...prefix, node.name]);
    }
  };
  for (const root of roots) {
    walk(root, []);
  }
  return out;
}
