// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { updateCustomizationMock, useMutationMock, useQueryMock } = vi.hoisted(() => ({
  updateCustomizationMock: vi.fn(),
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
}));

import { USER_PREFERENCES_STORAGE_KEY, type UserPreferences, useUserPreferences } from "./use-user-preferences";

type ViewerPreferencesValue = {
  lastActiveRepositoryId: null;
  lastActiveRepositoryUpdatedAt: null;
  traits: string[];
  customInstructions: string;
  customizationUpdatedAt: number | null;
} | null;

const DEFAULT_VIEWER_PREFERENCES: ViewerPreferencesValue = {
  lastActiveRepositoryId: null,
  lastActiveRepositoryUpdatedAt: null,
  traits: [],
  customInstructions: "",
  customizationUpdatedAt: null,
};

function makeViewerPreferences(preferences: UserPreferences, customizationUpdatedAt: number): ViewerPreferencesValue {
  return {
    lastActiveRepositoryId: null,
    lastActiveRepositoryUpdatedAt: null,
    traits: preferences.traits,
    customInstructions: preferences.customInstructions,
    customizationUpdatedAt,
  };
}

function readStoredPreferences(): unknown {
  const raw = window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useUserPreferences", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useMutationMock.mockReset();
    updateCustomizationMock.mockReset();
    useMutationMock.mockReturnValue(updateCustomizationMock);
    window.localStorage.removeItem(USER_PREFERENCES_STORAGE_KEY);
  });

  afterEach(() => {
    window.localStorage.removeItem(USER_PREFERENCES_STORAGE_KEY);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("preserves cached customization and retries migration after a transient failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cached: UserPreferences = {
      traits: ["Direct"],
      customInstructions: "Prefer explicit failure modes.",
    };
    const viewerPreferences: ViewerPreferencesValue = null;
    window.localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify(cached));
    useQueryMock.mockImplementation(() => viewerPreferences);
    updateCustomizationMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useUserPreferences());

    expect(result.current[0]).toEqual(cached);
    await flushMicrotasks();

    expect(updateCustomizationMock).toHaveBeenCalledTimes(1);
    expect(updateCustomizationMock).toHaveBeenLastCalledWith(cached);
    expect(result.current[0]).toEqual(cached);
    expect(readStoredPreferences()).toEqual(cached);

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(updateCustomizationMock).toHaveBeenCalledTimes(2);
    expect(updateCustomizationMock).toHaveBeenLastCalledWith(cached);
  });

  test("retries failed saves without letting stale server state overwrite local edits", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const localEdit: UserPreferences = {
      traits: ["Pragmatic"],
      customInstructions: "Prefer concise trade-offs.",
    };
    let viewerPreferences: ViewerPreferencesValue = DEFAULT_VIEWER_PREFERENCES;
    useQueryMock.mockImplementation(() => viewerPreferences);
    updateCustomizationMock.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(undefined);

    const { result, rerender } = renderHook(() => useUserPreferences());

    act(() => {
      result.current[1](localEdit);
    });
    expect(result.current[0]).toEqual(localEdit);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(updateCustomizationMock).toHaveBeenCalledTimes(1);
    expect(updateCustomizationMock).toHaveBeenLastCalledWith(localEdit);
    expect(result.current[0]).toEqual(localEdit);
    expect(readStoredPreferences()).toEqual(localEdit);

    rerender();
    expect(result.current[0]).toEqual(localEdit);

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(updateCustomizationMock).toHaveBeenCalledTimes(2);
    expect(updateCustomizationMock).toHaveBeenLastCalledWith(localEdit);

    rerender();
    expect(result.current[0]).toEqual(localEdit);
    expect(readStoredPreferences()).toEqual(localEdit);

    viewerPreferences = makeViewerPreferences(localEdit, 123);
    rerender();

    expect(result.current[0]).toEqual(localEdit);
  });
});
