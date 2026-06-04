import { useCallback, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useMutation, useQuery } from "convex/react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleText,
  ChartLineUp,
  CheckCircle,
  Gear,
  GithubLogo,
  Info,
  Plus,
  SlidersHorizontal,
  Sparkle,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ArchiveSettingsSection } from "@/pages/archive";
import { ResourcesSettingsSection } from "@/pages/resources";
import { useGitHubConnection } from "@/hooks/use-github-connection";
import { Logo } from "@/components/logo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  type UserPreferences,
  useStatsForNerdsPreference,
  useUserPreferences,
} from "@/hooks/use-user-preferences";
import { useAsyncCallback } from "@/hooks/use-async-callback";
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

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const INTEGER_FORMATTER = new Intl.NumberFormat("en-US");

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const USAGE_DESCRIPTIONS = {
  tokens:
    "Total LLM tokens recorded in the last 30 days, including input, output, cached input, cache writes, and reasoning tokens.",
  events:
    "Metered LLM usage records in the last 30 days. A chat reply or a System Design generation can add one record when usage or cost is recorded.",
  cost: "Estimated LLM provider spend for your usage in the last 30 days. This is cost telemetry, not an invoice.",
  chat: "LLM usage from chat replies in Discuss or Library Ask during the last 30 days.",
  systemDesign:
    "LLM usage from Generate System Design jobs. Each artifact kind run can add a metered record while creating or refreshing Library artifacts.",
  sandboxBudget:
    "Daily spend cap for sandbox-grounded work. It resets at midnight UTC and is separate from regular LLM usage totals.",
} as const;

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
  const { user } = useAuth();
  const githubConnection = useGitHubConnection();
  const usageSummary = useQuery(api.lib.userCost.getViewerUsageSummary);
  const disconnectGitHub = useMutation(api.github.disconnectGitHub);
  const [isDisconnectDialogOpen, setIsDisconnectDialogOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const displayName = user?.firstName
    ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ""}`
    : (user?.email ?? "Signed-in user");
  const fallbackInitial = displayName.trim().charAt(0).toLocaleUpperCase() || "U";
  const usageWindowLabel = usageSummary ? `Last ${usageSummary.window.days} days` : "Last 30 days";
  const sandboxBudgetPercent =
    usageSummary && usageSummary.sandboxDailyBudget.capacityUsd > 0
      ? Math.min(
          100,
          Math.max(0, (usageSummary.sandboxDailyBudget.usedUsd / usageSummary.sandboxDailyBudget.capacityUsd) * 100),
        )
      : 0;

  const manageGitHubUrl = githubConnection.installationId
    ? `https://github.com/settings/installations/${githubConnection.installationId}`
    : null;

  const handleManageGitHub = useCallback(() => {
    if (!manageGitHubUrl) return;
    window.open(manageGitHubUrl, "systify-github-permissions", "width=1020,height=720,popup=yes");
  }, [manageGitHubUrl]);

  const [isDisconnectingGitHub, handleDisconnectGitHub] = useAsyncCallback(async () => {
    setDisconnectError(null);
    try {
      await disconnectGitHub({});
      setIsDisconnectDialogOpen(false);
    } catch (error) {
      setDisconnectError(error instanceof Error ? error.message : "Failed to disconnect GitHub.");
    }
  });

  return (
    <TooltipProvider delayDuration={150}>
      <section className="flex flex-col gap-4">
        <Card className="overflow-hidden p-0">
          <div className="flex flex-col gap-4 border-b border-border bg-muted/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar size="lg" className="rounded-md">
                <AvatarImage src={user?.profilePictureUrl ?? undefined} alt={displayName} className="rounded-md" />
                <AvatarFallback className="rounded-md text-sm font-semibold uppercase">
                  {fallbackInitial}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold tracking-tight">{displayName}</h2>
                  <Badge variant="muted">WorkOS</Badge>
                </div>
                <p className="mt-1 min-h-5 truncate text-sm text-muted-foreground">{user?.email ?? null}</p>
              </div>
            </div>
            <Badge variant={githubConnection.isConnected ? "outline" : "muted"} className="w-fit whitespace-nowrap">
              <GithubLogo weight="bold" />
              {formatGitHubConnection(githubConnection)}
            </Badge>
          </div>

          <div className="flex flex-col gap-3 border-t border-border px-5 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0">
              GitHub repository access comes from the connected GitHub App installation. To switch GitHub accounts,
              disconnect this installation and connect again.
            </p>
            {githubConnection.isConnected ? (
              <div className="flex shrink-0 flex-wrap gap-2">
                {manageGitHubUrl ? (
                  <Button type="button" variant="outline" size="sm" onClick={handleManageGitHub}>
                    <GithubLogo weight="bold" />
                    Manage on GitHub
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    setDisconnectError(null);
                    setIsDisconnectDialogOpen(true);
                  }}
                >
                  Disconnect
                </Button>
              </div>
            ) : null}
            {disconnectError ? <p className="text-sm text-destructive sm:basis-full">{disconnectError}</p> : null}
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <ChartLineUp weight="bold" />
              Usage
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{usageWindowLabel}</span>
              <Badge variant={usageSummary ? "outline" : "muted"}>{usageSummary ? "Live" : "Loading"}</Badge>
            </div>
          </div>

          <div className="p-5">
            <div className="grid overflow-hidden border border-border bg-background sm:grid-cols-3">
              <UsageMetric
                label="Tokens"
                description={USAGE_DESCRIPTIONS.tokens}
                value={usageSummary ? COMPACT_NUMBER_FORMATTER.format(usageSummary.totals.totalTokens) : "Loading"}
                detail={usageSummary ? `${INTEGER_FORMATTER.format(usageSummary.totals.totalTokens)} total` : undefined}
                isLoading={!usageSummary}
              />
              <UsageMetric
                label="Events"
                description={USAGE_DESCRIPTIONS.events}
                value={usageSummary ? INTEGER_FORMATTER.format(usageSummary.totals.events) : "Loading"}
                detail="Metered LLM usage records"
                isLoading={!usageSummary}
              />
              <UsageMetric
                label="Cost"
                description={USAGE_DESCRIPTIONS.cost}
                value={usageSummary ? USD_FORMATTER.format(usageSummary.totals.costUsd) : "Loading"}
                detail="Estimated provider spend"
                isLoading={!usageSummary}
              />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <FeatureUsageLine
                icon={<ChatCircleText weight="bold" />}
                label="Chat"
                description={USAGE_DESCRIPTIONS.chat}
                value={usageSummary ? USD_FORMATTER.format(usageSummary.byFeature.chat.costUsd) : "Loading"}
                detail={
                  usageSummary
                    ? formatCountLabel(usageSummary.byFeature.chat.events, "metered reply", "metered replies")
                    : undefined
                }
                isLoading={!usageSummary}
              />
              <FeatureUsageLine
                icon={<Sparkle weight="bold" />}
                label="System Design"
                description={USAGE_DESCRIPTIONS.systemDesign}
                value={usageSummary ? USD_FORMATTER.format(usageSummary.byFeature.systemDesign.costUsd) : "Loading"}
                detail={
                  usageSummary
                    ? formatCountLabel(usageSummary.byFeature.systemDesign.events, "artifact run", "artifact runs")
                    : undefined
                }
                isLoading={!usageSummary}
              />
            </div>

            <div className="mt-4 border border-border bg-background p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Wallet weight="bold" />
                    Daily sandbox budget
                    <MetricInfoTooltip label="Daily sandbox budget" description={USAGE_DESCRIPTIONS.sandboxBudget} />
                  </p>
                  <div className="mt-1 min-h-10 text-sm leading-5 text-muted-foreground">
                    {usageSummary ? (
                      <p>
                        {USD_FORMATTER.format(usageSummary.sandboxDailyBudget.remainingUsd)} remaining for
                        sandbox-grounded work. Resets at midnight UTC.
                      </p>
                    ) : (
                      <div className="space-y-1.5 py-0.5" aria-hidden="true">
                        <Skeleton className="h-3 w-full max-w-[32rem]" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                    )}
                  </div>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums">
                  {usageSummary
                    ? `${USD_FORMATTER.format(usageSummary.sandboxDailyBudget.usedUsd)} / ${USD_FORMATTER.format(
                        usageSummary.sandboxDailyBudget.capacityUsd,
                      )}`
                    : "Loading"}
                </p>
              </div>
              <div className="mt-4 h-2 overflow-hidden bg-muted" aria-hidden="true">
                <div className="h-full bg-primary" style={{ width: `${sandboxBudgetPercent}%` }} />
              </div>
            </div>
          </div>
        </Card>
        <ConfirmDialog
          open={isDisconnectDialogOpen}
          onOpenChange={setIsDisconnectDialogOpen}
          title="Disconnect GitHub?"
          description="Systify will stop using this GitHub App installation for repository access. Imported repository data stays in Systify, but new imports and permission updates require connecting GitHub again."
          actionLabel="Disconnect"
          loadingLabel="Disconnecting"
          isPending={isDisconnectingGitHub}
          onConfirm={() => {
            void handleDisconnectGitHub();
          }}
        />
      </section>
    </TooltipProvider>
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

function UsageMetric({
  label,
  description,
  value,
  detail,
  isLoading = false,
}: {
  label: string;
  description: string;
  value: string;
  detail?: string;
  isLoading?: boolean;
}) {
  return (
    <div className="min-w-0 border-b border-border p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        <MetricInfoTooltip label={label} description={description} />
      </p>
      {isLoading ? (
        <Skeleton className="mt-2 h-8 w-24" aria-label={`Loading ${label.toLowerCase()}`} />
      ) : (
        <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      )}
      {isLoading ? (
        <Skeleton className="mt-1 h-3 w-32" aria-hidden="true" />
      ) : (
        <p className="mt-1 min-h-4 truncate text-xs text-muted-foreground">{detail ?? null}</p>
      )}
    </div>
  );
}

function FeatureUsageLine({
  icon,
  label,
  description,
  value,
  detail,
  isLoading = false,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  value: string;
  detail?: string;
  isLoading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border border-border bg-background p-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center border border-border bg-muted/40 text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
            {label}
            <MetricInfoTooltip label={label} description={description} />
          </p>
          {isLoading ? (
            <Skeleton className="mt-1.5 h-3 w-20" aria-hidden="true" />
          ) : (
            <p className="mt-0.5 min-h-4 truncate text-xs text-muted-foreground">{detail ?? null}</p>
          )}
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-5 w-16 shrink-0" aria-label={`Loading ${label.toLowerCase()} usage`} />
      ) : (
        <p className="shrink-0 text-base font-semibold tabular-nums">{value}</p>
      )}
    </div>
  );
}

function MetricInfoTooltip({ label, description }: { label: string; description: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${label} explanation`}
        >
          <Info size={13} weight="bold" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  if (count === 0) {
    return `No ${plural}`;
  }
  return `${INTEGER_FORMATTER.format(count)} ${count === 1 ? singular : plural}`;
}

function formatGitHubConnection(connection: ReturnType<typeof useGitHubConnection>): string {
  if (connection.isLoading) {
    return "Loading";
  }
  if (connection.isSuspended && connection.accountLogin) {
    return `${connection.accountLogin} suspended`;
  }
  if (connection.isConnected && connection.accountLogin) {
    return `${connection.accountLogin} connected`;
  }
  return "Not connected";
}

function parseSettingsSection(section: string | undefined): SettingsSectionId | null {
  if (!section) return null;
  return SETTINGS_SECTION_IDS.includes(section as SettingsSectionId) ? (section as SettingsSectionId) : null;
}

function getSafeFrom(rawFrom: string | null): string | null {
  if (!rawFrom) {
    return null;
  }
  if (rawFrom.startsWith("//")) {
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
            Enables more insights into message stats including tokens per second, generation time, and estimated tokens
            in the message.
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
