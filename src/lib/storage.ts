/**
 * Centralised localStorage / sessionStorage utilities.
 *
 * Every callsite in the app should funnel through this module rather than
 * touching `window.localStorage` / `window.sessionStorage` directly. The
 * helpers swallow private-mode / quota errors so callers can treat storage
 * as best-effort without their own try/catch — readers return `null` on
 * failure, writers no-op.
 *
 * Type-safe JSON access is via `readJSON` / `writeJSON`. `readJSON` requires
 * a type guard so schema drift (older code wrote a different shape) gets
 * treated as a cache miss instead of crashing the consumer with bad data.
 *
 * No SSR guards: Systify is a pure Vite SPA and the JSDOM test runner also
 * provides `window`, so `typeof window === "undefined"` would be dead code.
 */
type StorageArea = "local" | "session";

function area(kind: StorageArea): Storage {
  return kind === "local" ? window.localStorage : window.sessionStorage;
}

export function readString(key: string, kind: StorageArea = "local"): string | null {
  try {
    return area(kind).getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string, kind: StorageArea = "local"): void {
  try {
    area(kind).setItem(key, value);
  } catch {
    // Private mode / quota — caller should already tolerate in-memory-only.
  }
}

export function removeKey(key: string, kind: StorageArea = "local"): void {
  try {
    area(kind).removeItem(key);
  } catch {
    // Same.
  }
}

export function readJSON<T>(key: string, validate: (v: unknown) => v is T, kind: StorageArea = "local"): T | null {
  const raw = readString(key, kind);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeJSON<T>(key: string, value: T, kind: StorageArea = "local"): void {
  try {
    writeString(key, JSON.stringify(value), kind);
  } catch {
    // JSON.stringify only throws on cyclic structures — caller bug.
  }
}

export function listKeysByPrefix(prefix: string, kind: StorageArea = "local"): string[] {
  try {
    const storage = area(kind);
    const out: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix)) out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

// `storage` events only fire for localStorage across tabs — sessionStorage
// is per-tab and never broadcasts — so this helper is intentionally
// localStorage-only.
export function onLocalStorageChange(key: string, handler: (newValue: string | null) => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== key) return;
    handler(event.newValue);
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

export function removeKeysByPrefix(prefix: string, kind: StorageArea = "local"): void {
  const keys = listKeysByPrefix(prefix, kind);
  for (const key of keys) {
    removeKey(key, kind);
  }
}
