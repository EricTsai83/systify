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
  return (
    viewerAccess?.plan === "free" ||
    (viewerAccess?.features?.demoMode.enabled === true && viewerAccess.features.chatSend.enabled !== true)
  );
}

export function isViewerFeatureEnabled(viewerAccess: ViewerAccess | undefined, feature: ViewerFeatureName): boolean {
  return viewerAccess?.features[feature]?.enabled === true;
}
