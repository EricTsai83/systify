// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RepolessAgentProfileBar } from "./repoless-agent-profile-bar";

afterEach(() => {
  cleanup();
});

describe("RepolessAgentProfileBar", () => {
  test("renders Agent Profile button without advertising Single-turn by default", () => {
    render(
      <RepolessAgentProfileBar
        value={{ singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        resetPending={false}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-agent-profile-button")).toBeInTheDocument();
    expect(screen.queryByText("Single-turn on")).not.toBeInTheDocument();
  });

  test("shows Single-turn toggle inside the Agent Profile dialog", () => {
    render(
      <RepolessAgentProfileBar
        value={{ singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        resetPending={false}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("repoless-agent-profile-button"));

    expect(screen.getByTestId("repoless-single-turn-toggle")).toBeInTheDocument();
  });

  test("saves Agent Profile edits from the dialog", async () => {
    const onSave = vi.fn();
    render(
      <RepolessAgentProfileBar
        value={{ singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        resetPending={false}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId("repoless-agent-profile-button"));
    fireEvent.change(screen.getByLabelText("Agent role"), { target: { value: "Translation agent" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Translate Chinese into English." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        singleTurnEnabled: false,
        agentRole: "Translation agent",
        agentInstructions: "Translate Chinese into English.",
      });
    });
  });

  test("shows clearing state and disables Single-turn toggle while reset is pending", () => {
    render(
      <RepolessAgentProfileBar
        value={{ singleTurnEnabled: true, agentRole: "Translation agent", agentInstructions: "" }}
        resetPending={true}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("Clearing previous messages...")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("repoless-agent-profile-button"));
    expect(screen.getByTestId("repoless-single-turn-toggle")).toBeDisabled();
  });
});
