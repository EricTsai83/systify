import { v } from "convex/values";

/**
 * Three-mode restructure — shared Convex validator for the top-level
 * service mode the workspace shell is currently rendering. Exported so the
 * schema (`workspaces.lastServiceMode`) and any mutation that needs to
 * accept a mode arg both stay in lockstep with the {@link ServiceMode}
 * union declared in `convex/chatModeResolver.ts` — adding a new mode is a
 * single-place edit instead of three.
 */
export const serviceModeValidator = v.union(v.literal("discuss"), v.literal("library"), v.literal("lab"));
