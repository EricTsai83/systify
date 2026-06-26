import { useMemo } from "react";
import { useQuery } from "convex/react";
import { CheckCircleIcon, SparkleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { REPOSITORY_GUIDE_SECTIONS } from "@/lib/repository-guide-catalog";
import type { ArtifactId, ArtifactListItem, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

type SectionStatus = "ready" | "generating" | "pending";

/**
 * Library canvas surface for the Repository Guide. It unifies three states
 * that used to be separate (or missing) screens into one self-explaining
 * board:
 *
 *   - **Empty** — every section is previewed as a ghost card so a first-run
 *     user can *see* what the guide will contain before committing, with the
 *     primary "Generate guide" CTA front-and-centre. This replaces the old
 *     dead-end "No sections yet — generate from the Ask panel" message that
 *     pointed users away from the largest, most attention-grabbing region.
 *   - **Generating** — cards flip to a live "generating" state and resolve to
 *     "ready" one-by-one as artifacts land, mirroring the per-kind nature of
 *     the backend job. The board fills in instead of staring at a thin banner.
 *   - **Populated** — ready cards become a launcher: clicking one opens it in
 *     a tab, so this also serves as the "no tab open" landing.
 *
 * Section presentation (icon/title/description) comes from
 * {@link REPOSITORY_GUIDE_SECTIONS}; per-section status is derived from the
 * repo's artifacts (already subscribed by the shell) plus the active
 * generation job. The component owns only the lightweight active-job
 * subscription — Convex dedupes it against the dialog's identical query.
 */
export function RepositoryGuideOverview({
  repositoryId,
  artifacts,
  onSelectArtifact,
  onGenerate,
  generateDisabledReason,
}: {
  repositoryId: RepositoryId;
  artifacts: ReadonlyArray<ArtifactListItem>;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onGenerate: () => void;
  generateDisabledReason?: string;
}) {
  const activeJob = useQuery(api.systemDesign.getActiveSystemDesignJob, { repositoryId });

  // First artifact per guide kind. Keyed by the raw kind string so the broad
  // artifact-kind union never needs a cast; section lookups pass the narrow
  // `RepositoryGuideKind`, which is a subset of that string domain.
  const artifactByKind = useMemo(() => {
    const byKind = new Map<string, ArtifactListItem>();
    for (const artifact of artifacts) {
      if (!byKind.has(artifact.kind)) byKind.set(artifact.kind, artifact);
    }
    return byKind;
  }, [artifacts]);

  // Kinds the in-flight job is producing. `null` job → nothing generating.
  const generatingKinds = useMemo(() => new Set<string>(activeJob?.selections ?? []), [activeJob]);

  const total = REPOSITORY_GUIDE_SECTIONS.length;
  const readyCount = useMemo(
    () => REPOSITORY_GUIDE_SECTIONS.filter((section) => artifactByKind.has(section.kind)).length,
    [artifactByKind],
  );
  const isGenerating = activeJob != null;

  const heading = isGenerating
    ? `Generating your ${REPOSITORY_GUIDE_COPY.name}…`
    : readyCount === 0
      ? `Generate your ${REPOSITORY_GUIDE_COPY.name}`
      : REPOSITORY_GUIDE_COPY.name;

  const description = isGenerating
    ? `${readyCount} of ${total} ready — ${REPOSITORY_GUIDE_COPY.overviewGeneratingDescription}`
    : readyCount === 0
      ? REPOSITORY_GUIDE_COPY.overviewEmptyDescription
      : readyCount === total
        ? `All ${total} ${REPOSITORY_GUIDE_COPY.sectionNamePlural} are ready. Open one to read it, or regenerate to refresh against the latest code.`
        : `${readyCount} of ${total} ${REPOSITORY_GUIDE_COPY.sectionNamePlural} ready. Generate the rest to complete the guide.`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section
        aria-label={REPOSITORY_GUIDE_COPY.name}
        className="mx-auto flex w-full max-w-3xl animate-enter-fade flex-col gap-6 px-6 py-10"
      >
        <header className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-primary">
            <SparkleIcon size={20} weight="bold" />
          </span>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{heading}</h2>
            <p className="mx-auto max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          <Button
            type="button"
            size="lg"
            className="mt-1 gap-2"
            onClick={onGenerate}
            disabled={generateDisabledReason !== undefined || isGenerating}
            title={generateDisabledReason}
          >
            {isGenerating ? (
              <>
                <Spinner size={16} />
                Generating…
              </>
            ) : (
              <>
                <SparkleIcon size={16} weight="bold" />
                {REPOSITORY_GUIDE_COPY.generateAction}
              </>
            )}
          </Button>
        </header>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {REPOSITORY_GUIDE_SECTIONS.map((section) => {
            const artifact = artifactByKind.get(section.kind);
            const status: SectionStatus = artifact
              ? "ready"
              : generatingKinds.has(section.kind)
                ? "generating"
                : "pending";
            return (
              <li key={section.kind}>
                <SectionCard
                  icon={section.icon}
                  title={section.title}
                  description={section.description}
                  status={status}
                  onOpen={artifact ? () => onSelectArtifact(artifact._id as ArtifactId) : undefined}
                />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function SectionCard({
  icon: Icon,
  title,
  description,
  status,
  onOpen,
}: {
  icon: (typeof REPOSITORY_GUIDE_SECTIONS)[number]["icon"];
  title: string;
  description: string;
  status: SectionStatus;
  onOpen?: () => void;
}) {
  const isReady = status === "ready";
  const isGenerating = status === "generating";

  const body = (
    <>
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          isReady
            ? "border-border bg-muted text-foreground group-hover:border-foreground/30"
            : "border-border/60 bg-muted/40 text-muted-foreground",
        )}
      >
        <Icon size={16} weight="bold" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span
            className={cn("truncate text-[13px] font-semibold", isReady ? "text-foreground" : "text-muted-foreground")}
          >
            {title}
          </span>
          <StatusBadge status={status} />
        </div>
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/90">{description}</p>
      </div>
    </>
  );

  // Ready sections are real navigation targets → a button. Generating and
  // pending sections are previews, not actions, so they render as inert
  // containers (no focus stop, no hover affordance). A generating card carries
  // `aria-busy` so assistive tech announces it as updating; the per-section
  // text badge ("Generating…" / "Not yet") states the rest in plain words.
  if (isReady && onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${title}`}
        className="group flex w-full items-start gap-3 border border-border bg-card/50 p-3 text-left transition-colors hover:border-foreground/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {body}
      </button>
    );
  }

  return (
    <div
      aria-busy={isGenerating || undefined}
      className={cn(
        "flex w-full items-start gap-3 border border-dashed border-border/70 p-3",
        isGenerating ? "bg-card/30" : "bg-transparent opacity-70",
      )}
    >
      {body}
    </div>
  );
}

function StatusBadge({ status }: { status: SectionStatus }) {
  if (status === "ready") {
    return <CheckCircleIcon size={14} weight="fill" className="ml-auto shrink-0 text-success" aria-hidden />;
  }
  if (status === "generating") {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
        <Spinner size={11} />
        Generating…
      </span>
    );
  }
  return (
    <span className="ml-auto shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
      Not yet
    </span>
  );
}
