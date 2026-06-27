import { useMemo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { ClockIcon, FileTextIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { Spinner } from "@/components/ui/spinner";
import { formatArtifactKind } from "@/lib/operations";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { REPOSITORY_GUIDE_SECTION_TITLES } from "@/lib/repository-guide-catalog";
import type { ArtifactId, ArtifactListItem, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

type DocumentGroup = {
  key: string;
  title: string;
  description: string;
  artifacts: ArtifactListItem[];
};

const GUIDE_KIND_TITLES: Readonly<Record<string, string>> = REPOSITORY_GUIDE_SECTION_TITLES;
const RECENT_DOCUMENT_LIMIT = 5;

const updatedFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/**
 * Library landing/navigation surface. It presents existing repository documents
 * as launchers, so the overview never implies that missing documents are real
 * content.
 *
 * Artifact metadata is hoisted by the shell; this component owns only the
 * lightweight active-job subscription — Convex dedupes it against the
 * dialog's identical query.
 */
export function RepositoryGuideNavigator({
  repositoryId,
  artifacts,
  onSelectArtifact,
}: {
  repositoryId: RepositoryId;
  artifacts: ReadonlyArray<ArtifactListItem>;
  onSelectArtifact: (artifactId: ArtifactId) => void;
}) {
  const activeJob = useQuery(api.systemDesign.getActiveSystemDesignJob, { repositoryId });

  const isGenerating = activeJob != null;
  const sortedArtifacts = useMemo(() => [...artifacts].sort(compareArtifactsByUpdatedTime), [artifacts]);
  const recentArtifacts = useMemo(() => sortedArtifacts.slice(0, RECENT_DOCUMENT_LIMIT), [sortedArtifacts]);
  const documentGroups = useMemo(() => buildDocumentGroups(sortedArtifacts), [sortedArtifacts]);
  const documentCount = sortedArtifacts.length;
  const activeSelectionCount = activeJob?.selections?.length ?? 0;

  const heading = isGenerating
    ? "Library overview"
    : documentCount === 0
      ? "No library documents yet"
      : "Library overview";

  const description = isGenerating
    ? `${REPOSITORY_GUIDE_COPY.navigatorGeneratingDescription} Existing documents stay available here.`
    : documentCount === 0
      ? REPOSITORY_GUIDE_COPY.navigatorEmptyDescription
      : `${documentCount} document${documentCount === 1 ? "" : "s"} in this repository. Open one below or use the folder tree for deeper organization.`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section
        aria-label="Library overview"
        className="mx-auto flex w-full max-w-4xl animate-enter-fade flex-col gap-6 px-6 py-8"
      >
        <header className="border-b border-border pb-5">
          <div className="min-w-0 space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{heading}</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
            {isGenerating ? (
              <div
                className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground"
                aria-live="polite"
              >
                <Spinner size={12} />
                {activeSelectionCount > 0
                  ? `Generating ${activeSelectionCount} ${
                      activeSelectionCount === 1
                        ? REPOSITORY_GUIDE_COPY.sectionName
                        : REPOSITORY_GUIDE_COPY.sectionNamePlural
                    }…`
                  : `Generating ${REPOSITORY_GUIDE_COPY.sectionNamePlural}…`}
              </div>
            ) : null}
          </div>
        </header>

        {documentCount === 0 ? (
          <EmptyDocumentsState />
        ) : (
          <>
            <DocumentGroupSection title="Recent" description="The latest documents changed in this repository.">
              {recentArtifacts.map((artifact) => (
                <li key={artifact._id}>
                  <DocumentCard
                    artifact={artifact}
                    emphasis="recent"
                    onOpen={() => onSelectArtifact(artifact._id as ArtifactId)}
                  />
                </li>
              ))}
            </DocumentGroupSection>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              {documentGroups.map((group) => (
                <DocumentGroupSection key={group.key} title={group.title} description={group.description} compact>
                  {group.artifacts.map((artifact) => (
                    <li key={artifact._id}>
                      <DocumentCard artifact={artifact} onOpen={() => onSelectArtifact(artifact._id as ArtifactId)} />
                    </li>
                  ))}
                </DocumentGroupSection>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function EmptyDocumentsState() {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        <FileTextIcon size={18} weight="bold" />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-foreground">No documents to show</h3>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
        Generate design docs or create a document from Library Ask. Once a document exists, it appears here.
      </p>
    </div>
  );
}

function DocumentGroupSection({
  title,
  description,
  compact = false,
  children,
}: {
  title: string;
  description: string;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label={title}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <ul className={cn("grid grid-cols-1 gap-2", !compact && "sm:grid-cols-2")}>{children}</ul>
    </section>
  );
}

function DocumentCard({
  artifact,
  emphasis = "normal",
  onOpen,
}: {
  artifact: ArtifactListItem;
  emphasis?: "normal" | "recent";
  onOpen: () => void;
}) {
  const kindLabel = GUIDE_KIND_TITLES[artifact.kind] ?? formatArtifactKind(artifact.kind);
  const updatedAt = artifact.updatedAt ?? artifact._creationTime;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${artifact.title}`}
      className={cn(
        "group flex w-full items-start gap-3 border border-border bg-card/50 p-3 text-left transition-colors hover:border-foreground/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        emphasis === "recent" && "min-h-[104px]",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground transition-colors group-hover:border-foreground/30">
        <FileTextIcon size={16} weight="bold" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <span className="truncate text-[13px] font-semibold text-foreground">{artifact.title}</span>
          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">{kindLabel}</span>
        </div>
        {artifact.description ? (
          <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/90">{artifact.description}</p>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <ClockIcon size={11} weight="bold" aria-hidden />
          <span>Updated {updatedFormatter.format(updatedAt)}</span>
        </div>
      </div>
    </button>
  );
}

function buildDocumentGroups(artifacts: ReadonlyArray<ArtifactListItem>): DocumentGroup[] {
  const designDocs: ArtifactListItem[] = [];
  const customDocs: ArtifactListItem[] = [];
  const otherDocs: ArtifactListItem[] = [];

  for (const artifact of artifacts) {
    if (artifact.kind === "custom_document") {
      customDocs.push(artifact);
    } else if (artifact.kind in GUIDE_KIND_TITLES) {
      designDocs.push(artifact);
    } else {
      otherDocs.push(artifact);
    }
  }

  const groups: DocumentGroup[] = [];
  if (designDocs.length > 0) {
    groups.push({
      key: "design-docs",
      title: REPOSITORY_GUIDE_COPY.name,
      description: "Generated repository analysis.",
      artifacts: designDocs,
    });
  }
  if (customDocs.length > 0) {
    groups.push({
      key: "custom-docs",
      title: "Custom documents",
      description: "Documents created or drafted by users.",
      artifacts: customDocs,
    });
  }
  if (otherDocs.length > 0) {
    groups.push({
      key: "repository-docs",
      title: "Repository docs",
      description: "Additional system-design and repository artifacts.",
      artifacts: otherDocs,
    });
  }

  return groups;
}

function compareArtifactsByUpdatedTime(left: ArtifactListItem, right: ArtifactListItem) {
  return (right.updatedAt ?? right._creationTime) - (left.updatedAt ?? left._creationTime);
}
