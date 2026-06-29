// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CopyActionButton } from "@/components/ui/copy-action-button";

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

describe("CopyActionButton", () => {
  test("renders icon-only mode with the idle aria label", () => {
    render(<CopyActionButton text="copy me" idleAriaLabel="Copy sample" />);

    expect(screen.getByRole("button", { name: "Copy sample" })).toBeInTheDocument();
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
  });

  test("calls navigator.clipboard.writeText with the provided string", async () => {
    const writeText = installClipboard();

    render(<CopyActionButton text="copy me" idleAriaLabel="Copy sample" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy sample" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("copy me");
    });
  });

  test("supports text as a function", async () => {
    const writeText = installClipboard();

    render(<CopyActionButton text={() => "computed text"} idleAriaLabel="Copy computed text" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy computed text" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("computed text");
    });
  });

  test("switches to the copied aria label after successful copy", async () => {
    installClipboard();

    render(
      <CopyActionButton
        text="copy me"
        idleAriaLabel="Copy sample"
        copiedAriaLabel="Sample copied"
        copiedLabel="Done"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy sample" }));

    expect(await screen.findByRole("button", { name: "Sample copied" })).toBeInTheDocument();
  });

  test("resets copied state after resetAfterMs", async () => {
    vi.useFakeTimers();
    installClipboard();

    render(
      <CopyActionButton
        text="copy me"
        idleAriaLabel="Copy sample"
        copiedAriaLabel="Sample copied"
        resetAfterMs={75}
        tooltip={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy sample" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Sample copied" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(75);
    });

    expect(screen.getByRole("button", { name: "Copy sample" })).toBeInTheDocument();
  });

  test("calls onCopied on success", async () => {
    installClipboard();
    const onCopied = vi.fn();

    render(<CopyActionButton text="copy me" idleAriaLabel="Copy sample" onCopied={onCopied} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy sample" }));

    await waitFor(() => {
      expect(onCopied).toHaveBeenCalledTimes(1);
    });
  });

  test("calls onCopyFailed when clipboard is unavailable", async () => {
    const onCopyFailed = vi.fn();

    render(<CopyActionButton text="copy me" idleAriaLabel="Copy sample" onCopyFailed={onCopyFailed} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy sample" }));

    await waitFor(() => {
      expect(onCopyFailed).toHaveBeenCalledTimes(1);
    });
  });

  test("does not attempt copy when text is empty, null, or undefined", () => {
    const writeText = installClipboard();
    const onCopyFailed = vi.fn();

    render(
      <>
        <CopyActionButton text="" idleAriaLabel="Copy empty" onCopyFailed={onCopyFailed} />
        <CopyActionButton text={() => null} idleAriaLabel="Copy null" onCopyFailed={onCopyFailed} />
        <CopyActionButton text={() => undefined} idleAriaLabel="Copy undefined" onCopyFailed={onCopyFailed} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy empty" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy null" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy undefined" }));

    expect(writeText).not.toHaveBeenCalled();
    expect(onCopyFailed).toHaveBeenCalledTimes(3);
  });

  test("changes the visible label in showLabel mode", async () => {
    installClipboard();

    render(<CopyActionButton text="copy me" showLabel />);

    expect(screen.getByRole("button", { name: "Copy" })).toHaveTextContent("Copy");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toHaveTextContent("Copied");
  });
});
