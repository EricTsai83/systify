import { useMemo } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { WorkspaceModeDisabledReasonCode } from "../../convex/lib/chatEligibility";
import type { ChatMode, WorkspaceId } from "@/lib/types";

/**
 * Per-axis verdict shape consumed by chrome that subscribes to
 * `workspaceModeEligibility.evaluate`. `code` is the backend enum union
 * plus a `"loading"` sentinel for the placeholder fallback, so a backend
 * addition to `WorkspaceModeDisabledReasonCode` surfaces as a compile
 * error here rather than slipping through under `string`.
 */
interface ChatModeDisabledLike {
  enabled: false;
  code: WorkspaceModeDisabledReasonCode | "loading";
  message: string;
}
type AxisVerdictLike = { enabled: true } | ChatModeDisabledLike;
type SandboxVerdictLike = { enabled: true } | (ChatModeDisabledLike & { isActivatable: boolean });

const LOADING_AXIS: ChatModeDisabledLike = {
  enabled: false,
  code: "loading",
  message: "Loading…",
};

const NULL_RESOLUTION = {
  modes: {
    discuss: { enabled: true } as AxisVerdictLike,
    library: LOADING_AXIS as AxisVerdictLike,
  },
  defaultMode: "discuss" as ChatMode,
  hasAttachedRepo: false,
  hasAtLeastOneArtifact: false,
  askReadiness: LOADING_AXIS as AxisVerdictLike,
  grounding: {
    library: LOADING_AXIS as AxisVerdictLike,
    sandbox: { ...LOADING_AXIS, isActivatable: false } as SandboxVerdictLike,
  },
};

/**
 * Bridge between the workspace URL and the service-mode resolver.
 *
 * Returns:
 *   - `mode` — the mode the URL is currently rendering, or `null` if
 *     the URL is a transient / non-canonical one (`/chat`, `/w/:wid`,
 *     `/w/:wid/t/:tid`). Callers that gate chrome on the user's "current
 *     mode" should treat `null` as "no mode chrome yet" — never paint
 *     mode-dependent surfaces (StatusPill, ArtifactPanel) before the URL
 *     settles on a canonical `/w/:wid/{discuss,library,lab}/...` path.
 *     This eliminates the flash that used to happen when transient URLs
 *     briefly resolved to the workspace's default mode (e.g. "library"
 *     for a repo-attached workspace) before the canonicalising redirect
 *     landed on a legacy `/t/:tid` URL where the placeholder collapsed
 *     back to "discuss".
 *   - `availability` — the resolver output keyed by service mode, used by
 *     the switcher to decide which buttons to grey out, by the workspace
 *     shell to decide which mode to redirect transient URLs to, and the
 *     tooltip to render. Independent of `mode` — the URL tells us
 *     what's currently displayed; availability tells us what the
 *     workspace's *intended* default is.
 *
 * Callers should treat `availability === undefined` as "loading" and
 * defer rendering disabled-state tooltips until it lands. Returning
 * `null` here would force every consumer to write the same loading
 * branch; instead we surface a "discuss-only, no reasons" placeholder
 * resolution so the switcher can paint a usable surface on first paint
 * and reconcile once the query resolves.
 */
export function useChatMode(workspaceId: WorkspaceId | null) {
  const location = useLocation();
  const params = useParams<{ workspaceId?: string; threadId?: string; artifactId?: string }>();
  const availability = useQuery(api.workspaceModeEligibility.evaluate, workspaceId ? { workspaceId } : "skip");

  const mode = useMemo<ChatMode | null>(() => {
    // The URL prefix tells us which mode is mounted. We match the path
    // segment after the workspace id; query params (`?ask=1`, `?open=…`)
    // do not change the service-mode bucket.
    //
    // Non-canonical URLs (`/chat`, `/w/:wid` workspace landing, and the
    // legacy `/w/:wid/t/:tid` thread URL) return `null`: they are
    // transient stops on the canonicalisation chain and have no settled
    // mode of their own. The workspace shell consults `availability` for
    // its redirect target; chrome consumers gate on a non-null mode so
    // the StatusPill / ArtifactPanel only paint once the URL settles.
    const path = location.pathname;
    if (!params.workspaceId) {
      return null;
    }
    const prefix = `/w/${params.workspaceId}`;
    if (path.startsWith(`${prefix}/discuss`)) {
      return "discuss";
    }
    if (path.startsWith(`${prefix}/library`)) {
      return "library";
    }
    return null;
  }, [location.pathname, params.workspaceId]);

  return {
    mode,
    /**
     * `undefined` while the workspace query loads. Consumers that need a
     * never-undefined value can fall back to {@link NULL_RESOLUTION}.
     */
    availability,
    /** Stable placeholder so first-paint code paths can avoid a null check. */
    placeholderAvailability: NULL_RESOLUTION,
  };
}
