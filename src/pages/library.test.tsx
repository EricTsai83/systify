// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { LibraryLiveSourceBadge } from "./library";

describe("LibraryLiveSourceBadge", () => {
  test("shows live source active when sandbox activity is ready", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "ready",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(screen.getByLabelText("Live source is active")).toHaveTextContent("Live source active");
  });

  test("shows live source starting while activation is in flight", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "activating",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(screen.getByLabelText("Live source is being prepared")).toHaveTextContent("Live source starting");
  });

  test("shows live source inactive for idle status", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "idle",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(
      screen.getByLabelText(
        "Live source is inactive. Enable Sandbox grounding from Discuss when you need live code state.",
      ),
    ).toHaveTextContent("Live source inactive");
  });
});
