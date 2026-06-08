import { useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export type ViewerAccess = NonNullable<ReturnType<typeof useViewerAccess>>;
export type ViewerFeatureName = keyof ViewerAccess["features"];

const ensuredOwnerTokenIdentifiers = new Set<string>();
const ensuringOwnerTokenIdentifiers = new Set<string>();

export function useViewerAccess(options: { enabled?: boolean } = {}) {
  const viewerAccess = useQuery(api.viewerAccess.getSelf, options.enabled === false ? "skip" : {});
  const ensureSelf = useMutation(api.viewerAccess.ensureSelf);

  useEffect(() => {
    if (options.enabled === false || viewerAccess === undefined) {
      return;
    }
    const ownerTokenIdentifier = viewerAccess.ownerTokenIdentifier;
    if (
      ensuredOwnerTokenIdentifiers.has(ownerTokenIdentifier) ||
      ensuringOwnerTokenIdentifiers.has(ownerTokenIdentifier)
    ) {
      return;
    }
    ensuringOwnerTokenIdentifiers.add(ownerTokenIdentifier);
    void ensureSelf({})
      .then(() => {
        ensuredOwnerTokenIdentifiers.add(ownerTokenIdentifier);
      })
      .catch(() => {
        ensuredOwnerTokenIdentifiers.delete(ownerTokenIdentifier);
      })
      .finally(() => {
        ensuringOwnerTokenIdentifiers.delete(ownerTokenIdentifier);
      });
  }, [ensureSelf, options.enabled, viewerAccess]);

  return viewerAccess;
}

export function isDemoMode(viewerAccess: ViewerAccess | undefined): boolean {
  if (viewerAccess === undefined) {
    return false;
  }
  if (viewerAccess.plan === "internal") {
    return false;
  }
  if (viewerAccess.plan === "free") {
    return true;
  }

  // isDemoMode is feature-driven for paid/trial plans: COST_FEATURE_NAMES must all be enabled on viewerAccess.features.
  return COST_FEATURE_NAMES.some((feature) => viewerAccess.features?.[feature]?.enabled !== true);
}

export function isViewerFeatureEnabled(viewerAccess: ViewerAccess | undefined, feature: ViewerFeatureName): boolean {
  return viewerAccess?.features[feature]?.enabled === true;
}

const COST_FEATURE_NAMES = [
  "repoImport",
  "syncRepository",
  "checkForUpdates",
  "chatSend",
  "libraryAsk",
  "generateSystemDesign",
  "sandboxGrounding",
  "artifactIndexing",
  "premiumModels",
  "highReasoning",
] as const satisfies readonly ViewerFeatureName[];
