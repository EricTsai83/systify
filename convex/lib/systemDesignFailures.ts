import { v, type GenericValidator } from "convex/values";

/**
 * Structured failure categories for per-kind System Design failures.
 *
 * This Module is deliberately schema-safe: no Node runtime imports, no
 * provider SDK imports, and no Convex function registration. That keeps it
 * usable from `schema.ts`, mutations, Node actions, and type-only frontend
 * imports without pulling runtime-specific dependencies across seams.
 */
export const SYSTEM_DESIGN_FAILURE_REASONS = [
  "live_source_unavailable",
  "model_empty_output",
  "transport_rate_limit",
  "transport_other",
  "output_quality",
  "infra",
] as const;

export type SystemDesignFailureReason = (typeof SYSTEM_DESIGN_FAILURE_REASONS)[number];

const systemDesignFailureReasonLiterals = SYSTEM_DESIGN_FAILURE_REASONS.map((reason) => v.literal(reason)) as [
  GenericValidator,
  GenericValidator,
  ...GenericValidator[],
];

export const systemDesignFailureReasonValidator = v.union(...systemDesignFailureReasonLiterals);

export function isSystemDesignFailureReason(value: string): value is SystemDesignFailureReason {
  return (SYSTEM_DESIGN_FAILURE_REASONS as readonly string[]).includes(value);
}
