import { useEffect } from "react";

interface LibraryShortcuts {
  /** Open the artifact quick-open dialog (Cmd/Ctrl-P). */
  onQuickOpen: () => void;
  /** Close the active tab (Cmd/Ctrl-W). */
  onCloseActiveTab: () => void;
  /** Toggle the folder tree panel (Cmd/Ctrl-B). */
  onToggleTree: () => void;
  /**
   * Focus the Nth tab where `index` is 0-based (Alt+1..9 → indices 0..8).
   * No-op when fewer than `index + 1` tabs are open — the caller is
   * responsible for the bounds check on its tab list.
   */
  onFocusTab: (index: number) => void;
}

/**
 * Three-mode restructure — IDE-style keyboard shortcuts for the Library
 * shell.
 *
 * Mirrors the editor key bindings the user already knows from VS Code
 * et al. so navigating the library doesn't require re-learning the
 * shortcuts. Two invariants:
 *
 *   1. **No interference with text inputs.** When the focused element
 *      is an `<input>`, `<textarea>`, or contenteditable, the listener
 *      bails so a user typing inside an inline rename doesn't lose
 *      keystrokes to the global handlers. Mirrors the
 *      `repository-shell.tsx` pattern.
 *   2. **Cross-platform Cmd/Ctrl.** The tester uses `metaKey || ctrlKey`
 *      so the same shortcut works on macOS (Cmd) and Linux/Windows
 *      (Ctrl). `event.altKey` checks are explicit so an Alt-modified
 *      version of the shortcut doesn't accidentally trigger.
 */
export function useLibraryShortcuts(shortcuts: LibraryShortcuts) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (target instanceof HTMLElement) {
        if (target.isContentEditable || target.closest('[contenteditable="true"], [role="textbox"], .monaco-editor')) {
          return;
        }
      }
      const cmdOrCtrl = event.metaKey || event.ctrlKey;
      if (cmdOrCtrl && !event.shiftKey && !event.altKey) {
        if (event.key === "p" || event.key === "P") {
          event.preventDefault();
          shortcuts.onQuickOpen();
          return;
        }
        if (event.key === "w" || event.key === "W") {
          event.preventDefault();
          shortcuts.onCloseActiveTab();
          return;
        }
        if (event.key === "b" || event.key === "B") {
          event.preventDefault();
          shortcuts.onToggleTree();
          return;
        }
      }
      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        // Alt+1..9 → tab 0..8. The slot above 9 is intentionally
        // unbound; users with more than 9 open tabs must mouse / Cmd+P
        // to reach the rest.
        if (event.key >= "1" && event.key <= "9") {
          const index = Number.parseInt(event.key, 10) - 1;
          event.preventDefault();
          shortcuts.onFocusTab(index);
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts]);
}
