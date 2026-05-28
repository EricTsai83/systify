import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { computeFreshness, hasImportSnapshotDrift, toArtifactMetadataView, toArtifactView } from "./artifactView";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeArtifact(overrides: Partial<Doc<"artifacts">> = {}): Doc<"artifacts"> {
  return {
    _id: "k0000000000" as Doc<"artifacts">["_id"],
    _creationTime: 0,
    ownerTokenIdentifier: "user|fixture",
    kind: "architecture_diagram",
    title: "Sample",
    summary: "Sample summary",
    contentMarkdown: "# Sample",
    version: 1,
    ...overrides,
  } as Doc<"artifacts">;
}

describe("computeFreshness", () => {
  test("unverified when lastVerifiedAt is missing", () => {
    expect(computeFreshness({ lastVerifiedAt: undefined, now: 0 })).toBe("unverified");
  });

  test("fresh inside the aging window", () => {
    const now = 100 * DAY_MS;
    expect(computeFreshness({ lastVerifiedAt: now - 1 * DAY_MS, now })).toBe("fresh");
    expect(computeFreshness({ lastVerifiedAt: now - 7 * DAY_MS, now })).toBe("fresh");
  });

  test("aging between the fresh and stale thresholds", () => {
    const now = 100 * DAY_MS;
    expect(computeFreshness({ lastVerifiedAt: now - 10 * DAY_MS, now })).toBe("aging");
    expect(computeFreshness({ lastVerifiedAt: now - 30 * DAY_MS, now })).toBe("aging");
  });

  test("stale past the stale threshold", () => {
    const now = 100 * DAY_MS;
    expect(computeFreshness({ lastVerifiedAt: now - 31 * DAY_MS, now })).toBe("stale");
    expect(computeFreshness({ lastVerifiedAt: 0, now })).toBe("stale");
  });

  test("clamps negative ages to fresh (future verification timestamps)", () => {
    const now = 100 * DAY_MS;
    expect(computeFreshness({ lastVerifiedAt: now + 1 * DAY_MS, now })).toBe("fresh");
  });
});

describe("hasImportSnapshotDrift", () => {
  test("false when artifact has no anchored SHA", () => {
    expect(hasImportSnapshotDrift(makeArtifact({ alignedImportCommitSha: undefined }), "abc")).toBe(false);
  });

  test("false when latest SHA is unknown", () => {
    expect(hasImportSnapshotDrift(makeArtifact({ alignedImportCommitSha: "abc" }), undefined)).toBe(false);
  });

  test("false when SHAs match", () => {
    expect(hasImportSnapshotDrift(makeArtifact({ alignedImportCommitSha: "abc" }), "abc")).toBe(false);
  });

  test("true when anchored SHA differs from latest", () => {
    expect(hasImportSnapshotDrift(makeArtifact({ alignedImportCommitSha: "abc" }), "def")).toBe(true);
  });
});

describe("toArtifactView", () => {
  test("returns the full row with computed freshness", () => {
    const artifact = makeArtifact({ contentMarkdown: "body" });
    const view = toArtifactView(artifact, { now: 100 * DAY_MS });
    expect(view._id).toBe(artifact._id);
    expect(view.contentMarkdown).toBe("body");
    expect(view.freshness).toBe("unverified");
    expect("importDriftFromLatestSync" in view).toBe(false);
  });

  test("attaches importDriftFromLatestSync only when drift fires", () => {
    const drifted = makeArtifact({ alignedImportCommitSha: "abc" });
    const aligned = makeArtifact({ alignedImportCommitSha: "abc" });

    const driftedView = toArtifactView(drifted, { now: 0, latestImportSha: "def" });
    expect(driftedView.importDriftFromLatestSync).toBe(true);

    const alignedView = toArtifactView(aligned, { now: 0, latestImportSha: "abc" });
    expect("importDriftFromLatestSync" in alignedView).toBe(false);
  });
});

describe("toArtifactMetadataView", () => {
  test("omits contentMarkdown but keeps the navigator fields", () => {
    const artifact = makeArtifact({ contentMarkdown: "should-not-appear" });
    const metadata = toArtifactMetadataView(artifact, { now: 0 });
    expect("contentMarkdown" in metadata).toBe(false);
    expect(metadata.title).toBe(artifact.title);
    expect(metadata.summary).toBe(artifact.summary);
    expect(metadata.kind).toBe(artifact.kind);
    expect(metadata.freshness).toBe("unverified");
  });

  test("derives freshness from lastVerifiedAt", () => {
    const now = 100 * DAY_MS;
    const verifiedToday = makeArtifact({ lastVerifiedAt: now });
    const verifiedLongAgo = makeArtifact({ lastVerifiedAt: 0 });

    expect(toArtifactMetadataView(verifiedToday, { now }).freshness).toBe("fresh");
    expect(toArtifactMetadataView(verifiedLongAgo, { now }).freshness).toBe("stale");
  });
});
