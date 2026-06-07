import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export type ViewerAccess = NonNullable<ReturnType<typeof useViewerAccess>>;
export type ViewerFeatureName = keyof ViewerAccess["features"];

export function useViewerAccess(options: { enabled?: boolean } = {}) {
  const viewerAccess = useQuery(api.viewerAccess.getSelf, options.enabled === false ? "skip" : {});
  const ensureSelf = useMutation(api.viewerAccess.ensureSelf);
  const ensuredOwnerRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      options.enabled === false ||
      viewerAccess === undefined ||
      ensuredOwnerRef.current === viewerAccess.ownerTokenIdentifier
    ) {
      return;
    }
    const ownerTokenIdentifier = viewerAccess.ownerTokenIdentifier;
    ensuredOwnerRef.current = ownerTokenIdentifier;
    void ensureSelf({}).catch(() => {
      if (ensuredOwnerRef.current === ownerTokenIdentifier) {
        ensuredOwnerRef.current = null;
      }
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
