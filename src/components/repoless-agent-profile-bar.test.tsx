// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RepolessAgentProfileBar, RepolessSingleTurnToggle } from "./repoless-agent-profile-bar";

afterEach(() => {
  cleanup();
});

describe("RepolessAgentProfileBar", () => {
  test("renders Agent button without advertising Single-turn by default", () => {
    render(
      <RepolessAgentProfileBar
        value={{ agentEnabled: false, singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-agent-profile-button")).toBeInTheDocument();
    expect(screen.queryByText("Single-turn on")).not.toBeInTheDocument();
  });

  test("does not show Single-turn controls inside the Agent dialog", () => {
    render(
      <RepolessAgentProfileBar
        value={{ agentEnabled: false, singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("repoless-agent-profile-button"));

    expect(screen.queryByTestId("repoless-single-turn-toggle")).not.toBeInTheDocument();
  });

  test("does not show the Agent name on the header button", () => {
    render(
      <RepolessAgentProfileBar
        value={{ agentEnabled: true, singleTurnEnabled: false, agentRole: "Translation agent", agentInstructions: "" }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-agent-profile-button")).toHaveTextContent("Agent");
    expect(screen.getByTestId("repoless-agent-profile-button")).not.toHaveClass("text-foreground");
    expect(screen.getByTestId("repoless-agent-profile-button")).not.toHaveTextContent("Configured");
    expect(screen.getByTestId("repoless-agent-profile-button")).not.toHaveTextContent("Profile");
    expect(screen.queryByText("Translation agent")).not.toBeInTheDocument();
  });

  test("saves Agent Profile edits from the dialog", async () => {
    const onSave = vi.fn();
    render(
      <RepolessAgentProfileBar
        value={{ agentEnabled: true, singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId("repoless-agent-profile-button"));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Translation agent" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Translate Chinese into English." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        agentEnabled: true,
        singleTurnEnabled: false,
        agentRole: "Translation agent",
        agentInstructions: "Translate Chinese into English.",
      });
    });
  });

  test("does not show Single-turn state on the Agent button", () => {
    render(
      <RepolessAgentProfileBar
        value={{ agentEnabled: true, singleTurnEnabled: true, agentRole: "Translation agent", agentInstructions: "" }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-agent-profile-button")).not.toHaveTextContent("Single-turn");
  });

  test("can switch an Agent chat to Regular from the dialog", async () => {
    const onSave = vi.fn();
    render(
      <RepolessAgentProfileBar
        value={{
          agentEnabled: true,
          singleTurnEnabled: false,
          agentRole: "Translation agent",
          agentInstructions: "Translate Chinese into English.",
        }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId("repoless-agent-profile-button"));
    fireEvent.click(screen.getByRole("radio", { name: "Regular chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        agentEnabled: false,
        singleTurnEnabled: false,
        agentRole: "Translation agent",
        agentInstructions: "Translate Chinese into English.",
      });
    });
  });
});

describe("RepolessSingleTurnToggle", () => {
  test("toggles Single-turn with one click", async () => {
    const onSave = vi.fn();
    render(
      <RepolessSingleTurnToggle
        value={{ agentEnabled: true, singleTurnEnabled: false, agentRole: "Translation agent", agentInstructions: "" }}
        resetPending={false}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId("repoless-single-turn-toggle"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        agentEnabled: true,
        singleTurnEnabled: true,
        agentRole: "Translation agent",
        agentInstructions: "",
      });
    });
  });

  test("shows clearing state and disables Single-turn toggle while reset is pending", () => {
    render(
      <RepolessSingleTurnToggle
        value={{ agentEnabled: true, singleTurnEnabled: true, agentRole: "Translation agent", agentInstructions: "" }}
        resetPending={true}
        onSave={vi.fn()}
      />,
    );

    const toggle = screen.getByTestId("repoless-single-turn-toggle");
    expect(toggle).toHaveAccessibleName("Single-turn is clearing previous messages");
    expect(toggle).not.toHaveAttribute("title");
    expect(toggle).toBeDisabled();
  });
});
