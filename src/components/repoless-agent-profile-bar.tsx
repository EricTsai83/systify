import { useEffect, useState, type FormEvent } from "react";
import { RobotIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

  const role = value.agentRole.trim();
  const hasInstructions = value.agentInstructions.trim().length > 0;
  const hasProfile = role.length > 0 || hasInstructions;
  const statusText = resetPending ? "Clearing previous messages..." : hasProfile ? "Configured" : "Default behavior";

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

  return (
    <div className="ml-auto flex min-w-0 items-center">
      <Button
        type="button"
        variant={hasProfile || value.singleTurnEnabled || resetPending ? "secondary" : "outline"}
        size="xs"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid="repoless-agent-profile-button"
        className={cn(
          "min-w-0 max-w-[52vw] justify-start gap-2 px-2 md:max-w-[24rem]",
          resetPending && "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15",
        )}
        title={statusText}
      >
        <RobotIcon weight={hasProfile ? "fill" : "regular"} />
        <span className="hidden min-w-0 truncate sm:inline">
          <span className="text-foreground">Agent Profile</span>
          {(hasProfile || resetPending) && (
            <span className="ml-1.5 text-muted-foreground" aria-hidden="true">
              {statusText}
            </span>
          )}
        </span>
        {value.singleTurnEnabled ? (
          <span className="shrink-0 border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-primary">
            Single-turn on
          </span>
        ) : null}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Agent Profile</DialogTitle>
            <DialogDescription>Set how this assistant behaves for the current repoless chat.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-5" onSubmit={(event) => void handleSave(event)}>
            <div className="flex items-center justify-between gap-4 border border-border bg-card/60 p-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">Single-turn mode</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  Start each reply from only the latest message. Turning it on clears previous messages in this chat.
                </div>
              </div>
              <Toggle
                type="button"
                variant="default"
                pressed={draft.singleTurnEnabled}
                disabled={resetPending || isSaving}
                aria-label="Toggle Single-turn mode"
                data-testid="repoless-single-turn-toggle"
                className={cn(
                  "h-6 w-11 shrink-0 justify-start rounded-full border border-border bg-muted p-0.5 transition-colors data-[state=on]:justify-end data-[state=on]:border-primary/40 data-[state=on]:bg-primary/20",
                  "after:block after:size-4 after:rounded-full after:bg-muted-foreground after:transition-colors data-[state=on]:after:bg-primary",
                )}
                onPressedChange={(pressed) => setDraft((current) => ({ ...current, singleTurnEnabled: pressed }))}
              />
            </div>
            <label className="grid gap-2 text-sm font-medium">
              <span>Agent name</span>
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
