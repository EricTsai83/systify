import { describe, expect, test } from "vitest";
import {
  discussPath,
  isProtectedReturnTo,
  libraryPath,
  modeAwareThreadPath,
  withLibraryAskParam,
  workspacelessThreadPath,
} from "@/route-paths";
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

describe("workspacelessThreadPath", () => {
  test("builds the canonical `/chat/:threadId` URL", () => {
    expect(workspacelessThreadPath(TID)).toBe(`/chat/${TID}`);
  });
});

describe("isProtectedReturnTo", () => {
  test("accepts the workspaceless chat landing", () => {
    expect(isProtectedReturnTo("/chat")).toBe(true);
  });

  test("accepts the workspaceless thread URL via the new segment", () => {
    expect(isProtectedReturnTo(workspacelessThreadPath(TID))).toBe(true);
  });

  test("accepts the canonical workspace landing", () => {
    expect(isProtectedReturnTo(`/w/${WID}`)).toBe(true);
  });

  test("rejects unknown paths", () => {
    expect(isProtectedReturnTo("/marketing")).toBe(false);
  });
});
