// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SandboxActivityPill } from "./sandbox-activity-pill";
import type { RepositoryId } from "@/lib/types";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
}));

const repositoryId = "repo_1" as RepositoryId;

afterEach(() => {
  cleanup();
  vi.mocked(useQuery).mockReset();
});

describe("SandboxActivityPill", () => {
  test("idle state is passive and does not render Activate", () => {
    vi.mocked(useQuery).mockReturnValue({ kind: "idle", activeJob: null, sandbox: null });

    render(<SandboxActivityPill repositoryId={repositoryId} />);

    expect(screen.getByText("Live source will prepare on send")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /activate/i })).not.toBeInTheDocument();
  });

  test("preparing state renders without an active job", () => {
    vi.mocked(useQuery).mockReturnValue({
      kind: "preparing",
      activeJob: null,
      sandbox: { ttlExpiresAt: Date.now() + 60_000 },
    });

    render(<SandboxActivityPill repositoryId={repositoryId} />);

    expect(screen.getByText("Preparing live source…")).toBeInTheDocument();
  });
});
