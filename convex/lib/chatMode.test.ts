import { describe, expect, test } from "vitest";
import { resolveDiscussGrounding } from "./chatMode";

describe("resolveDiscussGrounding", () => {
  test("discuss mode passes truthy flags through", () => {
    expect(resolveDiscussGrounding("discuss", { groundLibrary: true, groundSandbox: true })).toEqual({
      groundLibrary: true,
      groundSandbox: true,
    });
  });

  test("discuss mode coerces missing or falsy flags to false", () => {
    expect(resolveDiscussGrounding("discuss", { groundLibrary: undefined, groundSandbox: undefined })).toEqual({
      groundLibrary: false,
      groundSandbox: false,
    });
    expect(resolveDiscussGrounding("discuss", { groundLibrary: false, groundSandbox: false })).toEqual({
      groundLibrary: false,
      groundSandbox: false,
    });
    expect(resolveDiscussGrounding("discuss", undefined)).toEqual({
      groundLibrary: false,
      groundSandbox: false,
    });
  });

  test("library mode forces both grounding axes to false", () => {
    expect(resolveDiscussGrounding("library", { groundLibrary: true, groundSandbox: true })).toEqual({
      groundLibrary: false,
      groundSandbox: false,
    });
  });

  test("undefined mode (legacy / pre-mode rows) collapses to false", () => {
    expect(resolveDiscussGrounding(undefined, { groundLibrary: true, groundSandbox: true })).toEqual({
      groundLibrary: false,
      groundSandbox: false,
    });
  });
});
