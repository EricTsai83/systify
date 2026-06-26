import {
  BookOpenIcon,
  CloudArrowUpIcon,
  DatabaseIcon,
  GraphIcon,
  type Icon,
  PlugsConnectedIcon,
  PulseIcon,
  ShieldCheckIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import type { SystemDesignKind } from "../../convex/lib/systemDesign";

export type RepositoryGuideKind = SystemDesignKind;

export type RepositoryGuideSection = {
  kind: RepositoryGuideKind;
  title: string;
  description: string;
  /**
   * Glyph used wherever a section is previewed as a card (the Library guide
   * overview, the generate dialog's checklist). Lives in the catalog so the
   * icon, title, and description stay a single source of truth across every
   * surface that renders the section.
   */
  icon: Icon;
};

export const REPOSITORY_GUIDE_SECTIONS = [
  {
    kind: "readme_summary",
    title: "README Summary",
    description: "Purpose, services, audience, and key operations distilled from the README.",
    icon: BookOpenIcon,
  },
  {
    kind: "architecture_overview",
    title: "Architecture Overview",
    description: "Components, responsibilities, data and control flow, and key boundaries.",
    icon: TreeStructureIcon,
  },
  {
    kind: "architecture_diagram",
    title: "Architecture Diagram",
    description: "Mermaid graph of components, flows, and boundaries, with legend and reading guide.",
    icon: GraphIcon,
  },
  {
    kind: "data_model_overview",
    title: "Data Model Overview",
    description: "Persistent stores, entities, relationships, invariants.",
    icon: DatabaseIcon,
  },
  {
    kind: "api_surface_overview",
    title: "API Surface Overview",
    description: "Externally-visible endpoints, auth, request/response shapes.",
    icon: PlugsConnectedIcon,
  },
  {
    kind: "deployment_overview",
    title: "Deployment Overview",
    description: "Runtime targets, build pipeline, infra dependencies.",
    icon: CloudArrowUpIcon,
  },
  {
    kind: "security_overview",
    title: "Security Overview",
    description: "Auth, authorisation, input validation, sensitive data.",
    icon: ShieldCheckIcon,
  },
  {
    kind: "operations_overview",
    title: "Operations Overview",
    description: "Logging, metrics, tracing, alerting, run-books.",
    icon: PulseIcon,
  },
] as const satisfies ReadonlyArray<RepositoryGuideSection>;

export const REPOSITORY_GUIDE_SECTION_TITLES = Object.fromEntries(
  REPOSITORY_GUIDE_SECTIONS.map((section) => [section.kind, section.title]),
) as Record<RepositoryGuideKind, string>;
