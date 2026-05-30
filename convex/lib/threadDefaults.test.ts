/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { isDefaultTitle, NEW_THREAD_DEFAULT_TITLE } from "./threadDefaults";

function makeThreadWithTitle(title: string): Doc<"threads"> {
  // Only `title` is exercised by `isDefaultTitle`; the rest of the shape is
  // padded with the minimum required to satisfy the Doc type without
  // standing up a full convex-test harness.
  return {
    _id: "threads:test" as unknown as Doc<"threads">["_id"],
    _creationTime: 0,
    ownerTokenIdentifier: "user|test",
    title,
    mode: "discuss",
    lastMessageAt: 0,
  } as Doc<"threads">;
}

describe("isDefaultTitle", () => {
  test("returns true for the canonical default literal", () => {
    expect(isDefaultTitle(makeThreadWithTitle(NEW_THREAD_DEFAULT_TITLE))).toBe(true);
  });

  test("returns false for a manually renamed title", () => {
    expect(isDefaultTitle(makeThreadWithTitle("My thread"))).toBe(false);
  });

  test("returns false for an autogen-renamed title (any non-default value)", () => {
    expect(isDefaultTitle(makeThreadWithTitle("Auth Flow Overview"))).toBe(false);
  });

  test("is strict equality — extra whitespace counts as renamed", () => {
    expect(isDefaultTitle(makeThreadWithTitle(`${NEW_THREAD_DEFAULT_TITLE} `))).toBe(false);
    expect(isDefaultTitle(makeThreadWithTitle("new chat"))).toBe(false);
  });
});
