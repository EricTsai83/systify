import { useEffect, useState, type FormEvent } from "react";
import { ChatCircleIcon, PencilSimpleIcon, PlusIcon, RepeatOnceIcon, RobotIcon } from "@phosphor-icons/react";
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
  const label = isAgent ? "Agent" : "Chat";
  const ariaLabel = isAgent ? "Switch to regular chat" : "Switch to Agent chat";
  const hasProfile = value.agentRole.trim().length > 0 || value.agentInstructions.trim().length > 0;
  const profileLabel = hasProfile ? "Edit profile" : "Create profile";
  const ProfileIcon = hasProfile ? PencilSimpleIcon : PlusIcon;

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
    <div className={cn("inline-flex min-w-0 shrink-0 items-center", className)}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={isDisabled}
        aria-label={ariaLabel}
        data-testid="repoless-chat-type-toggle"
        className={cn(
          "h-8 w-auto min-w-0 max-w-32 justify-start gap-1.5 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none",
          "hover:bg-accent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground",
          isAgent && "rounded-r-none pr-2",
        )}
        onClick={() => void handleToggle()}
      >
        <ModeIcon size={13} weight={isAgent ? "fill" : "regular"} />
        <span className="hidden min-w-0 truncate sm:inline">{label}</span>
      </Button>

      {isAgent ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isDisabled}
          onClick={() => setProfileOpen(true)}
          data-testid="repoless-agent-profile-button"
          className={cn(
            "h-8 w-auto min-w-0 max-w-40 justify-start gap-1.5 rounded-l-none border-0 border-l border-border/70 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none",
            "hover:bg-accent hover:text-foreground focus-visible:bg-transparent focus-visible:text-foreground",
          )}
          title={profileLabel}
        >
          <ProfileIcon size={13} weight="bold" />
          <span className="hidden min-w-0 truncate sm:inline">{profileLabel}</span>
        </Button>
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
  const label = resetPending ? "Clearing" : isOn ? "Single reply" : "Conversation";
  const ModeIcon = isOn || resetPending ? RepeatOnceIcon : ChatCircleIcon;
  const ariaLabel = resetPending
    ? "Single reply is clearing previous messages"
    : isOn
      ? "Switch to Conversation mode"
      : "Switch to Single reply mode";

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
              )}
              onPressedChange={() => void handleToggle()}
            >
              <ModeIcon size={13} weight={isOn ? "bold" : "regular"} />
              <span className="min-w-0 truncate">{label}</span>
            </Toggle>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          {REPOLESS_SINGLE_TURN_TOOLTIP}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
