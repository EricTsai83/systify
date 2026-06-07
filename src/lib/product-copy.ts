export { REPOSITORY_GUIDE_SECTION_TITLES } from "./repository-guide-catalog";

/**
 * User-facing vocabulary for the internal `system_design` capability.
 *
 * DB/job/function names intentionally stay stable (`systemDesignKindRuns`,
 * `jobs.kind: "system_design"`). UI surfaces should use this copy instead
 * of exposing the implementation term "System Design" to users.
 */
export const REPOSITORY_GUIDE_COPY = {
  name: "Repository Guide",
  sectionName: "guide section",
  sectionNamePlural: "guide sections",
  generateAction: "Generate Repository Guide",
  generateSelectedAction: "Generate selected",
  emptyLibraryDescription:
    "This Library has no Repository Guide sections to read yet. Generate them from the Ask panel to get started.",
  noArtifactsTitle: "No guide sections to ask about yet",
  noArtifactsDescription:
    "Library Ask cites indexed guide sections. Generate the Repository Guide so it has something to retrieve.",
} as const;
