// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TopBar } from "@/components/top-bar";
import { SidebarProvider } from "@/components/ui/sidebar";

afterEach(() => {
  cleanup();
});

describe("TopBar", () => {
  test("uses the shared SidebarTrigger for repository Discuss sidebar toggling", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <TopBar
            repoDetail={undefined}
            isRepoDetailLoading={false}
            threadId={null}
            attachedRepository={null}
            availableRepositories={[]}
            isSyncing={false}
            isStatusPanelOpen={false}
            onSetStatusPanelOpen={vi.fn()}
            onArchiveRepo={vi.fn()}
            onRestoreRepo={vi.fn()}
            onPermanentDeleteRepo={vi.fn()}
            onThreadMovedToRepository={vi.fn()}
            isDesktopLayout={false}
            onSearchThreads={vi.fn()}
            onNewThread={vi.fn()}
            onSync={vi.fn()}
            onViewArtifact={vi.fn()}
            showSystemStatus={false}
          />
        </SidebarProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Toggle left sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search threads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
  });
});
