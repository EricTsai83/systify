import { useEffect } from "react";

interface LibraryShortcuts {
  /** Open the artifact quick-open dialog (Cmd/Ctrl-P). */
  onQuickOpen: () => void;
  /** Toggle the folder tree panel (Cmd/Ctrl-B). */
  onToggleTree: () => void;
}

/**
 * Keyboard shortcuts for the Library shell.
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
        if (event.key === "b" || event.key === "B") {
          event.preventDefault();
          shortcuts.onToggleTree();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts]);
}
