// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RepolessChatTypeToggle, RepolessSingleTurnToggle } from "./repoless-agent-profile-bar";
import { getRepolessChatTypeTooltip, getRepolessSingleTurnTooltip } from "./repoless-agent-profile-copy";

afterEach(() => {
  cleanup();
});

describe("RepolessChatTypeToggle", () => {
  test("uses state-specific chat type tooltip copy", () => {
    expect(getRepolessChatTypeTooltip({ isAgent: false })).toBe(
      "Conversation mode replies directly without an agent profile.",
    );
    expect(getRepolessChatTypeTooltip({ isAgent: true })).toBe(
      "Agent mode follows the saved agent profile for this repoless chat.",
    );
  });

  test("renders Conversation with the conversation icon and switches to Agent", async () => {
    const onSave = vi.fn();
    render(
      <RepolessChatTypeToggle
        value={{ agentEnabled: false, singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        onSave={onSave}
      />,
    );

    const toggle = screen.getByTestId("repoless-chat-type-toggle");
    expect(toggle).toHaveTextContent("Conversation");
    expect(toggle.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByTestId("repoless-agent-profile-button")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        agentEnabled: true,
        singleTurnEnabled: false,
        agentRole: "",
        agentInstructions: "",
      });
    });
  });

  test("renders Agent with a distinct icon and switches to Conversation", async () => {
    const onSave = vi.fn();
    render(
      <RepolessChatTypeToggle
        value={{
          agentEnabled: true,
          singleTurnEnabled: false,
          agentRole: "Translation agent",
          agentInstructions: "Translate Chinese into English.",
        }}
        onSave={onSave}
      />,
    );

    const toggle = screen.getByTestId("repoless-chat-type-toggle");
    expect(toggle).toHaveTextContent("Agent");
    expect(toggle.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByTestId("repoless-agent-profile-button")).toHaveAccessibleName("Edit Agent settings");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        agentEnabled: false,
        singleTurnEnabled: false,
        agentRole: "Translation agent",
        agentInstructions: "Translate Chinese into English.",
      });
    });
  });

  test("shows an Agent settings action when no profile exists", () => {
    render(
      <RepolessChatTypeToggle
        value={{ agentEnabled: true, singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-chat-type-toggle")).toHaveTextContent("Agent");
    expect(screen.getByTestId("repoless-agent-profile-button")).toHaveAccessibleName("Set up Agent");
    expect(screen.getByTestId("repoless-agent-profile-button")).toHaveAttribute("aria-invalid", "true");
  });

  test("saves Agent Profile edits from the Agent-mode child action", async () => {
    const onSave = vi.fn();
    render(
      <RepolessChatTypeToggle
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

  test("does not show Single-turn state on the Agent mode control", () => {
    render(
      <RepolessChatTypeToggle
        value={{ agentEnabled: true, singleTurnEnabled: true, agentRole: "Translation agent", agentInstructions: "" }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-chat-type-toggle")).not.toHaveTextContent("Single-turn");
    expect(screen.getByTestId("repoless-agent-profile-button")).not.toHaveTextContent("Single-turn");
  });

  test("does not include chat type controls inside the Agent Profile dialog", () => {
    render(
      <RepolessChatTypeToggle
        value={{
          agentEnabled: true,
          singleTurnEnabled: false,
          agentRole: "Translation agent",
          agentInstructions: "Translate Chinese into English.",
        }}
        onSave={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("repoless-agent-profile-button"));

    expect(screen.queryByText("Chat type")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Conversation" })).not.toBeInTheDocument();
  });
});

describe("RepolessSingleTurnToggle", () => {
  test("uses state-specific tooltip copy", () => {
    expect(getRepolessSingleTurnTooltip({ isOn: false, resetPending: false })).toBe(
      "Threaded replies include earlier messages from this thread.",
    );
    expect(getRepolessSingleTurnTooltip({ isOn: true, resetPending: false })).toBe(
      "Single reply uses only the latest prompt, without earlier thread messages.",
    );
    expect(getRepolessSingleTurnTooltip({ isOn: true, resetPending: true })).toBe(
      "Clearing previous messages before the next single reply starts.",
    );
  });

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

  test("renders the current chat history mode label", () => {
    const { rerender } = render(
      <RepolessSingleTurnToggle
        value={{ agentEnabled: true, singleTurnEnabled: false, agentRole: "Translation agent", agentInstructions: "" }}
        resetPending={false}
        onSave={vi.fn()}
      />,
    );

    const conversationToggle = screen.getByTestId("repoless-single-turn-toggle");
    expect(conversationToggle).toHaveAccessibleName("Switch to Single reply mode");
    expect(conversationToggle).toHaveTextContent("Threaded");
    expect(conversationToggle.querySelector("svg")).toBeInTheDocument();

    rerender(
      <RepolessSingleTurnToggle
        value={{ agentEnabled: true, singleTurnEnabled: true, agentRole: "Translation agent", agentInstructions: "" }}
        resetPending={false}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-single-turn-toggle")).toHaveTextContent("Single reply");
    expect(screen.getByTestId("repoless-single-turn-toggle").className).not.toContain("text-primary");
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
    expect(toggle).toHaveAccessibleName("Single reply is clearing previous messages");
    expect(toggle).not.toHaveAttribute("title");
    expect(toggle).toBeDisabled();
  });
});
