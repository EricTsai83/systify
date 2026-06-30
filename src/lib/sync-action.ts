/**
 * Shared sync-action labels for the repository status surfaces.
 *
 * Two surfaces render a "sync the repository" affordance — the StatusPanel's
 * Repository intelligence card and the TopBar kebab's sync shortcut — and both
 * derive the same label from the same `(busy, hasRemoteUpdates, failed)`
 * signal. The label strings and their precedence live here so the two surfaces
 * cannot drift apart.
 *
 * Visibility is intentionally NOT centralized: each surface keeps its own
 * gating semantics (the panel shows the action while a sync is queued/running;
 * the kebab only shows it when a sync is actually actionable). This helper
 * abstracts the wording, not when the control appears.
 */
export const SYNC_ACTION_LABELS = {
  syncing: "Syncing…",
  needsUpdate: "Needs update",
  retry: "Retry sync",
  sync: "Sync repository",
} as const;

/**
 * Label set passed to `ButtonStateText` so it can reserve width for every
 * possible label and cross-fade between them.
 */
export const SYNC_ACTION_LABEL_STATES: readonly string[] = [
  SYNC_ACTION_LABELS.needsUpdate,
  SYNC_ACTION_LABELS.retry,
  SYNC_ACTION_LABELS.syncing,
  SYNC_ACTION_LABELS.sync,
];

export type SyncActionState = {
  /** A sync (or import) is in flight for this repository. */
  isBusy: boolean;
  /** New commits are available on the remote. */
  hasRemoteUpdates: boolean;
  /** The latest import/sync failed and can be retried. */
  repositoryFailed: boolean;
};

/**
 * Resolves the sync-action label from repository state. Precedence:
 * busy → updates available → failed → idle.
 */
export function getSyncActionLabel(state: SyncActionState): string {
  if (state.isBusy) return SYNC_ACTION_LABELS.syncing;
  if (state.hasRemoteUpdates) return SYNC_ACTION_LABELS.needsUpdate;
  if (state.repositoryFailed) return SYNC_ACTION_LABELS.retry;
  return SYNC_ACTION_LABELS.sync;
}
