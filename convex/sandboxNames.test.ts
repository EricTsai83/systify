import { describe, expect, test } from "vitest";
import { buildSandboxName } from "./lib/sandboxNames";

describe("buildSandboxName", () => {
  test("keeps colliding repository keys distinct", () => {
    const first = buildSandboxName({
      repositoryKey: `acme/${"a".repeat(60)}`,
      repositoryId: "repoAlpha123",
    });
    const second = buildSandboxName({
      repositoryKey: `acme/${"a".repeat(59)}b`,
      repositoryId: "repoBeta456",
    });

    expect(first).not.toBe(second);
    expect(first).toContain("-repoalpha123");
    expect(second).toContain("-repobeta456");
  });

  test("keeps sandbox names readable and within the Daytona length budget", () => {
    const name = buildSandboxName({
      repositoryKey: "Foo/Bar.Baz",
      repositoryId: "Repo_ABC123",
    });

    expect(name).toBe("architect-foo-bar-baz-repo-abc123");
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("uses sandbox row id when provided so syncs do not reuse the published sandbox name", () => {
    const first = buildSandboxName({
      repositoryKey: "Foo/Bar",
      repositoryId: "repo123",
      sandboxId: "sandboxAlpha",
    });
    const second = buildSandboxName({
      repositoryKey: "Foo/Bar",
      repositoryId: "repo123",
      sandboxId: "sandboxBeta",
    });

    expect(first).not.toBe(second);
    expect(first).toContain("-sandboxalpha");
    expect(second).toContain("-sandboxbeta");
  });
});
