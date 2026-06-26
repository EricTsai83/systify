import { useMemo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { CheckCircleIcon, SparkleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { REPOSITORY_GUIDE_SECTIONS } from "@/lib/repository-guide-catalog";
import type { ArtifactId, ArtifactListItem, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

type SectionStatus = "generated" | "generating" | "template";

/**
 * Library canvas surface for Design Docs. It presents generated documents as
 * launchers and ungenerated kinds as optional templates, avoiding checklist
 * language that would imply every repository must produce every template.
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

  const readyCount = useMemo(
    () => REPOSITORY_GUIDE_SECTIONS.filter((section) => artifactByKind.has(section.kind)).length,
    [artifactByKind],
  );
  const isGenerating = activeJob != null;

  const heading = isGenerating
    ? `Generating ${REPOSITORY_GUIDE_COPY.name}…`
    : readyCount === 0
      ? `Start with ${REPOSITORY_GUIDE_COPY.name.toLowerCase()}`
      : REPOSITORY_GUIDE_COPY.name;

  const description = isGenerating
    ? `${REPOSITORY_GUIDE_COPY.overviewGeneratingDescription} You can generate more templates anytime.`
    : readyCount === 0
      ? REPOSITORY_GUIDE_COPY.overviewEmptyDescription
      : `${readyCount} ${readyCount === 1 ? REPOSITORY_GUIDE_COPY.sectionName : REPOSITORY_GUIDE_COPY.sectionNamePlural} generated. Start from another template only if it helps this repository.`;

  const generatedSections = REPOSITORY_GUIDE_SECTIONS.filter((section) => artifactByKind.has(section.kind));
  const templateSections = REPOSITORY_GUIDE_SECTIONS.filter((section) => !artifactByKind.has(section.kind));

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
            disabled={generateDisabledReason !== undefined}
            title={generateDisabledReason}
          >
            {isGenerating ? (
              <>
                <SparkleIcon size={16} weight="bold" />
                {REPOSITORY_GUIDE_COPY.generateAction}
              </>
            ) : (
              <>
                <SparkleIcon size={16} weight="bold" />
                {REPOSITORY_GUIDE_COPY.generateAction}
              </>
            )}
          </Button>
        </header>

        {generatedSections.length > 0 ? (
          <TemplateGroup title="Generated docs">
            {generatedSections.map((section) => {
              const artifact = artifactByKind.get(section.kind);
              return (
                <li key={section.kind}>
                  <SectionCard
                    icon={section.icon}
                    title={section.title}
                    description={section.description}
                    status="generated"
                    onOpen={artifact ? () => onSelectArtifact(artifact._id as ArtifactId) : undefined}
                  />
                </li>
              );
            })}
          </TemplateGroup>
        ) : null}

        {templateSections.length > 0 ? (
          <TemplateGroup title={generatedSections.length > 0 ? "Templates" : "Optional templates"}>
            {templateSections.map((section) => {
              const status: SectionStatus = generatingKinds.has(section.kind) ? "generating" : "template";
              return (
                <li key={section.kind}>
                  <SectionCard
                    icon={section.icon}
                    title={section.title}
                    description={section.description}
                    status={status}
                  />
                </li>
              );
            })}
          </TemplateGroup>
        ) : null}
      </section>
    </div>
  );
}

function TemplateGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</ul>
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
  const isGenerated = status === "generated";
  const isGenerating = status === "generating";

  const body = (
    <>
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          isGenerated
            ? "border-border bg-muted text-foreground group-hover:border-foreground/30"
            : "border-border/60 bg-muted/40 text-muted-foreground",
        )}
      >
        <Icon size={16} weight="bold" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-[13px] font-semibold",
              isGenerated ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {title}
          </span>
          <StatusBadge status={status} />
        </div>
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/90">{description}</p>
      </div>
    </>
  );

  // Generated sections are real navigation targets → a button. Generating and
  // template sections are previews, not actions, so they render as inert
  // containers (no focus stop, no hover affordance). A generating card carries
  // `aria-busy` so assistive tech announces it as updating.
  if (isGenerated && onOpen) {
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
  if (status === "generated") {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium text-success">
        <CheckCircleIcon size={12} weight="fill" aria-hidden />
        Generated
      </span>
    );
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
      Template
    </span>
  );
}
