import { useMemo } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { LibrarySubMode, ServiceMode, WorkspaceId } from "@/lib/types";

interface ServiceModeDisabledLike {
  code: string;
  message: string;
  retryAfterMs?: number;
}

const NULL_RESOLUTION = {
  availableServiceModes: ["discuss"] as ReadonlyArray<ServiceMode>,
  defaultServiceMode: "discuss" as ServiceMode,
  disabledReasons: {} as Partial<Record<ServiceMode, ServiceModeDisabledLike>>,
  hasAttachedRepo: false,
  hasAtLeastOneArtifact: false,
  askReadiness: { canBind: false, reason: null as ServiceModeDisabledLike | null },
  labReadiness: { canStart: false, reason: null as ServiceModeDisabledLike | null },
};

/**
 * Three-mode restructure — bridge between the workspace URL and the
 * service-mode resolver.
 *
 * Returns:
 *   - `serviceMode` — the mode the URL is currently rendering (`discuss`,
 *     `library`, or `lab`). The URL is the source of truth; this hook
 *     just normalizes it. Falls back to the resolver's default for the
 *     `/w/:wid` plain workspace landing.
 *   - `librarySubMode` — `read` (default) or `ask` when the URL is on
 *     `/library/ask/:tid`. Pure UI state derived from the URL — never
 *     persisted.
 *   - `availability` — the resolver output keyed by service mode, used
 *     by the switcher to decide which buttons to grey out and the
 *     tooltip to render.
 *
 * Callers should treat `availability === undefined` as "loading" and
 * defer rendering disabled-state tooltips until it lands. Returning
 * `null` here would force every consumer to write the same loading
 * branch; instead we surface a "discuss-only, no reasons" placeholder
 * resolution so the switcher can paint a usable surface on first paint
 * and reconcile once the query resolves.
 */
export function useServiceMode(workspaceId: WorkspaceId | null) {
  const location = useLocation();
  const params = useParams<{ workspaceId?: string; threadId?: string; artifactId?: string }>();
  const availability = useQuery(api.serviceModeEligibility.evaluate, workspaceId ? { workspaceId } : "skip");

  const serviceMode = useMemo<ServiceMode>(() => {
    // The URL prefix tells us which mode is mounted. We match the path
    // segment after the workspace id; query params (`?ask=1`, `?open=…`)
    // do not change the service-mode bucket. `/w/:wid` (no trailing
    // segment) falls through to the resolver default; the workspace
    // shell will redirect to the canonical URL once it knows the
    // default.
    const path = location.pathname;
    if (params.workspaceId) {
      const prefix = `/w/${params.workspaceId}`;
      if (path === prefix || path === `${prefix}/`) {
        return availability?.defaultServiceMode ?? NULL_RESOLUTION.defaultServiceMode;
      }
      if (path.startsWith(`${prefix}/discuss`)) {
        return "discuss";
      }
      if (path.startsWith(`${prefix}/library`)) {
        return "library";
      }
      if (path.startsWith(`${prefix}/lab`)) {
        return "lab";
      }
      // Legacy `/t/:tid` and `/a/:aid` URLs route to a thread-mode-
      // dependent service mode — the workspace shell still owns that
      // redirect (Phase 1.4 keeps them functional). Surfacing
      // `discuss` as the placeholder keeps the switcher from blinking
      // into a "no mode active" state during the redirect window.
      return "discuss";
    }
    return availability?.defaultServiceMode ?? NULL_RESOLUTION.defaultServiceMode;
  }, [location.pathname, params.workspaceId, availability?.defaultServiceMode]);

  const librarySubMode = useMemo<LibrarySubMode>(() => {
    if (serviceMode !== "library") {
      return "read";
    }
    return location.pathname.includes("/library/ask/") ? "ask" : "read";
  }, [location.pathname, serviceMode]);

  return {
    serviceMode,
    librarySubMode,
    /**
     * `undefined` while the workspace query loads. Consumers that need a
     * never-undefined value can fall back to {@link NULL_RESOLUTION}.
     */
    availability,
    /** Stable placeholder so first-paint code paths can avoid a null check. */
    placeholderAvailability: NULL_RESOLUTION,
  };
}
