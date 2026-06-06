import { describe, expect, test } from "vitest";
import { toUserErrorMessage } from "./errors";

describe("toUserErrorMessage", () => {
  test("prefers structured ConvexError data messages", () => {
    const error = Object.assign(new Error("ConvexError"), {
      data: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many chat requests. Please retry later.",
      },
    });

    expect(toUserErrorMessage(error, "Fallback message.")).toBe("Too many chat requests. Please retry later.");
  });

  test("parses JSON-encoded ConvexError data messages", () => {
    const error = Object.assign(new Error("ConvexError"), {
      data: JSON.stringify({
        code: "RATE_LIMIT_EXCEEDED",
        message: "Chat capacity is temporarily full. Please retry later.",
      }),
    });

    expect(toUserErrorMessage(error, "Fallback message.")).toBe(
      "Chat capacity is temporarily full. Please retry later.",
    );
  });

  test("falls back to error.message and then the provided fallback", () => {
    expect(toUserErrorMessage(new Error("Plain error message."), "Fallback message.")).toBe("Plain error message.");
    expect(toUserErrorMessage({ data: { message: "   " } }, "Fallback message.")).toBe("Fallback message.");
  });

  test("renders usage-budget errors with Settings Usage copy and reset date", () => {
    const error = Object.assign(new Error("ConvexError"), {
      data: {
        code: "USER_USAGE_BUDGET_EXCEEDED",
        message: "Backend message should not win.",
        periodEndMs: Date.UTC(2026, 5, 15, 16, 0, 0),
      },
    });

    const message = toUserErrorMessage(error, "Fallback message.");
    expect(message).toContain("Usage budget reached for the current cycle.");
    expect(message).toContain("Settings → Usage");
    expect(message).toContain("Resets");
  });
});
