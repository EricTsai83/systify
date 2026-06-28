import { useCallback, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { writeLocalEditorConfig, type LocalEditorKind, type LocalEditorRepositoryConfig } from "@/lib/local-editor";
import type { RepositoryId } from "@/lib/types";

export function LocalEditorSetupDialog({
  open,
  onOpenChange,
  repositoryId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositoryId: RepositoryId | null;
  onSaved: (config: LocalEditorRepositoryConfig) => void;
}) {
  const [rootPath, setRootPath] = useState("");
  const [editor, setEditor] = useState<LocalEditorKind>("cursor");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!repositoryId) {
        setError("Repository information is not available for this citation.");
        return;
      }
      const trimmedRootPath = rootPath.trim();
      if (!trimmedRootPath.startsWith("/")) {
        setError("Enter an absolute local path that starts with /.");
        return;
      }
      const config: LocalEditorRepositoryConfig = {
        editor,
        rootPath: trimmedRootPath,
        updatedAt: Date.now(),
      };
      writeLocalEditorConfig(repositoryId, config);
      setError(null);
      onOpenChange(false);
      onSaved(config);
    },
    [editor, onOpenChange, onSaved, repositoryId, rootPath],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Open code citations locally</DialogTitle>
            <DialogDescription>
              Set the local checkout path for this repository. This stays in this browser and is not sent to Systify.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <label htmlFor="local-editor-root-path" className="text-sm font-medium">
              Local repository path
            </label>
            <Input
              id="local-editor-root-path"
              value={rootPath}
              onChange={(event) => {
                setRootPath(event.target.value);
                if (error) setError(null);
              }}
              placeholder="/Users/you/code/repo-name"
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "local-editor-root-path-error" : undefined}
            />
            {error ? (
              <p id="local-editor-root-path-error" className="text-xs font-medium text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <label htmlFor="local-editor-kind" className="text-sm font-medium">
              Editor
            </label>
            <Select value={editor} onValueChange={(value) => setEditor(value === "vscode" ? "vscode" : "cursor")}>
              <SelectTrigger id="local-editor-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cursor">Cursor</SelectItem>
                <SelectItem value="vscode">VS Code</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save and open</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
