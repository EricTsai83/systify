import { useEffect, useState, type FormEvent } from "react";
import { RepeatOnceIcon, RobotIcon } from "@phosphor-icons/react";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { REPOLESS_SINGLE_TURN_TOOLTIP } from "@/components/repoless-single-turn-copy";
import { cn } from "@/lib/utils";

export type RepolessAgentProfileValue = {
  singleTurnEnabled: boolean;
  agentRole: string;
  agentInstructions: string;
};

const AGENT_ROLE_MAX_LENGTH = 120;
const AGENT_INSTRUCTIONS_MAX_LENGTH = 3000;
const SINGLE_TURN_TOOLTIP_DELAY_MS = 700;

export function RepolessAgentProfileBar({
  value,
  disabled,
  onSave,
}: {
  value: RepolessAgentProfileValue;
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
  const statusText = hasProfile ? "Configured" : "Default behavior";

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
    <div className="flex min-w-0 items-center">
      <Button
        type="button"
        variant={hasProfile ? "secondary" : "outline"}
        size="xs"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid="repoless-agent-profile-button"
        className="min-w-0 justify-start gap-2 px-2"
        title={statusText}
      >
        <RobotIcon weight={hasProfile ? "fill" : "regular"} />
        <span className="hidden min-w-0 truncate sm:inline">
          <span className="text-foreground">Agent Profile</span>
          {hasProfile && (
            <span className="ml-1.5 text-muted-foreground" aria-hidden="true">
              {statusText}
            </span>
          )}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Agent Profile</DialogTitle>
            <DialogDescription>Set how this assistant behaves for the current repoless chat.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-5" onSubmit={(event) => void handleSave(event)}>
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

export function RepolessSingleTurnToggle({
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
  const [isSaving, setIsSaving] = useState(false);
  const isOn = value.singleTurnEnabled;
  const isDisabled = disabled || resetPending || isSaving;
  const ariaLabel = resetPending
    ? "Single-turn is clearing previous messages"
    : isOn
      ? "Turn off Single-turn"
      : "Turn on Single-turn";

  async function handleToggle() {
    if (isDisabled) return;
    setIsSaving(true);
    try {
      await onSave({ ...value, singleTurnEnabled: !isOn });
    } catch {
      // The shell owns user-visible error copy.
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <TooltipProvider delayDuration={SINGLE_TURN_TOOLTIP_DELAY_MS} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <Button
              type="button"
              variant={isOn ? "secondary" : "ghost"}
              size="icon-xs"
              disabled={isDisabled}
              aria-label={ariaLabel}
              aria-pressed={isOn}
              data-testid="repoless-single-turn-toggle"
              className={cn(
                "h-7 w-7 shrink-0",
                isOn && "border-primary/35 bg-primary/10 text-primary hover:bg-primary/15",
                resetPending && "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15",
              )}
              onClick={() => void handleToggle()}
            >
              <RepeatOnceIcon size={13} weight={isOn ? "bold" : "regular"} />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          {REPOLESS_SINGLE_TURN_TOOLTIP}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
