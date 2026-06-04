import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

/**
 * `ResizeObserver` no-op polyfill for the JSDOM-backed component tests
 * (`// @vitest-environment jsdom` headers in *.test.tsx files). JSDOM
 * doesn't implement it, but Radix UI's `<ScrollArea>` calls
 * `new ResizeObserver(...)` on mount as soon as the scrollbar is visible
 * — which is the case any time we render the chat panel under
 * `type="always"`. Without this stub, every test that mounts ChatPanel
 * (or anything else nesting a visible ScrollArea) crashes with
 * "ResizeObserver is not defined" before assertions can run.
 *
 * The stub is intentionally inert: tests that actually need to react to
 * size changes should override this with a richer mock at the test
 * level. The Convex/edge-runtime tests don't touch the DOM, so the
 * shared install here is harmless for them.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Cast through `unknown` so this file doesn't depend on the DOM lib
// (vitest.setup.ts is type-checked under tsconfig.node.json, which only
// pulls in ES2023). `globalThis.ResizeObserver` exists at runtime in
// JSDOM-or-better environments — we only assign it when missing.
const globalScope = globalThis as unknown as {
  ResizeObserver?: unknown;
  document?: unknown;
  window?: {
    localStorage?: {
      clear?: () => void;
    };
    sessionStorage?: {
      clear?: () => void;
    };
  };
};
if (typeof globalScope.ResizeObserver === "undefined") {
  globalScope.ResizeObserver = ResizeObserverStub;
}

/**
 * `matchMedia` no-op polyfill for the JSDOM-backed component tests. JSDOM
 * doesn't implement it, but `SidebarProvider` (mounted in `ProtectedLayout`
 * so it survives route transitions) and `useIsMobile` both call it on mount
 * to read the current breakpoint. Without this stub, every test that
 * renders a protected route — including the page-mocked App routing tests —
 * crashes before assertions can run.
 *
 * The stub always reports "does not match" so tests default to the desktop
 * layout; tests that need a specific breakpoint should override
 * `window.matchMedia` at the test level.
 */
const hasDocument = typeof globalScope.document !== "undefined";

const windowScope = globalScope as unknown as {
  window?: { matchMedia?: (query: string) => unknown };
};
if (hasDocument && typeof windowScope.window !== "undefined" && typeof windowScope.window.matchMedia !== "function") {
  windowScope.window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * In-memory `Storage` polyfill for JSDOM. The shipped implementation in this
 * runner is partial (notably missing `clear()`), so any test that touches a
 * storage-backed code path needs a working `Storage` swapped in. Tests that
 * want a richer mock (e.g. to spy on `setItem`) can still override the
 * property at the test level.
 *
 * Mirrors `src/test-utils/storage.ts`'s `createMemoryStorage()`, but
 * duplicated here because `vitest.setup.ts` is type-checked under the
 * DOM-less node project — importing the DOM-typed helper would force the
 * node tsconfig to include DOM lib.
 */
type AnyStorage = {
  length: number;
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
};

function createMemoryStorage(): AnyStorage {
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
  };
}

// Only patch when running in a JSDOM-like environment. Edge-runtime exposes
// `window.localStorage` / `window.sessionStorage` getters in recent Node
// versions, but reading either without `--localstorage-file=<path>` emits a
// warning. DOM tests are the only ones that need browser storage, so gate this
// on `document` and replace storage without first reading the getter.
if (hasDocument && typeof globalScope.window !== "undefined") {
  const win = globalScope.window as unknown as {
    localStorage: AnyStorage;
    sessionStorage: AnyStorage;
  };
  Object.defineProperty(win, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
  Object.defineProperty(win, "sessionStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
  beforeEach(() => {
    try {
      win.localStorage.clear();
    } catch {
      // Test may have spied on `clear()`; let the test own its own teardown.
    }
    try {
      win.sessionStorage.clear();
    } catch {
      // Same.
    }
  });
}
