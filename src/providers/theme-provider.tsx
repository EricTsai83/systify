import { createContext, useContext, useEffect, useState } from "react";
import { readString, writeString } from "@/lib/storage";

type Theme = "dark" | "light" | "system";

function isValidTheme(v: string): v is Theme {
  return v === "dark" || v === "light" || v === "system";
}

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

function resolveTheme(theme: Theme): "dark" | "light" {
  return theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }

  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable || Boolean(target.closest('[contenteditable="true"], [role="textbox"], .monaco-editor'))
  );
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = readString(storageKey);
    return stored && isValidTheme(stored) ? stored : defaultTheme;
  });

  useEffect(() => {
    const root = window.document.documentElement;

    // Temporarily disable all CSS transitions so the theme switch is instant.
    root.classList.add("disable-transitions");

    root.classList.remove("light", "dark");

    const resolvedTheme = resolveTheme(theme);

    root.classList.add(resolvedTheme);
    // Keep native UI (scrollbars, form controls) in sync with the theme. The
    // pre-paint script in index.html sets this on first load; mirror it here
    // so runtime theme switches don't leave it stale.
    root.style.colorScheme = resolvedTheme;

    // Force a synchronous style/layout recompute so the new theme variables
    // are committed while transitions are still suppressed.
    void root.offsetHeight;

    // We need the browser to actually *paint* one frame with `transition: none`
    // before we re-enable transitions, otherwise removing the class in the
    // same frame as the recolour re-arms the transition right before paint
    // and we still see the bulk recolour animate.
    //
    // A single rAF fires *before* the next paint, so the class is gone again
    // by the time the paint happens — we need two: the first lets the recolour
    // paint with transitions off, the second is the earliest safe point to
    // drop the override.
    let innerId = 0;
    const outerId = requestAnimationFrame(() => {
      innerId = requestAnimationFrame(() => {
        root.classList.remove("disable-transitions");
      });
    });

    return () => {
      if (outerId) cancelAnimationFrame(outerId);
      if (innerId) cancelAnimationFrame(innerId);
      // Always drop the override on unmount so transitions aren't left
      // permanently disabled if we tear down before the inner rAF runs.
      root.classList.remove("disable-transitions");
    };
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return;
      }
      if (
        (event.key !== "d" && event.key !== "D") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      const nextTheme = resolveTheme(theme) === "dark" ? "light" : "dark";
      writeString(storageKey, nextTheme);
      setTheme(nextTheme);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [storageKey, theme]);

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      writeString(storageKey, theme);
      setTheme(theme);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};
