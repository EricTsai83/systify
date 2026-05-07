// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { hasWorkOSSessionHint } from "./auth-session-hint";

afterEach(() => {
  // jsdom keeps cookies on `document` across tests; expire each by name so
  // a stale "workos-has-session" from one case doesn't leak into the next.
  for (const cookie of document.cookie.split(";")) {
    const eq = cookie.indexOf("=");
    const name = (eq === -1 ? cookie : cookie.slice(0, eq)).trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
});

describe("hasWorkOSSessionHint", () => {
  test("returns false when no cookies are set", () => {
    expect(hasWorkOSSessionHint()).toBe(false);
  });

  test("returns true when the cookie holds a clientId value", () => {
    document.cookie = "workos-has-session=client_xyz";
    expect(hasWorkOSSessionHint()).toBe(true);
  });

  test("returns true for the legacy '1' value", () => {
    document.cookie = "workos-has-session=1";
    expect(hasWorkOSSessionHint()).toBe(true);
  });

  test("returns true for dot-separated client IDs", () => {
    document.cookie = "workos-has-session=client_a.client_b";
    expect(hasWorkOSSessionHint()).toBe(true);
  });

  test("returns false when the cookie value is empty", () => {
    // A cleared session looks like `workos-has-session=` until the browser
    // expires it — treat empty values as no hint to avoid a false positive
    // loading screen immediately after sign-out.
    document.cookie = "workos-has-session=";
    expect(hasWorkOSSessionHint()).toBe(false);
  });

  test("ignores unrelated cookies", () => {
    document.cookie = "some-other-cookie=value";
    expect(hasWorkOSSessionHint()).toBe(false);
  });

  test("matches even when other cookies precede it", () => {
    document.cookie = "first=a";
    document.cookie = "workos-has-session=client_xyz";
    expect(hasWorkOSSessionHint()).toBe(true);
  });
});
