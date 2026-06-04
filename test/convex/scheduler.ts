import { vi } from "vitest";
import type { SystifyTestConvex } from "./harness";

type SchedulableTestConvex = Pick<SystifyTestConvex, "finishAllScheduledFunctions">;

export async function withPausedConvexScheduler<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    return await run();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

export async function drainConvexScheduler(t: SchedulableTestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}
