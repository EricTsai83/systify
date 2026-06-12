// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RepolessChatTypeToggle, RepolessSingleTurnToggle } from "./repoless-agent-profile-bar";

afterEach(() => {
  cleanup();
});

describe("RepolessChatTypeToggle", () => {
  test("renders Chat with the regular chat icon and switches to Agent", async () => {
    const onSave = vi.fn();
    render(
      <RepolessChatTypeToggle
        value={{ agentEnabled: false, singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        onSave={onSave}
      />,
    );

    const toggle = screen.getByTestId("repoless-chat-type-toggle");
    expect(toggle).toHaveTextContent("Chat");
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

  test("renders Agent with a distinct icon and switches to Chat", async () => {
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
    expect(screen.getByTestId("repoless-agent-profile-button")).toHaveTextContent("Edit profile");

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

  test("shows Create profile as an Agent-mode child action when no profile exists", () => {
    render(
      <RepolessChatTypeToggle
        value={{ agentEnabled: true, singleTurnEnabled: false, agentRole: "", agentInstructions: "" }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-chat-type-toggle")).toHaveTextContent("Agent");
    expect(screen.getByTestId("repoless-agent-profile-button")).toHaveTextContent("Create profile");
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

  test("does not include Chat type controls inside the Agent Profile dialog", () => {
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
    expect(screen.queryByRole("radio", { name: "Regular chat" })).not.toBeInTheDocument();
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

  test("renders the current chat history mode as icon and text", () => {
    const { rerender } = render(
      <RepolessSingleTurnToggle
        value={{ agentEnabled: true, singleTurnEnabled: false, agentRole: "Translation agent", agentInstructions: "" }}
        resetPending={false}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("repoless-single-turn-toggle")).toHaveTextContent("Conversation");

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
