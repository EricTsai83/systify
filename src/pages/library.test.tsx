// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { LibraryLiveSourceBadge } from "./library";

describe("LibraryLiveSourceBadge", () => {
  test("shows code access active when sandbox activity is ready", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "ready",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(screen.getByLabelText("Repository code access is active")).toHaveTextContent("Code access active");
  });

  test("shows code access starting while setup is in flight", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "preparing",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(screen.getByLabelText("Repository code access is starting")).toHaveTextContent("Code access starting");
  });

  test("shows code access idle for idle status", () => {
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
      screen.getByLabelText("Repository code access starts when a task needs current repository files."),
    ).toHaveTextContent("Code access idle");
  });
});
