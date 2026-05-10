import { useParams } from "react-router-dom";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ArtifactReader } from "@/components/artifact-reader";
import { ScreenState } from "@/components/screen-state";
import type { ArtifactId, WorkspaceId } from "@/lib/types";

/**
 * `/w/:workspaceId/a/:artifactId` route. Wraps the {@link ArtifactReader}
 * surface in the same `SidebarProvider` chrome the chat route uses so the
 * top-level layout stays uniform between Reader and Chat. The Reader
 * itself does the data loading; this page only validates URL params.
 *
 * If either id is missing the URL is malformed (route matched but param
 * extraction failed) — show the recoverable not-found surface so the user
 * can navigate back instead of seeing a blank screen.
 */
export function ArtifactReaderPage() {
  const params = useParams<{ workspaceId?: string; artifactId?: string }>();
  const workspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const artifactId = (params.artifactId ?? null) as ArtifactId | null;

  if (!workspaceId || !artifactId) {
    return (
      <ScreenState
        title="Missing artifact"
        description="The link is missing a workspace or artifact id. Return to your workspace to continue."
      />
    );
  }

  return (
    <SidebarProvider>
      <div className="flex h-full min-h-0 w-full">
        <ArtifactReader workspaceId={workspaceId} artifactId={artifactId} />
      </div>
    </SidebarProvider>
  );
}
