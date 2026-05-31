import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { toUserErrorMessage } from "@/lib/errors";

/**
 * Shared inline-rename state machine for tree-row UIs (thread rail, folder
 * navigator, future explorers). The host owns presentation, triggers, and
 * the actual server mutation — the hook owns the race-prone bits: the
 * cancel-vs-commit suppression, the no-op baseline snapshot, the
 * unmount-blur dedupe latch, and the post-exit focus restoration.
 *
 * Invariants the hook enforces (so hosts cannot accidentally break them):
 *   - Concurrent `commit()` calls collapse to one server call via the
 *     `isCommittingRef` latch. The Enter-keypress that flips out of edit
 *     mode races with the input's unmount-blur; both call `commit()`, but
 *     only one reaches `onCommit`.
 *   - Esc → `cancel()` flips `isCancellingRef` BEFORE `setIsEditing(false)`,
 *     so the unmount-blur that follows hits the cancel branch in `commit()`
 *     and short-circuits — no stale draft gets committed.
 *   - The "no change" baseline is `originalValueRef`, snapshotted INSIDE
 *     `startEdit` / `startEditEmpty` — not read from the live
 *     `currentValue`. A mid-edit subscription update that changes
 *     `currentValue` therefore can't shift the no-op threshold and clobber
 *     the freshly-arrived value on a no-typing blur.
 *   - `isCommitting` clears on rejection so a follow-up `commit()` (or a
 *     fresh edit cycle) can retry.
 *
 * What the hook deliberately does NOT own:
 *   - Visual treatment of the edit-mode row — each caller renders its own
 *     `<input>` and surrounding frame.
 *   - The trigger (double-click, kebab "Rename", auto-on-create) — the host
 *     wires `startEdit` / `startEditEmpty` to whatever UX it wants.
 *   - The semantics of cancel — `onCancel` is a notification; the folder
 *     fresh-create path uses it to remove the just-spawned folder, the
 *     thread row's cancel is a no-op.
 */
export type UseInlineRenameOptions = {
  /**
   * The authoritative current value (e.g. `thread.title`, `folder.name`).
   * Read by `startEdit` to seed the draft and snapshot the no-op baseline;
   * the snapshot survives subsequent prop changes (see invariants above).
   */
  currentValue: string;
  /**
   * Invoked with the trimmed draft on a real commit. Throw to surface a
   * failure: the hook resets the in-flight latch and routes the error
   * through `onError`.
   */
  onCommit: (next: string) => Promise<void>;
  /**
   * Fired exactly once when the user presses Esc. NOT fired on a no-op
   * blur (Enter with no change, blur with empty draft) — those exit edit
   * mode silently. Hosts wire side effects like "discard the just-spawned
   * folder" here.
   */
  onCancel?: () => void;
  /**
   * Toast / banner channel. The hook calls this with `null` immediately
   * before a commit (clearing prior errors) and with a message string if
   * `onCommit` rejects. Omit if the host doesn't surface rename errors.
   */
  onError?: (message: string | null) => void;
  /**
   * Generic fallback when `onCommit` rejects with a non-structured error.
   * Defaults to "Rename failed." — hosts should override with something
   * scoped ("Failed to rename thread.", "Failed to rename folder.") so the
   * toast reads naturally.
   */
  errorFallback?: string;
  /**
   * The focusable row element. On exit-from-edit-mode (cancel or commit),
   * if `document.activeElement` has fallen back to `<body>` (Enter / Esc
   * blurred the input without moving focus elsewhere), the hook focuses
   * the row's first `<button>` so keyboard users don't lose their place.
   */
  rowRef?: RefObject<HTMLElement | null>;
};

export type UseInlineRenameReturn = {
  isEditing: boolean;
  /**
   * True while `onCommit` is in flight. Wire to the input's `disabled`
   * prop so the user can't keep typing into a doomed draft.
   */
  isCommitting: boolean;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Seed the draft from `currentValue`. Use for kebab-menu "Rename" and F2. */
  startEdit: () => void;
  /**
   * Seed an EMPTY draft while snapshotting `currentValue` as the no-op
   * baseline. The create-then-rename UX (VS Code parity): the user sees
   * an empty input, can type a fresh name, and if they immediately
   * blur or press Enter without typing, the seeded server value is kept
   * (no-op commit).
   */
  startEditEmpty: () => void;
  commit: () => Promise<void>;
  cancel: () => void;
  /** Wire to the `<input>`'s `onKeyDown`. Handles Enter (commit) and Esc (cancel). */
  handleInputKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Wire to the row's focusable element. Handles F2 (enter edit mode). */
  handleRowKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
};

export function useInlineRename({
  currentValue,
  onCommit,
  onCancel,
  onError,
  errorFallback = "Rename failed.",
  rowRef,
}: UseInlineRenameOptions): UseInlineRenameReturn {
  const [isEditing, setIsEditing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [draft, setDraft] = useState("");
  const originalValueRef = useRef("");
  const isCancellingRef = useRef(false);
  const isCommittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasEditingRef = useRef(false);

  const startEdit = useCallback(() => {
    isCancellingRef.current = false;
    // Reset on entry so a prior successful commit (which leaves the latch
    // set, to suppress the unmount-blur it triggered) doesn't make the
    // next rename a silent no-op.
    isCommittingRef.current = false;
    originalValueRef.current = currentValue;
    setDraft(currentValue);
    setIsEditing(true);
  }, [currentValue]);

  const startEditEmpty = useCallback(() => {
    isCancellingRef.current = false;
    isCommittingRef.current = false;
    originalValueRef.current = currentValue;
    setDraft("");
    setIsEditing(true);
  }, [currentValue]);

  // Focus + select the input on the render that flips `isEditing` to true,
  // and restore focus to the row's first button on the render that flips
  // it back to false. Gated by `wasEditingRef` so freshly-mounted rows
  // don't steal focus (e.g. when a new thread or folder appears in the
  // rail while the user is typing in the composer).
  useEffect(() => {
    if (isEditing) {
      wasEditingRef.current = true;
      inputRef.current?.select();
      return;
    }
    if (!wasEditingRef.current) {
      return;
    }
    wasEditingRef.current = false;
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    // Enter / Escape exit while focus is still on the soon-to-unmount
    // input — by the time this effect runs activeElement has fallen back
    // to <body> and the row should reclaim focus. A blur-driven exit
    // (click elsewhere, Tab to another control) has already moved focus
    // to the new target; stealing it back would be wrong.
    if (active && active !== document.body) {
      return;
    }
    rowRef?.current?.querySelector("button")?.focus();
  }, [isEditing, rowRef]);

  const commit = useCallback(async () => {
    // Esc → `cancel()` sets the cancelling flag synchronously, then flips
    // `isEditing` to false. The input's unmount-blur calls back into
    // `commit()`; consume the flag and exit so we don't post the draft.
    if (isCancellingRef.current) {
      isCancellingRef.current = false;
      setIsEditing(false);
      return;
    }
    if (isCommittingRef.current) {
      return;
    }
    isCommittingRef.current = true;
    const trimmed = draft.trim();
    // No-op: empty draft or no-change rename — both are treated as a
    // silent exit. The seeded server value is preserved (matters for the
    // create-then-rename path where the draft starts empty).
    if (!trimmed || trimmed === originalValueRef.current) {
      setIsEditing(false);
      return;
    }
    setIsCommitting(true);
    onError?.(null);
    try {
      await onCommit(trimmed);
    } catch (error) {
      isCommittingRef.current = false;
      onError?.(toUserErrorMessage(error, errorFallback));
    } finally {
      setIsCommitting(false);
      setIsEditing(false);
    }
  }, [draft, errorFallback, onCommit, onError]);

  const cancel = useCallback(() => {
    isCancellingRef.current = true;
    onCancel?.();
    setIsEditing(false);
  }, [onCancel]);

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "F2") {
        e.preventDefault();
        startEdit();
      }
    },
    [startEdit],
  );

  return {
    isEditing,
    isCommitting,
    draft,
    setDraft,
    inputRef,
    startEdit,
    startEditEmpty,
    commit,
    cancel,
    handleInputKeyDown,
    handleRowKeyDown,
  };
}
