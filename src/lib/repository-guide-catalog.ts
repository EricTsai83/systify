import type { SystemDesignKind } from "../../convex/lib/systemDesign";

export type RepositoryGuideKind = SystemDesignKind;

export type RepositoryGuideSection = {
  kind: RepositoryGuideKind;
  title: string;
  description: string;
};

export const REPOSITORY_GUIDE_SECTIONS = [
  {
    kind: "readme_summary",
    title: "README Summary",
    description: "Purpose, services, audience, and key operations distilled from the README.",
  },
  {
    kind: "architecture_overview",
    title: "Architecture Overview",
    description: "Components, responsibilities, data and control flow, and key boundaries.",
  },
  {
    kind: "architecture_diagram",
    title: "Architecture Diagram",
    description: "Mermaid graph of components, flows, and boundaries, with legend and reading guide.",
  },
  {
    kind: "data_model_overview",
    title: "Data Model Overview",
    description: "Persistent stores, entities, relationships, invariants.",
  },
  {
    kind: "api_surface_overview",
    title: "API Surface Overview",
    description: "Externally-visible endpoints, auth, request/response shapes.",
  },
  {
    kind: "deployment_overview",
    title: "Deployment Overview",
    description: "Runtime targets, build pipeline, infra dependencies.",
  },
  {
    kind: "security_overview",
    title: "Security Overview",
    description: "Auth, authorisation, input validation, sensitive data.",
  },
  {
    kind: "operations_overview",
    title: "Operations Overview",
    description: "Logging, metrics, tracing, alerting, run-books.",
  },
] as const satisfies ReadonlyArray<RepositoryGuideSection>;

export const REPOSITORY_GUIDE_SECTION_TITLES = Object.fromEntries(
  REPOSITORY_GUIDE_SECTIONS.map((section) => [section.kind, section.title]),
) as Record<RepositoryGuideKind, string>;
