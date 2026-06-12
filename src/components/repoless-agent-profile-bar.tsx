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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type RepolessAgentProfileValue = {
  agentEnabled: boolean;
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

  const statusText = value.agentEnabled ? "Agent" : "Chat";

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
        variant="ghost"
        size="xs"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid="repoless-agent-profile-button"
        className={cn(
          "h-8 w-auto min-w-0 max-w-32 justify-start gap-1.5 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none",
          "hover:bg-accent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground",
        )}
        title={statusText}
      >
        <RobotIcon weight={value.agentEnabled ? "fill" : "regular"} />
        <span className="hidden min-w-0 truncate sm:inline">{statusText}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Agent Profile</DialogTitle>
            <DialogDescription>Set how this assistant behaves for the current repoless chat.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-5" onSubmit={(event) => void handleSave(event)}>
            <div className="grid gap-2">
              <div className="text-sm font-medium">Chat type</div>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={draft.agentEnabled ? "agent" : "regular"}
                disabled={isSaving}
                className="w-full"
                onValueChange={(next) => {
                  if (next === "agent" || next === "regular") {
                    setDraft((current) => ({ ...current, agentEnabled: next === "agent" }));
                  }
                }}
              >
                <ToggleGroupItem value="agent" className="h-8 flex-1 text-xs">
                  Agent
                </ToggleGroupItem>
                <ToggleGroupItem value="regular" className="h-8 flex-1 text-xs">
                  Regular chat
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <label className="grid gap-2 text-sm font-medium">
              <span>Agent name</span>
              <Input
                value={draft.agentRole}
                maxLength={AGENT_ROLE_MAX_LENGTH}
                disabled={isSaving || !draft.agentEnabled}
                onChange={(event) => setDraft((current) => ({ ...current, agentRole: event.target.value }))}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              <span>Instructions</span>
              <Textarea
                value={draft.agentInstructions}
                maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
                disabled={isSaving || !draft.agentEnabled}
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
                "h-8 w-8 shrink-0 border-none bg-transparent text-muted-foreground shadow-none hover:bg-accent hover:text-foreground",
                isOn && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                resetPending && "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400",
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
