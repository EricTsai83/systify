import { describe, expect, test } from "vitest";
import { discussPath, labPath, libraryPath, modeAwareThreadPath, withLibraryAskParam } from "@/route-paths";
import type { ThreadId, WorkspaceId } from "@/lib/types";

const WID = "ws_test" as WorkspaceId;
const TID = "th_test" as ThreadId;

describe("modeAwareThreadPath", () => {
  test("discuss threads route to the Discuss shell URL", () => {
    expect(modeAwareThreadPath(WID, TID, "discuss")).toBe(discussPath(WID, TID));
  });

  test("library threads route to the Library shell URL with ?ask=:tid", () => {
    // Critical contract: Library Ask threads (and the repo-attached default
    // thread, which also persists as `mode: "library"`) must land in the
    // Library shell, not the Discuss shell. Routing them to Discuss would
    // paint a mode-mismatched chrome (sidebar filters by URL mode, workspace
    // switcher highlights the wrong button) and silently break the
    // "library mode = library shell" invariant.
    expect(modeAwareThreadPath(WID, TID, "library")).toBe(withLibraryAskParam(libraryPath(WID), TID));
  });

  test("lab threads route to the Lab shell URL", () => {
    expect(modeAwareThreadPath(WID, TID, "lab")).toBe(labPath(WID, TID));
  });
});
