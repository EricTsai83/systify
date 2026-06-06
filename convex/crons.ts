import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sweep expired sandboxes every hour.
// Reconciles Convex DB status with Daytona reality and proactively
// deletes sandboxes that have passed their TTL to free disk resources.
crons.interval("sweep expired sandboxes", { hours: 1 }, internal.opsNode.sweepExpiredSandboxes, {});

crons.interval("reconcile stale interactive jobs", { minutes: 5 }, internal.opsNode.reconcileStaleInteractiveJobs, {});

crons.interval("reconcile stale import jobs", { minutes: 5 }, internal.opsNode.reconcileStaleImportJobs, {});

crons.interval(
  "auto pause idle sandbox sessions",
  { minutes: 1 },
  internal.sandboxSessionsNode.autoPauseIdleSandboxSessions,
  {},
);

crons.interval(
  "retry failed artifact indexing",
  { minutes: 30 },
  internal.artifactIndexing.retryFailedArtifactIndexing,
  {},
);

crons.interval("reconcile daytona orphans", { hours: 6 }, internal.opsNode.reconcileDaytonaOrphans, {});

crons.interval("repair daytona webhook backlog", { minutes: 5 }, internal.daytonaWebhooks.repairBacklog, {});

crons.interval(
  "cleanup old daytona webhook events",
  { hours: 12 },
  internal.daytonaWebhooks.cleanupOldWebhookEvents,
  {},
);

// Purge expired GitHub OAuth CSRF states every 12 hours.
// These have a 10-minute TTL at creation but are never deleted, so without
// this sweep they accumulate indefinitely.
crons.interval("cleanup expired github oauth states", { hours: 12 }, internal.github.cleanupExpiredOAuthStates, {});

// Sandbox tool-call audit log retention sweep. Walks oldest-first
// and deletes rows past the 90-day retention window. Self-reschedules when a
// batch is full so a backlog drains across multiple ticks rather than
// breaching the per-mutation write budget. See
// `convex/chat/sandboxToolCallLog.ts:cleanupExpiredSandboxToolCallLogs`.
crons.interval(
  "cleanup expired sandbox tool call logs",
  { hours: 24 },
  internal.chat.sandboxToolCallLog.cleanupExpiredSandboxToolCallLogs,
  {},
);

// One bounded batch per hour in steady state, self-rescheduling when a legacy
// backlog exists. Keeps chatHistoryGroups repaired without putting a full-table
// scan on user-facing mutations.
crons.interval("repair chat history groups", { hours: 1 }, internal.chat.history.repairChatHistoryGroups, {});

crons.interval(
  "repair archived thread scopes",
  { hours: 1 },
  internal.chat.archiveState.repairArchivedThreadScopes,
  {},
);

export default crons;
