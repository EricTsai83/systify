// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
}));

import { useGitHubConnection } from "./use-github-connection";

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("useGitHubConnection", () => {
  test("exposes suspended installation state", () => {
    useQueryMock.mockReturnValue({
      isConnected: false,
      installationId: 123,
      accountLogin: "acme",
      repositorySelection: "selected",
      installationStatus: "suspended",
    });

    const { result } = renderHook(() => useGitHubConnection());

    expect(result.current).toMatchObject({
      isLoading: false,
      isConnected: false,
      installationId: 123,
      accountLogin: "acme",
      repositorySelection: "selected",
      installationStatus: "suspended",
      isSuspended: true,
    });
  });
});
