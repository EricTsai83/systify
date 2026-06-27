// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/providers/theme-provider";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("light", "dark", "disable-transitions");
  document.documentElement.style.colorScheme = "";
  vi.restoreAllMocks();
});

function ThemeProbe() {
  const { theme } = useTheme();
  return (
    <>
      <div data-testid="theme">{theme}</div>
      <input aria-label="Name" />
      <div aria-label="Editable body" contentEditable role="textbox" suppressContentEditableWarning>
        Editable
      </div>
    </>
  );
}

function renderTheme(defaultTheme: "dark" | "light" | "system" = "light") {
  return render(
    <ThemeProvider defaultTheme={defaultTheme} storageKey="theme-provider-test-theme">
      <ThemeProbe />
    </ThemeProvider>,
  );
}

describe("ThemeProvider shortcuts", () => {
  test("toggles between light and dark with the D key", async () => {
    renderTheme("light");

    fireEvent.keyDown(document, { key: "d" });
    await waitFor(() => expect(screen.getByTestId("theme")).toHaveTextContent("dark"));
    expect(window.localStorage.getItem("theme-provider-test-theme")).toBe("dark");

    fireEvent.keyDown(document, { key: "D" });
    await waitFor(() => expect(screen.getByTestId("theme")).toHaveTextContent("light"));
    expect(window.localStorage.getItem("theme-provider-test-theme")).toBe("light");
  });

  test("does not toggle while typing in editable controls", () => {
    renderTheme("light");

    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "d" });
    expect(screen.getByTestId("theme")).toHaveTextContent("light");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Editable body" }), { key: "d" });
    expect(screen.getByTestId("theme")).toHaveTextContent("light");
  });

  test("does not toggle when D is combined with browser modifiers", () => {
    renderTheme("light");

    fireEvent.keyDown(document, { key: "d", altKey: true });
    fireEvent.keyDown(document, { key: "d", ctrlKey: true });
    fireEvent.keyDown(document, { key: "d", metaKey: true });

    expect(screen.getByTestId("theme")).toHaveTextContent("light");
  });

  test("toggles from system based on the resolved color scheme", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

    renderTheme("system");

    fireEvent.keyDown(document, { key: "d" });
    await waitFor(() => expect(screen.getByTestId("theme")).toHaveTextContent("light"));
    expect(window.localStorage.getItem("theme-provider-test-theme")).toBe("light");
  });
});
