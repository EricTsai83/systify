# Client Storage Strategy

This document explains Systify's client-side storage strategy and guides decisions about where new preferences should live.

## Design Principles

Client storage in Systify is split between **localStorage** (device-local state) and **Convex DB** (user-synced state):

- **localStorage**: Device conditions, repository state, and frequent UI state that doesn't benefit from cross-device sync
- **Convex DB**: User identity and preferences that should be consistent across all devices

## Storage Rationale

| Item | Nature | Location | Why |
|------|--------|----------|-----|
| `vite-ui-theme` | Device condition | localStorage | Environment light, screen technology (OLED vs LCD), time of day all affect the best theme choice |
| `systify.sidebar.width.*` | Device condition | localStorage | Resolution-dependent; no value in cross-device sync |
| `systify.library.tabs.{repoId}` | Repository state | localStorage | IDE pattern — "which tabs are open on this machine right now" |
| `systify.library.askTabs.{repoId}` | Repository state | localStorage | Same rationale |
| `systify.folderNav.open.{repoId}.{nodeId}` | Navigation state | localStorage | Write-frequent, minimal cross-device value |
| `systify.artifactPanel.open` | Space/mode condition | localStorage | Layout preference for this session |
| `systify.activeRepositoryId` | User identity | localStorage (first-paint cache) + DB | "My current main project" — DB is source of truth (`userPreferences.lastActiveRepositoryId`) |
| `systify.auth.returnTo` | One-time flow | sessionStorage | OAuth callback route; expires at tab close |

## Adding New Storage

When adding a new preference:

1. **Classify it**: Is it tied to the device (resolution, ambient light, tab arrangement) or the user (email, preferred language, list of favorites)?

2. **Choose storage**:
   - Device condition / repository state → localStorage
   - User identity / preference → Convex DB (with localStorage as a first-paint cache if latency matters)

3. **Implement using `src/lib/storage.ts`**:
   ```ts
   import { readJSON, writeJSON } from "@/lib/storage";
   
   // Define a validator
   function isMyPreference(v: unknown): v is MyType {
     // Guard checks...
   }
   
   // Read from cache
   const cached = readJSON("my.storage.key", isMyPreference);
   
   // Write to cache
   writeJSON("my.storage.key", value);
   ```

4. **Wire up cleanup**: For id-scoped keys (`prefix.{repoId}.…`), add the prefix to `REPOSITORY_SCOPED_PREFIXES` in `use-storage-gc.ts` — the hook will sweep orphans automatically whenever the live id set shrinks. For one-off, non-id-scoped cleanup (e.g., a schema change to a global key), call `removeKeysByPrefix()` directly from a migration entry point:
   ```ts
   removeKeysByPrefix("systify.deprecatedPrefix.");
   ```

## Orphan Key Cleanup

Related keys are automatically cleaned up when their owner is deleted via the `useStorageGC` hook (mounted in `RepositoryShell`):

- When a **repository** is deleted: `systify.library.tabs.{repoId}`, `systify.library.askTabs.{repoId}`, and `systify.folderNav.open.{repoId}.…` keys are removed

Cleanup runs whenever the live id sets shrink (initial load, local deletion, or cross-tab deletion via Convex subscription). Adding a new id-scoped key? Add its prefix to `REPOSITORY_SCOPED_PREFIXES` in `use-storage-gc.ts` and the same machinery will sweep it.

For one-off, non-id-scoped cleanup (e.g. an old key whose schema changed), call `removeKeysByPrefix()` directly from a migration entry point.

## Anti-Patterns

Common storage-placement mistakes — these almost always indicate a misread of the decision framework above:

- **Syncing per-device layout to the DB.** Sidebar width, theme, or open/closed panel state should *not* go in the DB. Forcing convergence across a 27" external monitor and a phone produces a worse experience on both — the user's intent is "this is the right width for *this screen*," not "this is my width forever."
- **Treating identity preferences as device-local.** "My current repository" is identity, not device. Putting it in localStorage alone causes the well-known bug where a user switches repositories on laptop A, opens laptop B, and lands somewhere stale. This is exactly why `systify.activeRepositoryId` is a DB-backed value with localStorage as a first-paint cache only (see [`repository-persistence-system-design.md`](./repository-persistence-system-design.md)).
- **Skipping the validator on `readJSON`.** Returning `JSON.parse(raw) as MyType` without runtime validation makes schema drift a crash instead of a cache miss. The `readJSON` helper enforces this; do not bypass it.
- **Adding manual try/catch around storage calls.** The utilities in `src/lib/storage.ts` already swallow private-mode and quota errors. Wrapping callsites again adds noise without changing behaviour.
- **Forgetting orphan cleanup for id-scoped keys.** Any new `prefix.{repoId}.…` key must be reachable by `useStorageGC` or it will accumulate in users' browsers.

## Implementation Details

### Unified Storage Module

All localStorage/sessionStorage access goes through `src/lib/storage.ts`, which provides:

- **No SSR guards**: Systify is a pure Vite SPA; `typeof window === "undefined"` checks are dead code
- **Unified error handling**: All read/write failures are caught; no try-catch needed at call sites
- **Type-safe JSON**: `readJSON` requires a type validator to prevent schema-drift crashes

### Hydration

Storage reads in `useState` initializers (not `useEffect`) ensure the correct value renders on first paint — no hydration flashes or double-renders.

## Relationship to Other Designs

This document is the **codebase-level** strategy for client-side storage placement. It complements:

- [`client-storage-architecture.md`](./client-storage-architecture.md) — the implementation-level reference: helper API contracts, `useLocalStorageBoolean` and `useStorageGC` invariants, sessionStorage vs localStorage trade-offs, and test infrastructure. Read this when you are wiring up a new callsite or changing the helpers themselves.
- [`repository-persistence-system-design.md`](./repository-persistence-system-design.md) — the specific two-layer (localStorage cache + DB source of truth) design for the active repository pointer, plus the orphan-cleanup contract for repository deletion.

When in doubt about a new preference, start here to classify it (device vs identity vs one-time), then consult the architecture doc for the helper API, and the repository-persistence doc if it falls in the "identity, needs first-paint cache" bucket.
