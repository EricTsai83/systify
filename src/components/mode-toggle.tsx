import { Moon, Sun } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/providers/theme-provider";

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <Button
      aria-label="Toggle theme"
      variant="secondary"
      size="icon"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="relative overflow-hidden"
    >
      <div className="relative w-[1.1rem] h-[1.1rem]">
        <Sun
          weight="bold"
          className="absolute inset-0 transition-opacity duration-150 ease-out motion-reduce:duration-0"
          style={{ opacity: isDark ? 1 : 0 }}
        />
        <Moon
          weight="bold"
          className="absolute inset-0 transition-opacity duration-150 ease-out motion-reduce:duration-0"
          style={{ opacity: isDark ? 0 : 1 }}
        />
      </div>
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
