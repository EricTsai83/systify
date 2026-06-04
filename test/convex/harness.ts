/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";

const modules = import.meta.glob("/convex/**/*.ts");

export function createTestConvex() {
  return convexTest(schema, modules);
}

export function createRateLimitedTestConvex() {
  const t = createTestConvex();
  registerRateLimiter(t);
  return t;
}

export type SystifyTestConvex = ReturnType<typeof createTestConvex>;
