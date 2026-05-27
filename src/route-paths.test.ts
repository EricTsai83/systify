import { describe, expect, test } from "vitest";
import {
  discussPath,
  isProtectedReturnTo,
  libraryPath,
  modeAwareThreadPath,
  repolessThreadPath,
  withLibraryAskParam,
} from "@/route-paths";
import type { RepositoryId, ThreadId } from "@/lib/types";

const RID = "repo_test" as RepositoryId;
const TID = "th_test" as ThreadId;

describe("modeAwareThreadPath", () => {
  test("discuss threads route to the Discuss shell URL", () => {
    expect(modeAwareThreadPath(RID, TID, "discuss")).toBe(discussPath(RID, TID));
  });

  test("library threads route to the Library shell URL with ?ask=:tid", () => {
    expect(modeAwareThreadPath(RID, TID, "library")).toBe(withLibraryAskParam(libraryPath(RID), TID));
  });
});

describe("repolessThreadPath", () => {
  test("builds the canonical `/chat/:threadId` URL", () => {
    expect(repolessThreadPath(TID)).toBe(`/chat/${TID}`);
  });
});

describe("isProtectedReturnTo", () => {
  test("accepts the repoless chat landing", () => {
    expect(isProtectedReturnTo("/chat")).toBe(true);
  });

  test("accepts the repoless thread URL via the new segment", () => {
    expect(isProtectedReturnTo(repolessThreadPath(TID))).toBe(true);
  });

  test("accepts the canonical repository landing", () => {
    expect(isProtectedReturnTo(`/r/${RID}`)).toBe(true);
  });

  test("rejects unknown paths", () => {
    expect(isProtectedReturnTo("/marketing")).toBe(false);
  });
});
