import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useMutation, useQuery } from "convex/react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpDownIcon,
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
import { HistoryPage } from "@/pages/history";
import { ResourcesSettingsSection } from "@/pages/resources";
import { useGitHubConnection } from "@/hooks/use-github-connection";
import { Logo } from "@/components/logo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useComboboxAnchor } from "@/components/ui/use-combobox-anchor";
import {
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  USER_TRAIT_MAX_LENGTH,
  USER_TRAITS_MAX_COUNT,
  areUserPreferencesEqual,
  normalizeUserPreferences,
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
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { toUserErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

type SetUserPreferences = (next: UserPreferences | ((prev: UserPreferences) => UserPreferences)) => void;

const DEFAULT_TRAITS = ["concise", "empathetic", "curious", "creative", "friendly", "witty", "patient"];

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: "account", label: "Account" },
  { id: "usage", label: "Usage" },
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

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const BROWSER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const USAGE_HISTORY_PERIOD_COUNT = 12;
const MAX_VIEWER_USAGE_DASHBOARD_CACHE_ENTRIES = 4;
const BUDGET_PRESETS_USD = [5, 10, 25, 50] as const;
const COMMON_TIME_ZONES = [
  "UTC",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Bangkok",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Rome",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
] as const;
const TIME_ZONE_SEARCH_ALIASES: Record<string, string> = {
  "Asia/Taipei": "Taipei Taiwan 台北",
  "Asia/Tokyo": "Tokyo Japan",
  "Asia/Seoul": "Seoul Korea",
  "Asia/Singapore": "Singapore SG",
  "Asia/Hong_Kong": "Hong Kong HK",
  "Asia/Shanghai": "Shanghai Beijing China",
  "Asia/Bangkok": "Bangkok Thailand",
  "Asia/Kolkata": "India Delhi Mumbai",
  "Europe/London": "London UK England",
  "Europe/Berlin": "Berlin Germany",
  "Europe/Paris": "Paris France",
  "America/New_York": "New York Eastern ET EST EDT",
  "America/Chicago": "Chicago Central CT CST CDT",
  "America/Denver": "Denver Mountain MT MST MDT",
  "America/Los_Angeles": "Los Angeles Pacific PT PST PDT California",
  "UTC": "Coordinated Universal Time GMT Zulu",
};

type ViewerUsageDashboard = NonNullable<ReturnType<typeof useQuery<typeof api.lib.userCost.getViewerUsageDashboard>>>;

type TimeZoneOption = {
  value: string;
  label: string;
  detail: string;
  searchText: string;
};

const viewerUsageDashboardCache = new Map<string, ViewerUsageDashboard>();

/**
 * Presenter boundary for `getViewerUsageDashboard`.
 *
 * The Convex query intentionally returns compact rollup names that match
 * the durable usage tables (`events`, `costUsd`, feature literals). This
 * copy map keeps those DB-facing names stable while giving users
 * product-language labels.
 */
const USAGE_COPY = {
  section: {
    title: "Usage",
    readyStatus: "Current",
    loadingStatus: "Loading…",
    refreshingStatus: "Refreshing…",
  },
  metrics: {
    spend: {
      label: "Current Cycle Spend",
      description: "Estimated provider cost recorded in the active billing cycle. This is not an invoice.",
      detail: "provider cost estimate",
    },
    remainingBudget: {
      label: "Remaining Budget",
      description: "Self-managed budget remaining after current spend and in-flight reservations.",
      detail: "self-managed budget",
    },
    llmTokens: {
      label: "Total Tokens",
      description:
        "Total tokens recorded in this cycle, including input, output, cached input, cache writes, and reasoning tokens.",
      detail: "total tokens",
    },
    usageRecords: {
      label: "Metered Events",
      description: "Count of metered usage records in this cycle.",
      detail: "metered records",
    },
  },
  features: {
    chat: {
      label: "Chat Replies",
      description: "LLM usage from replies in Discuss or Library Ask during this cycle.",
      singularRecord: "metered reply",
      pluralRecord: "metered replies",
    },
    systemDesign: {
      label: REPOSITORY_GUIDE_COPY.name,
      description: "LLM usage from generating Repository Guide sections for the Library.",
      singularRecord: REPOSITORY_GUIDE_COPY.sectionName,
      pluralRecord: REPOSITORY_GUIDE_COPY.sectionNamePlural,
    },
    artifactIndexing: {
      label: "Artifact Indexing",
      description: "Embedding usage from indexing Library artifacts for retrieval.",
      singularRecord: "embedding batch",
      pluralRecord: "embedding batches",
    },
    libraryRetrieval: {
      label: "Library Retrieval",
      description: "Semantic query embedding usage from Library retrieval.",
      singularRecord: "retrieval embedding",
      pluralRecord: "retrieval embeddings",
    },
    titleGeneration: {
      label: "Title Generation",
      description: "LLM usage from automatic thread title generation.",
      singularRecord: "generated title",
      pluralRecord: "generated titles",
    },
  },
} as const;

export function SettingsPage() {
  const params = useParams<{ section?: string }>();
  const [searchParams] = useSearchParams();
  const from = getSafeFrom(searchParams.get("from"));
  const activeSection = parseSettingsSection(params.section);
  const [customizationPreferences, setCustomizationPreferences] = useUserPreferences();

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
          {activeSection === "usage" ? <UsageSettingsSection /> : null}
          {activeSection === "customization" ? (
            <CustomizationSettingsSection
              preferences={customizationPreferences}
              setPreferences={setCustomizationPreferences}
            />
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
  const { user, isLoading: isAuthLoading } = useAuth();
  const githubConnection = useGitHubConnection();
  const disconnectGitHub = useMutation(api.github.disconnectGitHub);
  const [isDisconnectDialogOpen, setIsDisconnectDialogOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const isAccountLoading = isAuthLoading || githubConnection.isLoading;

  const displayName = user?.firstName
    ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ""}`
    : (user?.email ?? "Signed-in user");
  const fallbackInitial = displayName.trim().charAt(0).toLocaleUpperCase() || "U";

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
          <div className="flex min-h-[104px] flex-col gap-4 border-b border-border bg-muted/20 px-5 py-4 sm:min-h-[73px] sm:flex-row sm:items-center sm:justify-between">
            {isAccountLoading ? (
              <>
                <div className="flex min-w-0 items-center gap-3">
                  <Skeleton className="size-10 shrink-0 rounded-md" aria-hidden="true" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Skeleton className="h-5 w-36 max-w-full" aria-hidden="true" />
                      <Skeleton className="h-5 w-16" aria-hidden="true" />
                    </div>
                    <Skeleton className="h-5 w-52 max-w-full" aria-hidden="true" />
                  </div>
                </div>
                <Skeleton className="h-6 w-40" aria-hidden="true" />
              </>
            ) : (
              <>
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
              </>
            )}
          </div>

          <div className="flex min-h-[107px] flex-col gap-3 border-t border-border px-5 py-3 text-sm text-muted-foreground sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
            {isAccountLoading ? (
              <>
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-full" aria-hidden="true" />
                  <Skeleton className="h-4 w-4/5 sm:hidden" aria-hidden="true" />
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Skeleton className="h-8 w-36" aria-hidden="true" />
                  <Skeleton className="h-8 w-24" aria-hidden="true" />
                </div>
              </>
            ) : (
              <>
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
              </>
            )}
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

function useCachedViewerUsageDashboard(cacheKey: string | null): {
  dashboard: ViewerUsageDashboard | null;
  isRefreshing: boolean;
} {
  const liveDashboard = useQuery(api.lib.userCost.getViewerUsageDashboard);
  const cachedDashboard = cacheKey ? viewerUsageDashboardCache.get(cacheKey) : undefined;

  useEffect(() => {
    if (!cacheKey || liveDashboard === undefined) {
      return;
    }

    if (
      !viewerUsageDashboardCache.has(cacheKey) &&
      viewerUsageDashboardCache.size >= MAX_VIEWER_USAGE_DASHBOARD_CACHE_ENTRIES
    ) {
      const oldestCacheKey = viewerUsageDashboardCache.keys().next().value;
      if (oldestCacheKey) {
        viewerUsageDashboardCache.delete(oldestCacheKey);
      }
    }

    viewerUsageDashboardCache.set(cacheKey, liveDashboard);
  }, [cacheKey, liveDashboard]);

  return {
    dashboard: liveDashboard ?? cachedDashboard ?? null,
    isRefreshing: liveDashboard === undefined && cachedDashboard !== undefined,
  };
}

function getSupportedTimeZoneValues(): string[] {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const supportedTimeZones =
    typeof intlWithSupportedValues.supportedValuesOf === "function"
      ? intlWithSupportedValues.supportedValuesOf("timeZone")
      : [];

  return dedupeStrings(["UTC", BROWSER_TIME_ZONE, ...COMMON_TIME_ZONES, ...supportedTimeZones]);
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function buildTimeZoneOption(timeZone: string): TimeZoneOption {
  const city = formatTimeZoneCity(timeZone);
  const offset = formatTimeZoneOffset(timeZone);
  const alias = TIME_ZONE_SEARCH_ALIASES[timeZone] ?? "";
  return {
    value: timeZone,
    label: timeZone,
    detail: `${offset} · ${city}`,
    searchText: `${timeZone} ${city} ${offset} ${alias}`,
  };
}

function buildTimeZoneOptions(currentValue: string): TimeZoneOption[] {
  const normalizedCurrent = normalizeTimeZoneInput(currentValue);
  const values = dedupeStrings(
    [
      "UTC",
      BROWSER_TIME_ZONE,
      normalizedCurrent.valid ? normalizedCurrent.value : null,
      ...getSupportedTimeZoneValues(),
    ].filter((value): value is string => value !== null),
  );
  const favorites = new Set(["UTC", BROWSER_TIME_ZONE, normalizedCurrent.valid ? normalizedCurrent.value : ""]);
  const favoriteOptions = values
    .filter((value) => favorites.has(value))
    .map(buildTimeZoneOption)
    .sort((a, b) => {
      if (a.value === BROWSER_TIME_ZONE) return -1;
      if (b.value === BROWSER_TIME_ZONE) return 1;
      if (a.value === "UTC") return -1;
      if (b.value === "UTC") return 1;
      return a.value.localeCompare(b.value);
    });
  const remainingOptions = values
    .filter((value) => !favorites.has(value))
    .map(buildTimeZoneOption)
    .sort((a, b) => a.value.localeCompare(b.value));

  return [...favoriteOptions, ...remainingOptions];
}

function normalizeTimeZoneInput(timeZone: string): { valid: true; value: string } | { valid: false } {
  const trimmed = timeZone.trim();
  if (!trimmed) {
    return { valid: false };
  }
  try {
    const resolvedTimeZone = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    return { valid: true, value: resolvedTimeZone };
  } catch {
    return { valid: false };
  }
}

function formatTimeZoneCity(timeZone: string): string {
  if (timeZone === "UTC") {
    return "Coordinated Universal Time";
  }
  const parts = timeZone.split("/");
  return (parts.at(-1) ?? timeZone).replaceAll("_", " ");
}

function formatTimeZoneOffset(timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "numeric",
    });
    return formatter.formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  } catch {
    return "GMT";
  }
}

function parseBudgetUsdInput(rawBudget: string): { value: number | null; error: string | null } {
  const trimmed = rawBudget.trim();
  if (!trimmed) {
    return { value: null, error: null };
  }

  const normalized = trimmed.replace(/^\$/, "").replaceAll(",", "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { value: null, error: "Enter a valid USD amount, or leave it blank for no budget." };
  }
  if (value < 0.01) {
    return { value, error: "Budget must be at least $0.01." };
  }
  if (value > 10_000) {
    return { value, error: "Budget must be $10,000 or less." };
  }
  return { value, error: null };
}

function UsageSettingsSection() {
  const { user } = useAuth();
  const { dashboard, isRefreshing } = useCachedViewerUsageDashboard(user?.email ?? null);
  const updateUsageProfile = useMutation(api.lib.userCost.updateViewerUsageProfile);
  const [cycleAnchorDayDraft, setCycleAnchorDayDraft] = useState<string | null>(null);
  const [timeZoneDraft, setTimeZoneDraft] = useState<string | null>(null);
  const [budgetInputDraft, setBudgetInputDraft] = useState<string | null>(null);
  const [hardCapEnabledDraft, setHardCapEnabledDraft] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const cycleAnchorDay = cycleAnchorDayDraft ?? String(dashboard?.profile.cycleAnchorDay ?? 1);
  const timeZone = timeZoneDraft ?? dashboard?.profile.timeZone ?? BROWSER_TIME_ZONE;
  const budgetInput =
    budgetInputDraft ??
    (dashboard?.profile.budgetUsd === null || !dashboard ? "" : String(dashboard.profile.budgetUsd));
  const parsedBudget = parseBudgetUsdInput(budgetInput);
  const hasConfiguredBudget = parsedBudget.error === null && parsedBudget.value !== null;
  const hardCapEnabled = hasConfiguredBudget
    ? (hardCapEnabledDraft ?? dashboard?.profile.hardCapEnabled ?? false)
    : false;
  const normalizedTimeZone = normalizeTimeZoneInput(timeZone);
  const timeZoneError = normalizedTimeZone.valid ? null : "Choose a valid IANA timezone.";
  const hasFormErrors = parsedBudget.error !== null || timeZoneError !== null;
  const persistedHardCapEnabled = dashboard
    ? dashboard.profile.budgetUsd === null
      ? false
      : dashboard.profile.hardCapEnabled
    : false;
  const isUsageProfileDirty =
    !!dashboard &&
    (Number(cycleAnchorDay) !== dashboard.profile.cycleAnchorDay ||
      (normalizedTimeZone.valid && normalizedTimeZone.value !== dashboard.profile.timeZone) ||
      parsedBudget.value !== dashboard.profile.budgetUsd ||
      (dashboard.profile.budgetUsd === null && parsedBudget.value === null && budgetInput.trim() !== "") ||
      hardCapEnabled !== persistedHardCapEnabled);
  const usageProfileStatus = !dashboard
    ? USAGE_COPY.section.loadingStatus
    : isUsageProfileDirty
      ? "Unsaved changes"
      : saveStatus || "Saved";
  const timeZoneOptions = useMemo(() => buildTimeZoneOptions(timeZone), [timeZone]);
  const activeTimeZoneOption = normalizedTimeZone.valid
    ? (timeZoneOptions.find((option) => option.value === normalizedTimeZone.value) ?? null)
    : null;

  const budgetProgress = dashboard?.budget.percentUsed === null ? 0 : Math.min(100, dashboard?.budget.percentUsed ?? 0);
  const budgetState = normalizeBudgetState(dashboard?.budget.state);
  const usageStatusLabel = dashboard
    ? isRefreshing
      ? USAGE_COPY.section.refreshingStatus
      : USAGE_COPY.section.readyStatus
    : USAGE_COPY.section.loadingStatus;
  const budgetStateLabel = dashboard ? formatBudgetStateLabel(budgetState) : USAGE_COPY.section.loadingStatus;
  const currentPeriodLabel = dashboard
    ? formatPeriodRange(dashboard.currentPeriod.periodStartMs, dashboard.currentPeriod.periodEndMs)
    : "Current billing cycle";
  const remainingBudgetValue = dashboard
    ? dashboard.budget.remainingUsd === null
      ? "No budget"
      : USD_FORMATTER.format(dashboard.budget.remainingUsd)
    : USAGE_COPY.section.loadingStatus;
  const remainingBudgetDetail = dashboard
    ? dashboard.budget.configured
      ? `${USD_FORMATTER.format(dashboard.budget.reservedUsd)} reserved in flight`
      : "Budget disabled"
    : undefined;

  const clearSaveFeedback = useCallback(() => {
    setSaveStatus(null);
    setSaveError(null);
  }, []);

  const resetUsageProfileDrafts = useCallback(() => {
    setCycleAnchorDayDraft(null);
    setTimeZoneDraft(null);
    setBudgetInputDraft(null);
    setHardCapEnabledDraft(null);
    clearSaveFeedback();
  }, [clearSaveFeedback]);

  const [isSaving, handleSave] = useAsyncCallback(async () => {
    setSaveError(null);
    setSaveStatus(null);
    if (!normalizedTimeZone.valid || parsedBudget.error !== null) {
      setSaveError("Fix the highlighted usage settings before saving.");
      return;
    }
    try {
      await updateUsageProfile({
        cycleAnchorDay: Number(cycleAnchorDay),
        timeZone: normalizedTimeZone.value,
        budgetUsd: parsedBudget.value,
        hardCapEnabled: parsedBudget.value !== null && hardCapEnabled,
      });
      setCycleAnchorDayDraft(null);
      setTimeZoneDraft(null);
      setBudgetInputDraft(null);
      setHardCapEnabledDraft(null);
      setSaveStatus("Saved");
    } catch (error) {
      setSaveError(toUserErrorMessage(error, "Failed to save usage settings."));
    }
  });

  const featureRows = useMemo(
    () => [
      {
        key: "chat" as const,
        icon: <ChatCircleText weight="bold" />,
        copy: USAGE_COPY.features.chat,
      },
      {
        key: "systemDesign" as const,
        icon: <Sparkle weight="bold" />,
        copy: USAGE_COPY.features.systemDesign,
      },
      {
        key: "artifactIndexing" as const,
        icon: <ChartLineUp weight="bold" />,
        copy: USAGE_COPY.features.artifactIndexing,
      },
      {
        key: "libraryRetrieval" as const,
        icon: <Wallet weight="bold" />,
        copy: USAGE_COPY.features.libraryRetrieval,
      },
      {
        key: "titleGeneration" as const,
        icon: <Sparkle weight="bold" />,
        copy: USAGE_COPY.features.titleGeneration,
      },
    ],
    [],
  );

  return (
    <TooltipProvider delayDuration={150}>
      <section className="flex flex-col gap-4">
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <ChartLineUp weight="bold" />
                {USAGE_COPY.section.title}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">Estimated provider cost, not an invoice.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="min-w-36 text-right text-sm text-muted-foreground">{currentPeriodLabel}</span>
              <Badge variant={dashboard && !isRefreshing ? "outline" : "muted"} className="min-w-24 justify-center">
                {usageStatusLabel}
              </Badge>
            </div>
          </div>

          <div className="p-5">
            <div className="grid overflow-hidden border border-border bg-background sm:grid-cols-2 lg:grid-cols-4">
              <UsageMetric
                label={USAGE_COPY.metrics.spend.label}
                description={USAGE_COPY.metrics.spend.description}
                value={
                  dashboard ? USD_FORMATTER.format(dashboard.currentPeriod.costUsd) : USAGE_COPY.section.loadingStatus
                }
                detail={USAGE_COPY.metrics.spend.detail}
                isLoading={!dashboard}
              />
              <UsageMetric
                label={USAGE_COPY.metrics.remainingBudget.label}
                description={USAGE_COPY.metrics.remainingBudget.description}
                value={remainingBudgetValue}
                detail={remainingBudgetDetail}
                isLoading={!dashboard}
              />
              <UsageMetric
                label={USAGE_COPY.metrics.llmTokens.label}
                description={USAGE_COPY.metrics.llmTokens.description}
                value={
                  dashboard
                    ? COMPACT_NUMBER_FORMATTER.format(dashboard.currentPeriod.totalTokens)
                    : USAGE_COPY.section.loadingStatus
                }
                detail={
                  dashboard
                    ? `${INTEGER_FORMATTER.format(dashboard.currentPeriod.totalTokens)} ${USAGE_COPY.metrics.llmTokens.detail}`
                    : undefined
                }
                isLoading={!dashboard}
              />
              <UsageMetric
                label={USAGE_COPY.metrics.usageRecords.label}
                description={USAGE_COPY.metrics.usageRecords.description}
                value={
                  dashboard
                    ? INTEGER_FORMATTER.format(dashboard.currentPeriod.events)
                    : USAGE_COPY.section.loadingStatus
                }
                detail={USAGE_COPY.metrics.usageRecords.detail}
                isLoading={!dashboard}
              />
            </div>

            <div className="mt-4 border border-border bg-background p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Wallet weight="bold" />
                    Budget Progress
                    <MetricInfoTooltip
                      label="Budget Progress"
                      description="Progress includes current-cycle spend and in-flight reserved estimates."
                    />
                  </p>
                  {dashboard ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {dashboard.budget.configured
                        ? `${USD_FORMATTER.format(dashboard.budget.usedUsd)} used${
                            dashboard.budget.reservedUsd > 0
                              ? `, ${USD_FORMATTER.format(dashboard.budget.reservedUsd)} reserved`
                              : ""
                          } of ${USD_FORMATTER.format(dashboard.budget.budgetUsd ?? 0)}`
                        : "Set a self-managed budget to enable progress tracking."}
                    </p>
                  ) : (
                    <Skeleton className="mt-2 h-4 w-full max-w-sm" aria-hidden="true" />
                  )}
                </div>
                <Badge variant={budgetBadgeVariant(budgetState)}>{budgetStateLabel}</Badge>
              </div>
              <Progress className="mt-4 h-2" value={budgetProgress} aria-label="Budget progress" />
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">Feature Breakdown</h2>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {featureRows.map((row) => {
              const bucket = dashboard?.currentPeriod.byFeature[row.key];
              return (
                <FeatureUsageLine
                  key={row.key}
                  icon={row.icon}
                  label={row.copy.label}
                  description={row.copy.description}
                  value={bucket ? USD_FORMATTER.format(bucket.costUsd) : USAGE_COPY.section.loadingStatus}
                  detail={
                    bucket ? formatCountLabel(bucket.events, row.copy.singularRecord, row.copy.pluralRecord) : undefined
                  }
                  isLoading={!dashboard}
                />
              );
            })}
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Cycle History</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-2xl text-left text-sm">
              <thead className="border-b border-border bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-semibold">Period</th>
                  <th className="px-5 py-3 font-semibold">Spend</th>
                  <th className="px-5 py-3 font-semibold">Tokens</th>
                  <th className="px-5 py-3 font-semibold">Events</th>
                  <th className="px-5 py-3 font-semibold">Budget</th>
                </tr>
              </thead>
              <tbody>
                {dashboard ? (
                  dashboard.history.map((period) => {
                    const state = getHistoryBudgetState(period.costUsd, dashboard.profile.budgetUsd);
                    return (
                      <tr key={period.periodKey} className="border-b border-border last:border-b-0">
                        <td className="px-5 py-3 text-foreground">
                          {formatPeriodRange(period.periodStartMs, period.periodEndMs)}
                        </td>
                        <td className="px-5 py-3 tabular-nums">{USD_FORMATTER.format(period.costUsd)}</td>
                        <td className="px-5 py-3 tabular-nums">{INTEGER_FORMATTER.format(period.totalTokens)}</td>
                        <td className="px-5 py-3 tabular-nums">{INTEGER_FORMATTER.format(period.events)}</td>
                        <td className="px-5 py-3">
                          <Badge variant={budgetBadgeVariant(state)}>{formatBudgetStateLabel(state)}</Badge>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <UsageHistorySkeletonRows />
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Monitoring Settings</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Controls how estimated provider cost is grouped and when new LLM work should stop.
              </p>
            </div>
            <Badge variant={isUsageProfileDirty ? "outline" : "muted"} className="w-fit">
              {usageProfileStatus}
            </Badge>
          </div>

          <form
            className="p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <div className="grid gap-5 lg:grid-cols-2">
              <UsageProfileField
                label="Cycle anchor day"
                description="The day each monthly usage cycle starts. Day 31 uses the last valid day in shorter months."
              >
                <Select
                  value={cycleAnchorDay}
                  onValueChange={(value) => {
                    setCycleAnchorDayDraft(value);
                    clearSaveFeedback();
                  }}
                  disabled={!dashboard || isSaving}
                >
                  <SelectTrigger aria-label="Cycle anchor day">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => (
                        <SelectItem key={day} value={day}>
                          {formatCycleAnchorDayLabel(Number(day))}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </UsageProfileField>

              <UsageProfileField
                label="Timezone"
                description={`Browser timezone: ${BROWSER_TIME_ZONE}`}
                error={timeZoneError}
              >
                <TimeZoneSelector
                  value={activeTimeZoneOption}
                  options={timeZoneOptions}
                  disabled={!dashboard || isSaving}
                  invalid={timeZoneError !== null}
                  onValueChange={(value) => {
                    setTimeZoneDraft(value);
                    clearSaveFeedback();
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={!dashboard || isSaving || timeZone === BROWSER_TIME_ZONE}
                    onClick={() => {
                      setTimeZoneDraft(BROWSER_TIME_ZONE);
                      clearSaveFeedback();
                    }}
                  >
                    Use browser timezone
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={!dashboard || isSaving || timeZone === "UTC"}
                    onClick={() => {
                      setTimeZoneDraft("UTC");
                      clearSaveFeedback();
                    }}
                  >
                    Use UTC
                  </Button>
                </div>
              </UsageProfileField>

              <UsageProfileField
                label="Budget USD"
                description="Leave blank to disable the self-managed budget. This is provider cost telemetry, not billing."
                error={parsedBudget.error}
              >
                <Input
                  value={budgetInput}
                  inputMode="decimal"
                  placeholder="No budget"
                  aria-invalid={parsedBudget.error !== null}
                  disabled={!dashboard || isSaving}
                  onChange={(event) => {
                    setBudgetInputDraft(event.target.value);
                    clearSaveFeedback();
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  {BUDGET_PRESETS_USD.map((amount) => (
                    <Button
                      key={amount}
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={!dashboard || isSaving}
                      onClick={() => {
                        setBudgetInputDraft(String(amount));
                        clearSaveFeedback();
                      }}
                    >
                      {USD_FORMATTER.format(amount)}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={!dashboard || isSaving || budgetInput.trim() === ""}
                    onClick={() => {
                      setBudgetInputDraft("");
                      setHardCapEnabledDraft(false);
                      clearSaveFeedback();
                    }}
                  >
                    No budget
                  </Button>
                </div>
              </UsageProfileField>

              <UsageProfileField
                label="Hard cap"
                description={
                  hasConfiguredBudget
                    ? "New LLM work is blocked once spend plus reservations exceeds the budget."
                    : "Set a budget first to enable hard-cap enforcement."
                }
              >
                <label
                  className={cn(
                    "flex min-h-24 items-start gap-3 border border-border bg-background p-4 text-sm transition-colors",
                    hasConfiguredBudget && !isSaving
                      ? "cursor-pointer hover:border-foreground/30 hover:bg-muted/30"
                      : "cursor-not-allowed opacity-70",
                    hardCapEnabled ? "border-foreground/30 bg-muted/20" : null,
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-primary"
                    checked={hardCapEnabled}
                    disabled={!dashboard || isSaving || !hasConfiguredBudget}
                    onChange={(event) => {
                      setHardCapEnabledDraft(event.target.checked);
                      clearSaveFeedback();
                    }}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 font-semibold">
                      Hard cap new LLM work
                      <Badge variant={hardCapEnabled ? "outline" : "muted"}>{hardCapEnabled ? "On" : "Off"}</Badge>
                    </span>
                    <span className="text-muted-foreground">
                      {hasConfiguredBudget
                        ? `Blocks new estimated work over ${USD_FORMATTER.format(parsedBudget.value ?? 0)}. Already-running work can still settle actual cost.`
                        : "Budget disabled. Usage is still monitored, but no new work is blocked."}
                    </span>
                  </span>
                </label>
              </UsageProfileField>
            </div>

            <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-h-5 text-sm text-muted-foreground">
                {saveError ? <span className="text-destructive">{saveError}</span> : null}
                {!saveError && dashboard
                  ? "Changes apply to future usage events. Existing cycles keep their boundaries."
                  : null}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={resetUsageProfileDrafts}
                  disabled={!dashboard || isSaving || !isUsageProfileDirty}
                >
                  Reset
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!dashboard || isSaving || !isUsageProfileDirty || hasFormErrors}
                >
                  <CheckCircle weight="bold" />
                  {isSaving ? "Saving" : "Save settings"}
                </Button>
              </div>
            </div>
          </form>
        </Card>
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
  const [persistedStatsForNerds, setPersistedStatsForNerds] = useStatsForNerdsPreference();
  const [draftPreferences, setDraftPreferences] = useState<UserPreferences>(() => preferences);
  const [draftStatsForNerds, setDraftStatsForNerds] = useState(() => persistedStatsForNerds);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const previousPreferencesRef = useRef(preferences);
  const previousStatsForNerdsRef = useRef(persistedStatsForNerds);

  useEffect(() => {
    const previousPreferences = previousPreferencesRef.current;
    previousPreferencesRef.current = preferences;
    setDraftPreferences((currentDraft) => {
      if (!areUserPreferencesEqual(currentDraft, previousPreferences)) {
        return currentDraft;
      }
      return areUserPreferencesEqual(currentDraft, preferences) ? currentDraft : preferences;
    });
  }, [preferences]);

  useEffect(() => {
    const previousStatsForNerds = previousStatsForNerdsRef.current;
    previousStatsForNerdsRef.current = persistedStatsForNerds;
    setDraftStatsForNerds((currentDraft) =>
      currentDraft === previousStatsForNerds ? persistedStatsForNerds : currentDraft,
    );
  }, [persistedStatsForNerds]);

  const setDraftUserPreferences = useCallback<SetUserPreferences>((next) => {
    setDraftPreferences((prev) => normalizeUserPreferences(typeof next === "function" ? next(prev) : next));
    setSaveStatus(null);
  }, []);

  const setDraftStatsForNerdsPreference = useCallback((next: boolean) => {
    setDraftStatsForNerds(next);
    setSaveStatus(null);
  }, []);

  const resetDraftPreferences = useCallback(() => {
    setDraftPreferences(preferences);
    setDraftStatsForNerds(persistedStatsForNerds);
    setSaveStatus(null);
  }, [persistedStatsForNerds, preferences]);

  const savePreferences = useCallback(() => {
    const normalizedPreferences = normalizeUserPreferences(draftPreferences);
    setPreferences(normalizedPreferences);
    setPersistedStatsForNerds(draftStatsForNerds);
    setDraftPreferences(normalizedPreferences);
    setSaveStatus("Saved");
  }, [draftPreferences, draftStatsForNerds, setPersistedStatsForNerds, setPreferences]);

  const isCustomizationDirty =
    !areUserPreferencesEqual(draftPreferences, preferences) || draftStatsForNerds !== persistedStatsForNerds;

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-5">
        <StatsForNerdsSection statsForNerds={draftStatsForNerds} setStatsForNerds={setDraftStatsForNerdsPreference} />
        <Separator />
        <TraitsSection preferences={draftPreferences} setPreferences={setDraftUserPreferences} />
        <Separator />
        <CustomInstructionsSection preferences={draftPreferences} setPreferences={setDraftUserPreferences} />
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-h-5 text-sm text-muted-foreground">
            {isCustomizationDirty ? "Unsaved changes." : saveStatus || "Preferences saved."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetDraftPreferences}
              disabled={!isCustomizationDirty}
            >
              Reset
            </Button>
            <Button type="button" size="sm" onClick={savePreferences} disabled={!isCustomizationDirty}>
              <CheckCircle weight="bold" />
              Save Preferences
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function HistorySettingsSection() {
  return <HistoryPage />;
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

function UsageProfileField({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-12 flex-col gap-1">
        <p className="text-sm font-semibold">{label}</p>
        <p className={cn("text-xs leading-5", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? description}
        </p>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function TimeZoneSelector({
  value,
  options,
  disabled,
  invalid,
  onValueChange,
}: {
  value: TimeZoneOption | null;
  options: TimeZoneOption[];
  disabled: boolean;
  invalid: boolean;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useComboboxAnchor();

  return (
    <Combobox<TimeZoneOption>
      items={options}
      value={value}
      onValueChange={(option) => {
        if (!option) {
          return;
        }
        onValueChange(option.value);
        setOpen(false);
      }}
      itemToStringLabel={(option) => option.searchText}
      itemToStringValue={(option) => option.value}
      isItemEqualToValue={(item, selectedValue) => item.value === selectedValue.value}
      open={open}
      onOpenChange={setOpen}
    >
      <div ref={anchorRef} className="flex min-w-0">
        <ComboboxTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className={cn(
                "h-auto min-h-12 w-full min-w-0 justify-between bg-background px-3 py-2 active:scale-100",
                invalid ? "border-destructive focus-visible:ring-destructive/20" : null,
              )}
              aria-label="Timezone"
              aria-invalid={invalid}
              disabled={disabled}
            />
          }
          icon={<CaretUpDownIcon weight="bold" className="size-3.5 shrink-0 text-muted-foreground" />}
        >
          <span className="flex min-w-0 flex-1 flex-col items-start">
            <span className="max-w-full truncate text-sm font-medium">{value?.label ?? "Select timezone"}</span>
            <span className="max-w-full truncate text-xs font-normal text-muted-foreground">
              {value?.detail ?? "IANA timezone"}
            </span>
          </span>
        </ComboboxTrigger>
      </div>
      <ComboboxContent anchor={anchorRef} align="start" className="w-(--anchor-width) min-w-(--anchor-width)">
        <ComboboxInput placeholder="Search city, offset, or timezone…" showTrigger={false} />
        <ComboboxList>
          <ComboboxCollection>
            {(option: TimeZoneOption) => (
              <ComboboxItem key={option.value} value={option}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{option.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxCollection>
          <ComboboxEmpty>No matching timezone</ComboboxEmpty>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
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

function UsageHistorySkeletonRows() {
  return Array.from({ length: USAGE_HISTORY_PERIOD_COUNT }, (_, index) => (
    <tr key={index} className="border-b border-border last:border-b-0">
      <td className="px-5 py-3">
        <Skeleton className="h-4 w-44" />
      </td>
      <td className="px-5 py-3">
        <Skeleton className="h-4 w-20" />
      </td>
      <td className="px-5 py-3">
        <Skeleton className="h-4 w-24" />
      </td>
      <td className="px-5 py-3">
        <Skeleton className="h-4 w-16" />
      </td>
      <td className="px-5 py-3">
        <Skeleton className="h-5 w-20" />
      </td>
    </tr>
  ));
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

function formatCycleAnchorDayLabel(day: number): string {
  if (day === 31) {
    return "31 · last valid day when needed";
  }
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  return `${day}${suffix} of each month`;
}

type UsageBudgetState = "unset" | "ok" | "notice" | "warning" | "exceeded";

function normalizeBudgetState(value: string | undefined): UsageBudgetState {
  switch (value) {
    case "ok":
    case "notice":
    case "warning":
    case "exceeded":
      return value;
    case "unset":
    default:
      return "unset";
  }
}

function formatBudgetStateLabel(state: UsageBudgetState): string {
  switch (state) {
    case "unset":
      return "Unset";
    case "ok":
      return "OK";
    case "notice":
      return "Notice";
    case "warning":
      return "Warning";
    case "exceeded":
      return "Exceeded";
  }
}

function budgetBadgeVariant(state: UsageBudgetState | undefined): "muted" | "outline" | "accent" | "destructive" {
  switch (state) {
    case "exceeded":
      return "destructive";
    case "warning":
      return "accent";
    case "notice":
      return "outline";
    case "ok":
      return "outline";
    case "unset":
    default:
      return "muted";
  }
}

function getHistoryBudgetState(costUsd: number, budgetUsd: number | null): UsageBudgetState {
  if (budgetUsd === null) {
    return "unset";
  }
  const percent = budgetUsd > 0 ? (costUsd / budgetUsd) * 100 : 100;
  if (percent >= 100) return "exceeded";
  if (percent >= 80) return "warning";
  if (percent >= 50) return "notice";
  return "ok";
}

function formatPeriodRange(startMs: number, endMs: number): string {
  return `${DATE_FORMATTER.format(new Date(startMs))} - ${DATE_FORMATTER.format(new Date(Math.max(startMs, endMs - 1)))}`;
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

function StatsForNerdsSection({
  statsForNerds,
  setStatsForNerds,
}: {
  statsForNerds: boolean;
  setStatsForNerds: (next: boolean) => void;
}) {
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
      if (preferences.traits.length >= USER_TRAITS_MAX_COUNT) return;
      setPreferences((prev) => ({ ...prev, traits: [...prev.traits, trait] }));
      setTraitInput("");
    },
    [preferences.traits.length, setPreferences],
  );

  const removeTrait = useCallback(
    (value: string) => {
      setPreferences((prev) => ({ ...prev, traits: prev.traits.filter((trait) => trait !== value) }));
    },
    [setPreferences],
  );

  const selectedTraits = new Set(preferences.traits.map((trait) => trait.toLocaleLowerCase()));
  const traitLimitReached = preferences.traits.length >= USER_TRAITS_MAX_COUNT;
  const availableDefaultTraits = DEFAULT_TRAITS.filter((trait) => !selectedTraits.has(trait.toLocaleLowerCase()));

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
        className="flex"
        onSubmit={(event) => {
          event.preventDefault();
          addTrait(traitInput);
        }}
      >
        <Input
          value={traitInput}
          onChange={(event) => setTraitInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Tab" || !traitInput.trim() || traitLimitReached) {
              return;
            }
            event.preventDefault();
            addTrait(traitInput);
          }}
          placeholder="Type a trait and press Enter or Tab..."
          aria-label="Add a custom trait"
          maxLength={USER_TRAIT_MAX_LENGTH}
        />
      </form>

      {availableDefaultTraits.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {availableDefaultTraits.map((trait) => (
            <Button
              key={trait}
              type="button"
              variant="outline"
              size="xs"
              disabled={traitLimitReached}
              onClick={() => addTrait(trait)}
            >
              <Plus weight="bold" />
              {trait}
            </Button>
          ))}
        </div>
      ) : null}
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
