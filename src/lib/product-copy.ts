export { REPOSITORY_GUIDE_SECTION_TITLES } from "./repository-guide-catalog";

/**
 * User-facing vocabulary for the internal `system_design` capability.
 *
 * DB/job/function names intentionally stay stable (`systemDesignKindRuns`,
 * `jobs.kind: "system_design"`). UI surfaces should use this copy instead
 * of exposing the implementation term "System Design" to users.
 */
export const REPOSITORY_GUIDE_COPY = {
  name: "Design Docs",
  sectionName: "design doc",
  sectionNamePlural: "design docs",
  // CTA + body copy drop the "Repository" qualifier: every surface that
  // shows them already sits inside a single repository (the URL, the header,
  // and the panel title all name it), so repeating it reads as boilerplate.
  // The full `name` is reserved for the one place each view needs to stand on
  // its own — the header menu, the generate dialog title, the docs overview
  // headline.
  generateAction: "Generate design docs",
  generateSelectedAction: "Generate selected",
  // First-run / overview hero, shown on the Library canvas before any section
  // exists. Leads with the outcome (readable docs you can ask about) instead
  // of the absence of content.
  overviewEmptyDescription:
    "Use optional templates to create reference docs for this repository. Generate only what is useful.",
  overviewGeneratingDescription: "New docs open as soon as they finish.",
  noArtifactsTitle: "No design docs to ask about yet",
  noArtifactsDescription: "Library Ask cites indexed design docs. Generate them so it has something to retrieve.",
} as const;
