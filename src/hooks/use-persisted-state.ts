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
  // The key the most recent user-committed action (setter or cross-tab event)
  // applied to. Used by the write effect to suppress stale writes during a
  // mid-mount key swap: the key-change effect queues a `setValue` for the
  // new key's stored value, but the write effect in the same commit still
  // sees the previous render's `value` — without this guard it would
  // overwrite the new key's stored value with the old key's value.
  // Deliberately NOT updated by the key-change effect, since that effect
  // is auto-sync, not a user-committed action.
  const prevUserSetKeyRef = useRef<string>(key);

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
    if (!hasUserSetRef.current || prevUserSetKeyRef.current !== key) return;
    if (parse(readString(key)) === value) return;
    writeString(key, String(value));
  }, [key, value]);

  useEffect(() => {
    return onLocalStorageChange(key, (newValue) => {
      const parsed = parse(newValue);
      hasUserSetRef.current = parsed !== null;
      if (parsed !== null) {
        prevUserSetKeyRef.current = key;
      }
      setValue(parsed ?? defaultValue);
    });
  }, [key, defaultValue]);

  const setPersisted = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      hasUserSetRef.current = true;
      prevUserSetKeyRef.current = key;
      setValue((prev) => (typeof next === "function" ? next(prev) : next));
    },
    [key],
  );

  return [value, setPersisted] as const;
}

/**
 * Persist a string-enum preference in `localStorage`.
 *
 * The string-valued sibling of {@link useLocalStorageBoolean}: it shares the
 * same synchronous lazy read, conservative-write, mid-mount key-swap, and
 * cross-tab-sync behavior — see that hook's comment for the reasoning behind
 * each. The single addition is membership validation. A stored string
 * outside `allowed` (schema drift from an older build that wrote a value
 * this one no longer knows, or a hand-edited entry) is treated as a cache
 * miss and falls back to `defaultValue`, exactly as an absent key would.
 *
 * `allowed` must be a stable reference — pass a module-scope constant, not
 * an inline array literal. It describes the key's value domain (not
 * per-render state), and keeping it stable keeps `parse` — and the sync
 * effects that list it as a dependency — identity-stable across renders.
 */
export function useLocalStorageEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  defaultValue: T,
): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const parse = useCallback(
    (raw: string | null): T | null => {
      if (raw === null) return null;
      const candidate = raw as T;
      return allowed.includes(candidate) ? candidate : null;
    },
    [allowed],
  );

  const [value, setValue] = useState<T>(() => parse(readString(key)) ?? defaultValue);
  const hasUserSetRef = useRef<boolean>(parse(readString(key)) !== null);
  const prevUserSetKeyRef = useRef<string>(key);

  useEffect(() => {
    const stored = parse(readString(key));
    hasUserSetRef.current = stored !== null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(stored ?? defaultValue);
  }, [key, defaultValue, parse]);

  useEffect(() => {
    if (!hasUserSetRef.current || prevUserSetKeyRef.current !== key) return;
    if (parse(readString(key)) === value) return;
    writeString(key, value);
  }, [key, value, parse]);

  useEffect(() => {
    return onLocalStorageChange(key, (newValue) => {
      const parsed = parse(newValue);
      hasUserSetRef.current = parsed !== null;
      if (parsed !== null) {
        prevUserSetKeyRef.current = key;
      }
      setValue(parsed ?? defaultValue);
    });
  }, [key, defaultValue, parse]);

  const setPersisted = useCallback(
    (next: T | ((prev: T) => T)) => {
      hasUserSetRef.current = true;
      prevUserSetKeyRef.current = key;
      setValue((prev) => (typeof next === "function" ? next(prev) : next));
    },
    [key],
  );

  return [value, setPersisted] as const;
}
