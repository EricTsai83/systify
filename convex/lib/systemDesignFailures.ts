import { v } from "convex/values";

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

export const systemDesignFailureReasonValidator = v.union(
  v.literal(SYSTEM_DESIGN_FAILURE_REASONS[0]),
  v.literal(SYSTEM_DESIGN_FAILURE_REASONS[1]),
  v.literal(SYSTEM_DESIGN_FAILURE_REASONS[2]),
  v.literal(SYSTEM_DESIGN_FAILURE_REASONS[3]),
  v.literal(SYSTEM_DESIGN_FAILURE_REASONS[4]),
  v.literal(SYSTEM_DESIGN_FAILURE_REASONS[5]),
);

export function isSystemDesignFailureReason(value: string): value is SystemDesignFailureReason {
  return (SYSTEM_DESIGN_FAILURE_REASONS as readonly string[]).includes(value);
}
