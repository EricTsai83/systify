import { useMemo } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { RepositoryModeDisabledReasonCode } from "../../convex/lib/chatEligibility";
import { resolveRepositoryLandingMode } from "@/lib/repository-landing";
import type { ChatMode, RepositoryId } from "@/lib/types";

/**
 * Per-axis verdict shape consumed by chrome that subscribes to
 * `repositoryModeEligibility.evaluate`. `code` is the backend enum union
 * plus a `"loading"` sentinel for the placeholder fallback.
 */
interface ChatModeDisabledLike {
  enabled: false;
  code: RepositoryModeDisabledReasonCode | "loading";
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
 * Pick the mode to render when the URL doesn't pin one:
 *   URL → repository's `lastMode` (if still enabled) → backend default → "discuss".
 *
 * Lives here so every consumer agrees byte-for-byte. The repository shell and
 * the left sidebar used to diverge — the sidebar fell straight to
 * `defaultMode`, producing a Discuss→Library flip on return navigation while
 * `availability` was still loading.
 */
export function resolveEffectiveChatMode(args: {
  mode: ChatMode | null;
  lastMode: ChatMode | null | undefined;
  availability:
    | {
        modes: { discuss: { enabled: boolean }; library: { enabled: boolean } };
        defaultMode: ChatMode;
      }
    | null
    | undefined;
}): ChatMode {
  return resolveRepositoryLandingMode(args);
}

/**
 * Bridge between the repository URL and the service-mode resolver.
 *
 * Returns:
 *   - `mode` — the mode the URL is currently rendering, or `null` if the
 *     URL is a transient / non-canonical one (`/chat`, `/r/:rid`).
 *   - `availability` — the resolver output keyed by service mode.
 */
export function useChatMode(repositoryId: RepositoryId | null) {
  const location = useLocation();
  const params = useParams<{ repositoryId?: string; threadId?: string; artifactId?: string }>();
  const availability = useQuery(api.repositoryModeEligibility.evaluate, { repositoryId: repositoryId ?? undefined });

  const mode = useMemo<ChatMode | null>(() => {
    const path = location.pathname;
    if (!params.repositoryId) {
      return null;
    }
    const prefix = `/r/${params.repositoryId}`;
    if (path.startsWith(`${prefix}/discuss`)) {
      return "discuss";
    }
    if (path.startsWith(`${prefix}/library`)) {
      return "library";
    }
    return null;
  }, [location.pathname, params.repositoryId]);

  return {
    mode,
    /**
     * `undefined` while the repository query loads. Consumers that need a
     * never-undefined value can fall back to {@link NULL_RESOLUTION}.
     */
    availability,
    /** Stable placeholder so first-paint code paths can avoid a null check. */
    placeholderAvailability: NULL_RESOLUTION,
  };
}
