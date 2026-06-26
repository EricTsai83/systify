import { REPOSITORY_GUIDE_COPY } from "./product-copy";
import { REPOSITORY_GUIDE_SECTION_TITLES, type RepositoryGuideKind } from "./repository-guide-catalog";
import type { SystemDesignFailureReason } from "../../convex/lib/systemDesignFailures";

export type RepositoryGuideFailureReason = SystemDesignFailureReason;

export type RepositoryGuideFailureDescriptor = {
  title: string;
  reasonText: string;
  buttonLabel: string;
  selections: RepositoryGuideKind[];
};

export type RepositoryGuideFailureJob = {
  errorMessage?: string;
  selections?: readonly RepositoryGuideKind[];
  kindFailures?: ReadonlyArray<{
    kind: RepositoryGuideKind;
    reason?: RepositoryGuideFailureReason;
  }>;
};

const REASON_TEXT_ALL_LIVE_SOURCE =
  "Live access to the repository wasn't available when this ran. The next attempt will prepare it first.";
const REASON_TEXT_ALL_EMPTY = "The model didn't produce a complete design doc. The next attempt may succeed.";
const REASON_TEXT_ALL_RATE_LIMIT =
  "The provider rate-limited the run. Wait a couple of minutes and the next attempt should go through.";
const REASON_TEXT_ALL_QUALITY =
  "Some design docs came back without the required content. Retrying usually fixes this - open the details if it persists.";
const REASON_TEXT_ALL_TRANSPORT =
  "A transport error stopped the run (network / provider 5xx). The error id is in the log if you need to report it.";
const REASON_TEXT_ALL_INFRA = "An internal error stopped the run. Engineering has been notified - retry to try again.";
const REASON_TEXT_MIXED = "Some design docs couldn't be generated. The next attempt will retry the failed ones.";
const REASON_TEXT_FALLBACK = "Something stopped the run before it finished. The next attempt will start a fresh one.";

const REASON_TEXT_BY_KIND: Record<RepositoryGuideFailureReason, string> = {
  live_source_unavailable: REASON_TEXT_ALL_LIVE_SOURCE,
  model_empty_output: REASON_TEXT_ALL_EMPTY,
  transport_rate_limit: REASON_TEXT_ALL_RATE_LIMIT,
  output_quality: REASON_TEXT_ALL_QUALITY,
  transport_other: REASON_TEXT_ALL_TRANSPORT,
  infra: REASON_TEXT_ALL_INFRA,
};

export function getRepositoryGuideKindTitle(kind: string): string {
  return isRepositoryGuideKind(kind) ? REPOSITORY_GUIDE_SECTION_TITLES[kind] : kind;
}

export function describeRepositoryGuideFailure(
  job: RepositoryGuideFailureJob,
): RepositoryGuideFailureDescriptor | null {
  const kindFailures = job.kindFailures ?? [];
  const failedKinds = uniqueKinds(kindFailures.map((failure) => failure.kind));

  let selections: RepositoryGuideKind[] = [];
  if (kindFailures.length > 0) {
    selections = failedKinds;
  } else if (job.selections !== undefined && job.selections.length > 0) {
    selections = uniqueKinds(job.selections);
  } else {
    return null;
  }

  const titles = selections.map((kind) => REPOSITORY_GUIDE_SECTION_TITLES[kind]);
  const title =
    selections.length === 1
      ? `Couldn't generate ${titles[0]}`
      : `Couldn't generate ${selections.length} ${REPOSITORY_GUIDE_COPY.sectionNamePlural}`;
  const buttonLabel =
    selections.length === 1
      ? `Generate ${titles[0]}`
      : `Generate ${selections.length} ${REPOSITORY_GUIDE_COPY.sectionNamePlural}`;

  return {
    title,
    reasonText: describeFailureReason(job, kindFailures),
    buttonLabel,
    selections,
  };
}

function describeFailureReason(
  job: RepositoryGuideFailureJob,
  kindFailures: NonNullable<RepositoryGuideFailureJob["kindFailures"]>,
): string {
  if (kindFailures.length === 0) {
    return job.errorMessage && job.errorMessage.trim() ? job.errorMessage : REASON_TEXT_FALLBACK;
  }

  const reasons = Array.from(
    new Set<RepositoryGuideFailureReason | undefined>(kindFailures.map((failure) => failure.reason)),
  ).filter((reason): reason is RepositoryGuideFailureReason => reason !== undefined);

  if (reasons.length === 1) {
    return REASON_TEXT_BY_KIND[reasons[0]] ?? REASON_TEXT_FALLBACK;
  }
  if (reasons.length === 0) {
    return REASON_TEXT_FALLBACK;
  }
  return REASON_TEXT_MIXED;
}

function isRepositoryGuideKind(kind: string): kind is RepositoryGuideKind {
  return Object.prototype.hasOwnProperty.call(REPOSITORY_GUIDE_SECTION_TITLES, kind);
}

function uniqueKinds(kinds: readonly RepositoryGuideKind[]): RepositoryGuideKind[] {
  return Array.from(new Set(kinds));
}
