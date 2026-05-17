import { useCallback, useEffect, useRef, useState } from "react";
import { onLocalStorageChange, readString, writeString } from "@/lib/storage";

function parse(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/**
 * Persist a boolean preference in `localStorage`.
 *
 * The lazy `useState` initializer reads the stored value synchronously so
 * the first render already shows the persisted value — no `isHydrated`
 * gate, no flash. The hook also re-reads when `key` changes between
 * renders (a parent swapping the storage key gets a fresh read), and
 * subscribes to cross-tab `storage` events so writes from another tab
 * propagate live.
 *
 * Writes are conservative: a mount whose lazy init resolved to
 * `defaultValue` because storage was empty does NOT persist that default
 * back. Otherwise every (key, defaultValue) pair the user ever rendered
 * would silently bloat localStorage with default-valued entries that the
 * orphan GC cannot distinguish from intentional choices. The
 * `hasUserSetRef` flag — flipped by the setter, by a non-null cross-tab
 * `storage` event, or by lazy-init reading a non-null stored value —
 * gates the write effect so writes happen only after a real commit.
 *
 * As a consequence, the hook follows a changing `defaultValue` only while
 * the user has not yet committed a value — once they pick (or another tab
 * does), the stored value wins and subsequent default changes are ignored.
 */
export function useLocalStorageBoolean(
  key: string,
  defaultValue: boolean,
): readonly [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => parse(readString(key)) ?? defaultValue);
  // True iff there is a real stored value to persist — i.e. the user (or
  // another tab) has committed. Tracked in a ref because the write effect
  // must observe this synchronously, before React applies the next
  // `setValue` from a defaultValue change.
  const hasUserSetRef = useRef<boolean>(parse(readString(key)) !== null);

  // Re-read on key / defaultValue change. setState-in-effect is the only
  // tool here — both inputs can change between renders, and React's
  // `useState` initializer only runs on the first render. The effect is
  // bounded to a single setState per dep change, not a render loop.
  useEffect(() => {
    const stored = parse(readString(key));
    hasUserSetRef.current = stored !== null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(stored ?? defaultValue);
  }, [key, defaultValue]);

  useEffect(() => {
    if (!hasUserSetRef.current) return;
    if (parse(readString(key)) === value) return;
    writeString(key, String(value));
  }, [key, value]);

  useEffect(() => {
    return onLocalStorageChange(key, (newValue) => {
      const parsed = parse(newValue);
      hasUserSetRef.current = parsed !== null;
      setValue(parsed ?? defaultValue);
    });
  }, [key, defaultValue]);

  const setPersisted = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    hasUserSetRef.current = true;
    setValue((prev) => (typeof next === "function" ? next(prev) : next));
  }, []);

  return [value, setPersisted] as const;
}
