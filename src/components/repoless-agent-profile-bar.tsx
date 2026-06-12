import { useEffect, useState, type FormEvent } from "react";
import { RobotIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

export type RepolessAgentProfileValue = {
  singleTurnEnabled: boolean;
  agentRole: string;
  agentInstructions: string;
};

const AGENT_ROLE_MAX_LENGTH = 120;
const AGENT_INSTRUCTIONS_MAX_LENGTH = 3000;

export function RepolessAgentProfileBar({
  value,
  resetPending,
  disabled,
  onSave,
}: {
  value: RepolessAgentProfileValue;
  resetPending: boolean;
  disabled?: boolean;
  onSave: (next: RepolessAgentProfileValue) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setDraft(value);
    }
  }, [open, value]);

  const hasProfile = value.agentRole.trim().length > 0 || value.agentInstructions.trim().length > 0;
  const statusText = resetPending ? "Clearing previous messages…" : value.agentRole.trim() || "Single-turn";

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave(draft);
      setOpen(false);
    } catch {
      // The shell owns user-visible error copy.
    } finally {
      setIsSaving(false);
    }
  }

  async function handleQuickToggle(pressed: boolean) {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave({ ...value, singleTurnEnabled: pressed });
    } catch {
      // The shell owns user-visible error copy.
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      {value.singleTurnEnabled || hasProfile || resetPending ? (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline" title={statusText}>
          {statusText}
        </span>
      ) : null}
      <Toggle
        type="button"
        variant="outline"
        size="sm"
        pressed={value.singleTurnEnabled}
        disabled={disabled || resetPending || isSaving}
        aria-label="Toggle Single-turn"
        className={cn(value.singleTurnEnabled && "border-primary/40 bg-primary/10 text-primary")}
        onPressedChange={(pressed) => {
          void handleQuickToggle(pressed);
        }}
        data-testid="repoless-single-turn-toggle"
      >
        Single-turn
      </Toggle>
      <Button
        type="button"
        variant={hasProfile ? "secondary" : "outline"}
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid="repoless-agent-profile-button"
        className="h-7 shrink-0 px-2 text-xs"
      >
        <RobotIcon weight={hasProfile ? "fill" : "regular"} />
        <span className="hidden sm:inline">Agent Profile</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agent Profile</DialogTitle>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={(event) => void handleSave(event)}>
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              <span>Single-turn</span>
              <Toggle
                type="button"
                variant="outline"
                pressed={draft.singleTurnEnabled}
                disabled={resetPending || isSaving}
                onPressedChange={(pressed) => setDraft((current) => ({ ...current, singleTurnEnabled: pressed }))}
              >
                Single-turn
              </Toggle>
            </label>
            <label className="grid gap-2 text-sm font-medium">
              <span>Agent role</span>
              <Input
                value={draft.agentRole}
                maxLength={AGENT_ROLE_MAX_LENGTH}
                disabled={isSaving}
                onChange={(event) => setDraft((current) => ({ ...current, agentRole: event.target.value }))}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              <span>Instructions</span>
              <Textarea
                value={draft.agentInstructions}
                maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
                disabled={isSaving}
                className="min-h-36"
                onChange={(event) => setDraft((current) => ({ ...current, agentInstructions: event.target.value }))}
              />
            </label>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="secondary" disabled={isSaving}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="default" disabled={isSaving}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
