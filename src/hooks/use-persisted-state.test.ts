// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useLocalStorageBoolean, useLocalStorageEnum } from "./use-persisted-state";
import { createStorageEvent } from "@/test-utils/storage";

describe("useLocalStorageBoolean", () => {
  describe("initialization behavior", () => {
    test("synchronously reads an existing stored value on first render", () => {
      window.localStorage.setItem("systify.test.flag", "false");

      const { result } = renderHook(() => useLocalStorageBoolean("systify.test.flag", true));

      // No `waitFor` — the lazy `useState` initializer reads the stored
      // value during the first render, so the very first observed value is
      // already the persisted one. Regression guard for the prior async
      // `isHydrated` two-render path.
      expect(result.current[0]).toBe(false);
    });

    test("uses defaultValue when nothing is stored", () => {
      const { result } = renderHook(() => useLocalStorageBoolean("systify.test.flag", true));

      expect(result.current[0]).toBe(true);
    });

    test("re-reads when the key changes mid-mount", () => {
      window.localStorage.setItem("systify.test.first", "true");
      window.localStorage.setItem("systify.test.second", "false");

      const { result, rerender } = renderHook(({ key }) => useLocalStorageBoolean(key, true), {
        initialProps: { key: "systify.test.first" },
      });

      expect(result.current[0]).toBe(true);

      rerender({ key: "systify.test.second" });

      expect(result.current[0]).toBe(false);
      // Documents the expected final value. Note that on its own this is a
      // weak guard for the stale-write bug: the bad write self-heals one
      // render later when the write effect re-runs with the synced value,
      // so the file always lands on "false" by the end of `rerender`. The
      // dedicated spy-based test below is the real regression guard.
      expect(window.localStorage.getItem("systify.test.second")).toBe("false");
    });

    test("does not write the previous value to a newly switched key", async () => {
      // Regression guard for a stale write during a mid-mount `key` swap:
      // the key-change effect queues a `setValue` for the new key's stored
      // value, but the write effect in the same commit still closes over
      // the previous render's `value` and would persist it to the new key.
      // The corruption self-heals locally one render later, but a `storage`
      // event for the bad write still propagates to other tabs — so we
      // assert directly on `writeString` rather than the post-rerender
      // file value.
      const storage = await import("@/lib/storage");
      window.localStorage.setItem("systify.test.first", "true");
      window.localStorage.setItem("systify.test.second", "false");

      const writeSpy = vi.spyOn(storage, "writeString");

      const { rerender } = renderHook(({ key }) => useLocalStorageBoolean(key, true), {
        initialProps: { key: "systify.test.first" },
      });
      writeSpy.mockClear();

      rerender({ key: "systify.test.second" });

      const writesToSecond = writeSpy.mock.calls.filter((call) => call[0] === "systify.test.second");
      writeSpy.mockRestore();

      expect(writesToSecond).toEqual([]);
    });

    test("does not write to storage when lazy-init falls back to defaultValue", () => {
      // Regression guard for storage pollution: a fresh mount whose lazy
      // init resolved to `defaultValue` because storage was empty must NOT
      // populate localStorage with that default. The orphan-GC sweep cannot
      // distinguish such entries from intentional choices, so they would
      // accumulate one per (key, default) the user ever rendered — most
      // visibly the per-folder open state in the folder navigator.
      renderHook(() => useLocalStorageBoolean("systify.test.flag", true));
      expect(window.localStorage.getItem("systify.test.flag")).toBeNull();
    });
  });

  describe("persistence behavior", () => {
    test("writes value updates back to localStorage", () => {
      const { result } = renderHook(() => useLocalStorageBoolean("systify.test.flag", true));

      act(() => {
        result.current[1](false);
      });

      expect(window.localStorage.getItem("systify.test.flag")).toBe("false");
      expect(result.current[0]).toBe(false);
    });

    test("follows a changing defaultValue while no stored value exists", () => {
      // Because the hook does not persist a value that matches the default
      // against an empty storage slot, swapping `defaultValue` for an
      // untouched key flows through to the visible value. Once the user
      // commits a choice (next test), the stored value wins.
      const { result, rerender } = renderHook(
        ({ defaultValue }) => useLocalStorageBoolean("systify.test.flag", defaultValue),
        { initialProps: { defaultValue: true } },
      );
      expect(result.current[0]).toBe(true);
      expect(window.localStorage.getItem("systify.test.flag")).toBeNull();

      rerender({ defaultValue: false });
      expect(result.current[0]).toBe(false);
      expect(window.localStorage.getItem("systify.test.flag")).toBeNull();
    });

    test("locks against changing defaultValue once a value is explicitly set", () => {
      const { result, rerender } = renderHook(
        ({ defaultValue }) => useLocalStorageBoolean("systify.test.flag", defaultValue),
        { initialProps: { defaultValue: true } },
      );

      act(() => {
        result.current[1](false);
      });
      expect(window.localStorage.getItem("systify.test.flag")).toBe("false");

      rerender({ defaultValue: true });
      // Explicit user choice wins over a later default flip.
      expect(result.current[0]).toBe(false);
    });

    test("accepts an updater function for setState-style usage", () => {
      window.localStorage.setItem("systify.test.flag", "true");
      const { result } = renderHook(() => useLocalStorageBoolean("systify.test.flag", true));

      act(() => {
        result.current[1]((prev) => !prev);
      });

      expect(result.current[0]).toBe(false);
      expect(window.localStorage.getItem("systify.test.flag")).toBe("false");
    });

    test("falls back to in-memory state when localStorage throws", () => {
      const getItemSpy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });

      try {
        const { result } = renderHook(() => useLocalStorageBoolean("systify.test.flag", true));

        // Read throws → fall back to defaultValue.
        expect(result.current[0]).toBe(true);

        act(() => {
          result.current[1](false);
        });

        // Write throws → in-memory state still updates.
        expect(result.current[0]).toBe(false);
      } finally {
        getItemSpy.mockRestore();
        setItemSpy.mockRestore();
      }
    });
  });

  describe("cross-tab synchronization behavior", () => {
    test("syncs value when same key changes in another tab", () => {
      window.localStorage.setItem("systify.test.flag", "true");
      const { result } = renderHook(() => useLocalStorageBoolean("systify.test.flag", false));

      expect(result.current[0]).toBe(true);

      act(() => {
        window.dispatchEvent(createStorageEvent("systify.test.flag", "false"));
      });

      expect(result.current[0]).toBe(false);
    });

    test("falls back to default when same key is removed in another tab", () => {
      window.localStorage.setItem("systify.test.flag", "false");
      const { result } = renderHook(() => useLocalStorageBoolean("systify.test.flag", true));

      expect(result.current[0]).toBe(false);

      act(() => {
        window.dispatchEvent(createStorageEvent("systify.test.flag", null));
      });

      expect(result.current[0]).toBe(true);
    });
  });
});

// A fixed enum domain reused across the useLocalStorageEnum tests.
const SIZES = ["small", "normal", "large"] as const;

describe("useLocalStorageEnum", () => {
  describe("initialization behavior", () => {
    test("synchronously reads an existing stored value on first render", () => {
      window.localStorage.setItem("systify.test.size", "large");

      const { result } = renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      expect(result.current[0]).toBe("large");
    });

    test("uses defaultValue when nothing is stored", () => {
      const { result } = renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      expect(result.current[0]).toBe("normal");
    });

    test("falls back to defaultValue when the stored value is outside the allowed set", () => {
      // Schema drift: an older build wrote a member this build dropped, or
      // the entry was hand-edited. Treated as a cache miss, not a crash.
      window.localStorage.setItem("systify.test.size", "gigantic");

      const { result } = renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      expect(result.current[0]).toBe("normal");
    });

    test("does not write to storage when lazy-init falls back to defaultValue", () => {
      // Same storage-pollution guard as the boolean hook: a fresh mount must
      // not persist the default into an empty slot.
      renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      expect(window.localStorage.getItem("systify.test.size")).toBeNull();
    });
  });

  describe("persistence behavior", () => {
    test("writes value updates back to localStorage", () => {
      const { result } = renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      act(() => {
        result.current[1]("large");
      });

      expect(window.localStorage.getItem("systify.test.size")).toBe("large");
      expect(result.current[0]).toBe("large");
    });

    test("accepts an updater function for setState-style usage", () => {
      window.localStorage.setItem("systify.test.size", "small");
      const { result } = renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      act(() => {
        result.current[1]((prev) => (prev === "small" ? "large" : "small"));
      });

      expect(result.current[0]).toBe("large");
      expect(window.localStorage.getItem("systify.test.size")).toBe("large");
    });
  });

  describe("cross-tab synchronization behavior", () => {
    test("syncs value when the same key changes in another tab", () => {
      window.localStorage.setItem("systify.test.size", "small");
      const { result } = renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      expect(result.current[0]).toBe("small");

      act(() => {
        window.dispatchEvent(createStorageEvent("systify.test.size", "large"));
      });

      expect(result.current[0]).toBe("large");
    });

    test("falls back to defaultValue when another tab writes a value outside the allowed set", () => {
      window.localStorage.setItem("systify.test.size", "large");
      const { result } = renderHook(() => useLocalStorageEnum("systify.test.size", SIZES, "normal"));

      expect(result.current[0]).toBe("large");

      act(() => {
        window.dispatchEvent(createStorageEvent("systify.test.size", "gigantic"));
      });

      expect(result.current[0]).toBe("normal");
    });
  });
});
