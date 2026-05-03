import "@testing-library/jest-dom/vitest";

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
const globalScope = globalThis as unknown as { ResizeObserver?: unknown };
if (typeof globalScope.ResizeObserver === "undefined") {
  globalScope.ResizeObserver = ResizeObserverStub;
}
