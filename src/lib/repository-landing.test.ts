import { describe, expect, test } from "vitest";
import {
  resolveRepositoryLandingDecision,
  resolveRepositoryLandingMode,
  type RepositoryLandingAvailability,
} from "./repository-landing";
import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";

const repo = (id: string) => id as RepositoryId;
const thread = (id: string) => id as ThreadId;

const availability = (args?: { libraryEnabled?: boolean; defaultMode?: ChatMode }): RepositoryLandingAvailability => ({
  modes: {
    discuss: { enabled: true },
    library: { enabled: args?.libraryEnabled ?? true },
  },
  defaultMode: args?.defaultMode ?? "discuss",
});

describe("resolveRepositoryLandingMode", () => {
  test("URL mode wins over repository preference and backend default", () => {
    expect(
      resolveRepositoryLandingMode({
        mode: "discuss",
        lastMode: "library",
        availability: availability({ defaultMode: "library" }),
      }),
    ).toBe("discuss");
  });

  test("last mode is used only while still enabled", () => {
    expect(
      resolveRepositoryLandingMode({
        mode: null,
        lastMode: "library",
        availability: availability({ libraryEnabled: true, defaultMode: "discuss" }),
      }),
    ).toBe("library");

    expect(
      resolveRepositoryLandingMode({
        mode: null,
        lastMode: "library",
        availability: availability({ libraryEnabled: false, defaultMode: "discuss" }),
      }),
    ).toBe("discuss");
  });
});

describe("resolveRepositoryLandingDecision", () => {
  test("Library landing preserves the selected Ask thread in the query string", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "library",
        mode: null,
        availability: availability(),
        repositoriesLoaded: true,
        ownerThreads: [{ _id: thread("ask1") }],
      }),
    ).toEqual({
      status: "redirecting",
      intendedChatMode: "library",
      navigation: { to: "/r/repo1/library?ask=ask1", replace: true },
    });
  });

  test("Discuss landing selects the first owner thread when one exists", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: "discuss",
        availability: availability(),
        repositoriesLoaded: true,
        ownerThreads: [{ _id: thread("tid1") }],
      }),
    ).toEqual({
      status: "redirecting",
      intendedChatMode: "discuss",
      navigation: { to: "/r/repo1/discuss/tid1", replace: true },
    });
  });

  test("new-thread intent keeps Discuss on the empty route even when owner threads exist", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: "discuss",
        availability: availability(),
        repositoriesLoaded: true,
        ownerThreads: [{ _id: thread("tid1") }],
        suppressThreadAutoOpen: true,
      }),
    ).toEqual({
      status: "ready",
      intendedChatMode: "discuss",
      navigation: null,
    });
  });

  test("new-thread intent does not wait for owner thread loading", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: "discuss",
        availability: undefined,
        repositoriesLoaded: false,
        ownerThreads: undefined,
        suppressThreadAutoOpen: true,
      }),
    ).toEqual({
      status: "ready",
      intendedChatMode: "discuss",
      navigation: null,
    });
  });

  test("bare repository URL repairs to Discuss when there is no owner thread", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: null,
        availability: availability(),
        repositoriesLoaded: true,
        ownerThreads: [],
      }),
    ).toEqual({
      status: "redirecting",
      intendedChatMode: "discuss",
      navigation: { to: "/r/repo1/discuss", replace: true },
    });
  });

  test("canonical empty Discuss route is ready when no owner thread exists", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: "discuss",
        availability: availability(),
        repositoriesLoaded: true,
        ownerThreads: [],
      }),
    ).toEqual({
      status: "ready",
      intendedChatMode: "discuss",
      navigation: null,
    });
  });

  test("landing waits until availability, repositories, and owner threads have loaded", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: null,
        availability: undefined,
        repositoriesLoaded: true,
        ownerThreads: [],
      }),
    ).toEqual({
      status: "loading",
      intendedChatMode: "discuss",
      navigation: null,
    });

    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: null,
        availability: availability(),
        repositoriesLoaded: false,
        ownerThreads: [],
      }),
    ).toEqual({
      status: "loading",
      intendedChatMode: "discuss",
      navigation: null,
    });

    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: null,
        intendedChatMode: "discuss",
        mode: null,
        availability: availability(),
        repositoriesLoaded: true,
        ownerThreads: undefined,
      }),
    ).toEqual({
      status: "loading",
      intendedChatMode: "discuss",
      navigation: null,
    });
  });

  test("pinned thread URLs do not run landing repair", () => {
    expect(
      resolveRepositoryLandingDecision({
        urlRepositoryId: repo("repo1"),
        urlThreadId: thread("tid1"),
        intendedChatMode: "discuss",
        mode: "discuss",
        availability: undefined,
        repositoriesLoaded: false,
        ownerThreads: undefined,
      }),
    ).toEqual({
      status: "ready",
      intendedChatMode: "discuss",
      navigation: null,
    });
  });
});
