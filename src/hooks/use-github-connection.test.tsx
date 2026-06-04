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
  test("exposes active installation state", () => {
    useQueryMock.mockReturnValue({
      isConnected: true,
      installationId: 123,
      accountLogin: "acme",
      repositorySelection: "selected",
      installationStatus: "active",
    });

    const { result } = renderHook(() => useGitHubConnection());

    expect(result.current).toMatchObject({
      isLoading: false,
      isConnected: true,
      installationStatus: "active",
      isSuspended: false,
    });
  });

  test("reports loading while the connection query is unresolved", () => {
    useQueryMock.mockReturnValue(undefined);

    const { result } = renderHook(() => useGitHubConnection());

    expect(result.current).toMatchObject({
      isLoading: true,
      isConnected: false,
      isSuspended: false,
    });
  });

  test("exposes disconnected installation state", () => {
    useQueryMock.mockReturnValue({
      isConnected: false,
      installationId: null,
      accountLogin: null,
      repositorySelection: null,
      installationStatus: null,
    });

    const { result } = renderHook(() => useGitHubConnection());

    expect(result.current).toMatchObject({
      isLoading: false,
      isConnected: false,
      installationStatus: null,
      isSuspended: false,
    });
  });

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
