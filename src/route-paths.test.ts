import { describe, expect, test } from "vitest";
import { discussPath, libraryPath, modeAwareThreadPath, withLibraryAskParam } from "@/route-paths";
import type { ThreadId, WorkspaceId } from "@/lib/types";

const WID = "ws_test" as WorkspaceId;
const TID = "th_test" as ThreadId;

describe("modeAwareThreadPath", () => {
  test("discuss threads route to the Discuss shell URL", () => {
    expect(modeAwareThreadPath(WID, TID, "discuss")).toBe(discussPath(WID, TID));
  });

  test("library threads route to the Library shell URL with ?ask=:tid", () => {
    expect(modeAwareThreadPath(WID, TID, "library")).toBe(withLibraryAskParam(libraryPath(WID), TID));
  });
});
