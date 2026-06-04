import { useCallback, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  CaretLeftIcon,
  CaretRightIcon,
  ChartLineUp,
  CheckCircle,
  Gear,
  Info,
  Plus,
  SlidersHorizontal,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { ArchiveSettingsSection } from "@/pages/archive";
import { ResourcesSettingsSection } from "@/pages/resources";
import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  type UserPreferences,
  useStatsForNerdsPreference,
  useUserPreferences,
} from "@/hooks/use-user-preferences";
import {
  DEFAULT_AUTHENTICATED_PATH,
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTION_IDS,
  type SettingsSectionId,
  isProtectedReturnTo,
  settingsPath,
} from "@/route-paths";

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

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: "account", label: "Account" },
  { id: "customization", label: "Customization" },
  { id: "history", label: "History" },
  { id: "resources", label: "Resources" },
  { id: "models", label: "Models" },
  { id: "api-keys", label: "API Keys" },
  { id: "attachments", label: "Attachments" },
  { id: "shortcuts", label: "Shortcuts" },
];

export function SettingsPage() {
  const [preferences, setPreferences] = useUserPreferences();
  const params = useParams<{ section?: string }>();
  const [searchParams] = useSearchParams();
  const from = getSafeFrom(searchParams.get("from"));
  const activeSection = parseSettingsSection(params.section);

  if (!params.section) {
    return <Navigate to={settingsPath(DEFAULT_SETTINGS_SECTION, from)} replace />;
  }

  if (!activeSection) {
    return <Navigate to={settingsPath(DEFAULT_SETTINGS_SECTION, from)} replace />;
  }

  return (
    <div className="flex h-dvh w-full flex-1 flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link
            to={DEFAULT_AUTHENTICATED_PATH}
            className="group flex min-w-0 shrink-0 items-center gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Systify · back to chat"
            title="Back to chat"
          >
            <Logo size={26} />
            <span className="truncate font-mono text-[15px] font-semibold tracking-tight text-foreground transition-colors group-hover:text-muted-foreground">
              Systify
            </span>
          </Link>
          <CaretRightIcon size={12} weight="bold" aria-hidden="true" className="shrink-0 text-muted-foreground/60" />
          <h1 className="flex min-w-0 items-center gap-2">
            <Gear size={14} weight="bold" className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">Settings</span>
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 pb-10 pt-5 sm:px-6 sm:pb-12 sm:pt-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground hover:text-foreground">
            <Link to={from ?? DEFAULT_AUTHENTICATED_PATH}>
              <CaretLeftIcon weight="bold" />
              Back
            </Link>
          </Button>

          <SettingsSectionNav activeSection={activeSection} from={from} />

          {activeSection === "account" ? <AccountSettingsSection /> : null}
          {activeSection === "customization" ? (
            <CustomizationSettingsSection preferences={preferences} setPreferences={setPreferences} />
          ) : null}
          {activeSection === "history" ? <HistorySettingsSection /> : null}
          {activeSection === "resources" ? <ResourcesSection /> : null}
          {activeSection === "models" ? <PlaceholderSettingsSection title="Models" /> : null}
          {activeSection === "api-keys" ? <PlaceholderSettingsSection title="API Keys" /> : null}
          {activeSection === "attachments" ? <PlaceholderSettingsSection title="Attachments" /> : null}
          {activeSection === "shortcuts" ? <PlaceholderSettingsSection title="Shortcuts" /> : null}
        </div>
      </main>
    </div>
  );
}

function SettingsSectionNav({ activeSection, from }: { activeSection: SettingsSectionId; from: string | null }) {
  return (
    <nav className="flex w-full gap-1 overflow-x-auto border border-border bg-card p-1" aria-label="Settings sections">
      {SETTINGS_SECTIONS.map((section) => {
        const isActive = section.id === activeSection;
        return (
          <Link
            key={section.id}
            to={settingsPath(section.id, from)}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "whitespace-nowrap bg-background px-3 py-2 text-sm font-semibold text-foreground"
                : "whitespace-nowrap px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            }
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

function AccountSettingsSection() {
  return (
    <Card className="flex min-h-44 flex-col justify-between p-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ChartLineUp weight="bold" />
          Usage
        </div>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">
          Usage details will live here once backend accounting is wired into the user settings surface.
        </p>
      </div>
      <div className="mt-5 grid gap-2 sm:grid-cols-3">
        <UsageMetric label="Tokens" value="Pending" />
        <UsageMetric label="Requests" value="Pending" />
        <UsageMetric label="Cost" value="Pending" />
      </div>
    </Card>
  );
}

function CustomizationSettingsSection({
  preferences,
  setPreferences,
}: {
  preferences: UserPreferences;
  setPreferences: SetUserPreferences;
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-5">
        <StatsForNerdsSection />
        <Separator />
        <TraitsSection preferences={preferences} setPreferences={setPreferences} />
        <Separator />
        <CustomInstructionsSection preferences={preferences} setPreferences={setPreferences} />
      </div>
    </Card>
  );
}

function HistorySettingsSection() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">History</h2>
      </div>
      <ArchiveSettingsSection />
    </section>
  );
}

function ResourcesSection() {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold">Resources</h2>
      <ResourcesSettingsSection />
    </section>
  );
}

function PlaceholderSettingsSection({ title }: { title: string }) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
        This section is ready for future settings and account controls.
      </p>
    </Card>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function parseSettingsSection(section: string | undefined): SettingsSectionId | null {
  if (!section) return null;
  return SETTINGS_SECTION_IDS.includes(section as SettingsSectionId) ? (section as SettingsSectionId) : null;
}

function getSafeFrom(rawFrom: string | null): string | null {
  if (!rawFrom) {
    return null;
  }
  try {
    const url = new URL(rawFrom, window.location.origin);
    if (url.origin !== window.location.origin) {
      return null;
    }
    if (!isProtectedReturnTo(url.pathname)) {
      return null;
    }
    if (url.pathname.startsWith("/settings")) {
      return null;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function StatsForNerdsSection() {
  const [statsForNerds, setStatsForNerds] = useStatsForNerdsPreference();
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal weight="bold" />
            Stats for Nerds
          </h2>
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
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkle weight="bold" />
          What traits should Systify have?
        </h2>
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
        <h2 className="text-sm font-semibold">Anything else Systify should know about you?</h2>
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
        className="min-h-48 resize-y"
        placeholder="Tell Systify about your preferences, project context, or response style."
        aria-describedby="custom-instructions-count"
      />
      <p id="custom-instructions-count" className="text-right text-xs text-muted-foreground tabular-nums">
        {remaining} characters remaining
      </p>
    </section>
  );
}
