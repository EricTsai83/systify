import { useCallback, useState, type ReactNode } from "react";
import { CheckCircle, Gear, Info, Plus, SlidersHorizontal, Sparkle, X } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  type UserPreferences,
  useStatsForNerdsPreference,
  useUserPreferences,
} from "@/hooks/use-user-preferences";

type SetUserPreferences = (next: UserPreferences | ((prev: UserPreferences) => UserPreferences)) => void;

const DEFAULT_TRAITS = [
  "Direct",
  "Pragmatic",
  "Curious",
  "Concise",
  "Detail-oriented",
  "Skeptical",
  "Supportive",
  "Technical",
];

export function SettingsDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [preferences, setPreferences] = useUserPreferences();
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gear weight="bold" />
            Settings
          </DialogTitle>
          <DialogDescription>Control how Systify responds and what metadata appears under replies.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <StatsForNerdsSection />
          <Separator />
          <TraitsSection preferences={preferences} setPreferences={setPreferences} />
          <Separator />
          <CustomInstructionsSection preferences={preferences} setPreferences={setPreferences} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StatsForNerdsSection() {
  const [statsForNerds, setStatsForNerds] = useStatsForNerdsPreference();
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal weight="bold" />
            Stats for Nerds
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            Enables more insights into message stats including tokens per second, time to first token, and estimated
            tokens in the message.
          </p>
        </div>
        <Button
          type="button"
          variant={statsForNerds ? "default" : "outline"}
          size="sm"
          className="min-w-24 shrink-0"
          aria-pressed={statsForNerds}
          onClick={() => setStatsForNerds(!statsForNerds)}
        >
          {statsForNerds ? <CheckCircle weight="fill" /> : <Info weight="bold" />}
          {statsForNerds ? "On" : "Off"}
        </Button>
      </div>
    </section>
  );
}

function TraitsSection({
  preferences,
  setPreferences,
}: {
  preferences: UserPreferences;
  setPreferences: SetUserPreferences;
}) {
  const [traitInput, setTraitInput] = useState("");

  const addTrait = useCallback(
    (value: string) => {
      const trait = value.trim();
      if (!trait) return;
      setPreferences((prev) => ({ ...prev, traits: [...prev.traits, trait] }));
      setTraitInput("");
    },
    [setPreferences],
  );

  const removeTrait = useCallback(
    (value: string) => {
      setPreferences((prev) => ({ ...prev, traits: prev.traits.filter((trait) => trait !== value) }));
    },
    [setPreferences],
  );

  const selectedTraits = new Set(preferences.traits.map((trait) => trait.toLocaleLowerCase()));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkle weight="bold" />
          What traits should Systify have?
        </h3>
        <p className="text-sm leading-6 text-muted-foreground">Add custom traits or choose from the defaults.</p>
      </div>

      {preferences.traits.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {preferences.traits.map((trait) => (
            <Badge key={trait} variant="default" className="gap-1 pr-1">
              {trait}
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => removeTrait(trait)}
                aria-label={`Remove ${trait}`}
              >
                <X weight="bold" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          addTrait(traitInput);
        }}
      >
        <Input
          value={traitInput}
          onChange={(event) => setTraitInput(event.target.value)}
          placeholder="Add a custom trait"
          aria-label="Add a custom trait"
        />
        <Button type="submit" variant="secondary" size="default" disabled={!traitInput.trim()}>
          <Plus weight="bold" />
          Add
        </Button>
      </form>

      <div className="flex flex-wrap gap-2">
        {DEFAULT_TRAITS.map((trait) => {
          const selected = selectedTraits.has(trait.toLocaleLowerCase());
          return (
            <Button
              key={trait}
              type="button"
              variant={selected ? "default" : "outline"}
              size="xs"
              disabled={selected}
              onClick={() => addTrait(trait)}
            >
              {selected ? <CheckCircle weight="fill" /> : <Plus weight="bold" />}
              {trait}
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function CustomInstructionsSection({
  preferences,
  setPreferences,
}: {
  preferences: UserPreferences;
  setPreferences: SetUserPreferences;
}) {
  const remaining = CUSTOM_INSTRUCTIONS_MAX_LENGTH - preferences.customInstructions.length;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Anything else Systify should know about you?</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Share stable context or preferences in 3000 characters.
        </p>
      </div>
      <Textarea
        value={preferences.customInstructions}
        onChange={(event) => {
          const value = event.target.value.slice(0, CUSTOM_INSTRUCTIONS_MAX_LENGTH);
          setPreferences((prev) => ({ ...prev, customInstructions: value }));
        }}
        maxLength={CUSTOM_INSTRUCTIONS_MAX_LENGTH}
        className="min-h-36 resize-y"
        placeholder="Tell Systify about your preferences, project context, or response style."
        aria-describedby="custom-instructions-count"
      />
      <p id="custom-instructions-count" className="text-right text-xs text-muted-foreground tabular-nums">
        {remaining} characters remaining
      </p>
    </section>
  );
}
