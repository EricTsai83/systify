// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { openEditorUrl, writeLocalEditorConfig } from "@/lib/local-editor";
import type { ArtifactId, RepositoryId, RepositorySource } from "@/lib/types";
import { MessageBubble } from "./chat-message";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
}));

vi.mock("@/lib/local-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-editor")>();
  return {
    ...actual,
    openEditorUrl: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.mocked(useQuery).mockReset();
  vi.mocked(useQuery).mockReturnValue([]);
  vi.mocked(openEditorUrl).mockReset();
});

function makeAssistantMessage(overrides: Partial<Doc<"messages">> = {}): Doc<"messages"> {
  return {
    _creationTime: 1,
    _id: "message_1" as Doc<"messages">["_id"],
    content: "Reply content",
    mode: "discuss",
    ownerTokenIdentifier: "owner",
    role: "assistant",
    status: "completed",
    threadId: "thread_1" as Doc<"messages">["threadId"],
    ...overrides,
  };
}

describe("MessageBubble", () => {
  test("does not render a Library badge for Library-mode assistant replies", () => {
    render(
      <MessageBubble
        message={makeAssistantMessage({
          mode: "library",
        })}
        activeMessageStream={null}
      />,
    );

    expect(screen.getByText("Reply content")).toBeInTheDocument();
    expect(screen.queryByTestId("message-grounding-badge")).not.toBeInTheDocument();
  });

  test("renders an error-only failed reply as a system alert without duplicating the message", () => {
    const errorMessage =
      "This reply stopped before it could finish. Try sending your message again. If it keeps happening, choose another model or check the provider configuration.";
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: errorMessage,
          errorMessage,
          status: "failed",
        })}
        activeMessageStream={null}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Reply could not finish")).toBeInTheDocument();
    expect(screen.getAllByText(errorMessage)).toHaveLength(1);
  });

  test("keeps a system alert when failed content contains useful partial output", () => {
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "Partial answer before the provider failed.",
          errorMessage: "Provider request failed.",
          status: "failed",
        })}
        activeMessageStream={null}
      />,
    );

    expect(screen.getByText("Partial answer before the provider failed.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Reply could not finish")).toBeInTheDocument();
    expect(screen.getByText("Provider request failed.")).toBeInTheDocument();
  });

  test("renders Sources for artifact citations and opens the Library Reader callback", () => {
    const onSelectArtifact = vi.fn();
    const artifactId = "artifact_alpha" as ArtifactId;

    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "The overview covers it [A1].",
          citationMap: [
            {
              index: 1,
              artifactId,
              artifactTitle: "README Summary",
              artifactKind: "readme_summary",
              artifactVersion: 2,
            },
          ],
        })}
        activeMessageStream={null}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Library documents")).toBeInTheDocument();
    expect(screen.getByText("README Summary")).toBeInTheDocument();
    expect(screen.getAllByText("[A1]").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /README Summary/i }));
    expect(onSelectArtifact).toHaveBeenCalledWith(artifactId);
  });

  test("renders Sources for code file citations", () => {
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "The parser is implemented in [src/components/chat-message.tsx:190-205].",
          groundSandbox: true,
        })}
        activeMessageStream={null}
        repositorySource={repositorySource()}
      />,
    );

    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Code files")).toBeInTheDocument();
    expect(screen.getByText("chat-message.tsx")).toBeInTheDocument();
    expect(screen.getByText("src/components/chat-message.tsx")).toBeInTheDocument();
    expect(screen.getByText("190-205")).toBeInTheDocument();
  });

  test("does not render code file sources for replies that were not sandbox-grounded", () => {
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "The parser is implemented in [src/components/chat-message.tsx:190-205].",
          groundSandbox: false,
        })}
        activeMessageStream={null}
        repositorySource={repositorySource()}
      />,
    );

    expect(screen.queryByText("Sources")).not.toBeInTheDocument();
    expect(screen.queryByText("Code files")).not.toBeInTheDocument();
    expect(screen.queryByText("chat-message.tsx")).not.toBeInTheDocument();
  });

  test("renders both Library documents and Code files sections", () => {
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "Compare [A1] with [src/lib/source-citations.ts:12].",
          groundSandbox: true,
          citationMap: [
            {
              index: 1,
              artifactId: "artifact_alpha" as ArtifactId,
              artifactTitle: "Architecture Overview",
              headingPath: ["Architecture", "Data Model"],
            },
          ],
        })}
        activeMessageStream={null}
        repositorySource={repositorySource()}
      />,
    );

    expect(screen.getByText("Library documents")).toBeInTheDocument();
    expect(screen.getByText("Code files")).toBeInTheDocument();
    expect(screen.getByText("Architecture > Data Model")).toBeInTheDocument();
    expect(screen.getByText("source-citations.ts")).toBeInTheDocument();
  });

  test("opens a configured local editor from the code source actions", async () => {
    const source = repositorySource();
    writeLocalEditorConfig(source.repositoryId, {
      editor: "cursor",
      rootPath: "/Users/eric/personal-project/systify",
      updatedAt: 1790000000000,
    });

    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "See [src/components/chat-message.tsx:190].",
          groundSandbox: true,
        })}
        activeMessageStream={null}
        repositorySource={source}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /chat-message.tsx/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Open locally/i }));

    expect(openEditorUrl).toHaveBeenCalledWith(
      "cursor://file//Users/eric/personal-project/systify/src/components/chat-message.tsx:190",
    );
  });

  test("prefills and can forget a configured local editor path", async () => {
    const source = repositorySource();
    writeLocalEditorConfig(source.repositoryId, {
      editor: "vscode",
      rootPath: "/Users/eric/personal-project/systify",
      updatedAt: 1790000000000,
    });

    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "See [src/components/chat-message.tsx:190].",
          groundSandbox: true,
        })}
        activeMessageStream={null}
        repositorySource={source}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /chat-message.tsx/i }));
    expect(await screen.findByRole("button", { name: /Change local path/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Change local path/i }));
    expect(await screen.findByLabelText("Local repository path")).toHaveValue("/Users/eric/personal-project/systify");

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /chat-message.tsx/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Forget local path/i }));

    expect(screen.queryByRole("button", { name: /Open locally/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set local path/i })).toBeInTheDocument();
  });

  test("shows code source actions and setup flow when no local editor is configured", async () => {
    const source = repositorySource();

    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "See [src/components/chat-message.tsx:190].",
          groundSandbox: true,
        })}
        activeMessageStream={null}
        repositorySource={source}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /chat-message.tsx/i }));

    expect(await screen.findByRole("button", { name: /Set local path/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open on GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy path/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Set local path/i }));
    fireEvent.change(await screen.findByLabelText("Local repository path"), {
      target: { value: "/Users/eric/personal-project/systify" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save and open/i }));

    await waitFor(() => {
      expect(openEditorUrl).toHaveBeenCalledWith(
        "cursor://file//Users/eric/personal-project/systify/src/components/chat-message.tsx:190",
      );
    });
  });

  test("uses a fallback label for legacy citation maps without title snapshots", () => {
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "Legacy citation [A1].",
          citationMap: [{ index: 1, artifactId: "artifact_legacy" as ArtifactId }],
        })}
        activeMessageStream={null}
      />,
    );

    expect(screen.getByText("Referenced artifact")).toBeInTheDocument();
  });
});

function repositorySource(): RepositorySource {
  return {
    repositoryId: "repo_1" as RepositoryId,
    sourceRepoFullName: "acme/systify",
    defaultBranch: "main",
    lastSyncedCommitSha: "abc123",
  };
}
