import { useEffect, useState, type FormEvent } from "react";
import { ChatCircleIcon, RepeatIcon, RepeatOnceIcon, RobotIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
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
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { getRepolessChatTypeTooltip, getRepolessSingleTurnTooltip } from "@/components/repoless-agent-profile-copy";
import { Toggle } from "@/components/ui/toggle";
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
const COMPOSER_CONTROL_ICON_CLASS = "size-3.5";

export function RepolessChatTypeToggle({
  value,
  disabled,
  className,
  onSave,
}: {
  value: RepolessAgentProfileValue;
  disabled?: boolean;
  className?: string;
  onSave: (next: RepolessAgentProfileValue) => void | Promise<void>;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState(value);
  const isAgent = value.agentEnabled;
  const isDisabled = disabled || isSaving;
  const ModeIcon = isAgent ? RobotIcon : ChatCircleIcon;
  const label = isAgent ? "Agent" : "Conversation";
  const ariaLabel = isAgent ? "Switch to Conversation" : "Switch to Agent";
  const tooltip = getRepolessChatTypeTooltip({ isAgent });
  const hasProfile = value.agentRole.trim().length > 0 || value.agentInstructions.trim().length > 0;
  const profileLabel = hasProfile ? "Edit Agent settings" : "Set up Agent";

  useEffect(() => {
    if (!profileOpen) {
      setProfileDraft(value);
    }
  }, [profileOpen, value]);

  async function handleToggle() {
    if (isDisabled) return;
    setIsSaving(true);
    try {
      await onSave({ ...value, agentEnabled: !isAgent });
    } catch {
      // The shell owns user-visible error copy.
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave({ ...profileDraft, agentEnabled: true });
      setProfileOpen(false);
    } catch {
      // The shell owns user-visible error copy.
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      className={cn(
        "inline-flex h-8 min-w-0 shrink-0 items-center overflow-hidden rounded-none text-muted-foreground",
        "[&_svg]:shrink-0",
        className,
      )}
    >
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex min-w-0 shrink-0">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isDisabled}
                aria-label={ariaLabel}
                data-testid="repoless-chat-type-toggle"
                className={cn(
                  "h-8 w-auto min-w-0 max-w-32 justify-start gap-1.5 rounded-none border-none bg-transparent px-2 text-xs font-medium shadow-none",
                  "hover:bg-accent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground",
                  "[&_svg]:size-3.5",
                )}
                onClick={() => void handleToggle()}
              >
                <ModeIcon className={COMPOSER_CONTROL_ICON_CLASS} weight={isAgent ? "fill" : "regular"} />
                <span className="composer-repoless-control-label">{label}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-72">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {isAgent ? (
        <TooltipIconButton
          label={profileLabel}
          disabled={isDisabled}
          onClick={() => setProfileOpen(true)}
          aria-invalid={!hasProfile}
          data-testid="repoless-agent-profile-button"
          className={cn(
            "relative h-8 w-8 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none",
            "before:absolute before:left-0 before:top-1/2 before:h-3 before:w-px before:-translate-y-1/2 before:bg-border/55",
            "hover:bg-accent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground",
            !hasProfile && "text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300",
            "[&_svg]:size-3.5",
          )}
        >
          <SlidersHorizontalIcon className={COMPOSER_CONTROL_ICON_CLASS} weight={hasProfile ? "bold" : "regular"} />
        </TooltipIconButton>
      ) : null}

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Agent Profile</DialogTitle>
            <DialogDescription>Set how this assistant behaves for the current repoless chat.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-5" onSubmit={(event) => void handleSaveProfile(event)}>
            <label className="grid gap-2 text-sm font-medium">
              <span>Agent name</span>
              <Input
                value={profileDraft.agentRole}
                maxLength={AGENT_ROLE_MAX_LENGTH}
                disabled={isSaving}
                onChange={(event) => setProfileDraft((current) => ({ ...current, agentRole: event.target.value }))}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              <span>Instructions</span>
              <Textarea
                value={profileDraft.agentInstructions}
                maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
                disabled={isSaving}
                className="min-h-36"
                onChange={(event) =>
                  setProfileDraft((current) => ({ ...current, agentInstructions: event.target.value }))
                }
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
  className,
  onSave,
}: {
  value: RepolessAgentProfileValue;
  resetPending: boolean;
  disabled?: boolean;
  className?: string;
  onSave: (next: RepolessAgentProfileValue) => void | Promise<void>;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const isOn = value.singleTurnEnabled;
  const isDisabled = disabled || resetPending || isSaving;
  const label = resetPending ? "Clearing" : isOn ? "Single reply" : "Threaded";
  const ModeIcon = isOn || resetPending ? RepeatOnceIcon : RepeatIcon;
  const ariaLabel = resetPending
    ? "Single reply is clearing previous messages"
    : isOn
      ? "Switch to Threaded replies"
      : "Switch to Single reply mode";
  const tooltip = getRepolessSingleTurnTooltip({ isOn, resetPending });

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
          <span className={cn("inline-flex shrink-0", className)}>
            <Toggle
              type="button"
              pressed={isOn}
              disabled={isDisabled}
              aria-label={ariaLabel}
              data-testid="repoless-single-turn-toggle"
              className={cn(
                "h-8 w-auto min-w-0 max-w-32 shrink-0 justify-start gap-1.5 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none",
                "hover:bg-accent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground",
                "data-[state=on]:bg-transparent data-[state=on]:text-muted-foreground data-[state=on]:hover:bg-accent data-[state=on]:hover:text-foreground",
                resetPending && "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400",
                "[&_svg]:size-3.5",
              )}
              onPressedChange={() => void handleToggle()}
            >
              <ModeIcon className={COMPOSER_CONTROL_ICON_CLASS} weight={isOn ? "bold" : "regular"} />
              <span className="composer-repoless-control-label">{label}</span>
            </Toggle>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
