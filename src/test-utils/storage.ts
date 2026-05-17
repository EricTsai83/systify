/**
 * Shared `localStorage` / `sessionStorage` mocks for component / hook tests.
 *
 * The JSDOM-backed test runner ships only a partial `localStorage` (notably
 * missing `clear()`), so any test that exercises a storage-backed code path
 * needs to swap in a memory-backed `Storage` before assertions. `vitest.setup.ts`
 * installs the mocks once per test process; individual tests just call
 * `clearAllStorage()` in their `beforeEach` (or skip cleanup entirely if they
 * don't write).
 */

export function createMemoryStorage(): Storage {
  const backing = new Map<string, string>();
  return {
    get length() {
      return backing.size;
    },
    clear: () => {
      backing.clear();
    },
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, String(value));
    },
  } satisfies Storage;
}

function isUsableStorage(storage: Storage | undefined): boolean {
  if (!storage || typeof storage.clear !== "function") return false;
  try {
    storage.clear();
    return true;
  } catch {
    return false;
  }
}

export function installMockStorages(): void {
  // Only patch when the runtime ships an incomplete `Storage` — JSDOM in some
  // configurations exposes a real implementation. Patching a working storage
  // would lose state between calls within the same test.
  if (!isUsableStorage(window.localStorage)) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  }
  if (!isUsableStorage(window.sessionStorage)) {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  }
}

export function clearAllStorage(): void {
  try {
    window.localStorage.clear();
  } catch {
    // Mock or real storage may throw if the test has spied on the implementation.
  }
  try {
    window.sessionStorage.clear();
  } catch {
    // Same.
  }
}

/**
 * Build a synthetic `StorageEvent` for cross-tab sync tests. The constructor
 * `new StorageEvent("storage", { ... })` does not exist in every JSDOM
 * version, so we hand-roll the relevant fields onto a base `Event`.
 */
export function createStorageEvent(key: string, newValue: string | null): StorageEvent {
  const event = new Event("storage") as StorageEvent;
  Object.defineProperties(event, {
    key: { value: key },
    newValue: { value: newValue },
    storageArea: { value: window.localStorage },
  });
  return event;
}
