# Operations Overview

## Logging

- Structured JSON logs via `pino` configured in `packages/core/src/logger.ts`.
- Every log line carries `service`, `traceId`, and `commitSha` fields.
- HTTP access logs emitted by `pino-http` middleware in `apps/api/src/middleware/log.ts`.
- Worker jobs log start/end with `jobId`, `jobName`, and `durationMs` via `apps/worker/src/log.ts`.

## Metrics & Tracing

- Datadog APM agent enabled in production via the `DD_TRACE_ENABLED=true` env var; agent libs imported in `apps/api/src/dd.ts` and `apps/worker/src/dd.ts` before any other module.
- Custom metrics emitted via `dogstatsd` from `packages/core/src/metrics.ts`. Two dominant histograms: `billing.api.request.duration_ms` and `billing.worker.job.duration_ms`.
- OpenTelemetry traces collected via the Datadog agent; one trace spans the API → BullMQ → worker hop.

## Alerting & On-Call

- PagerDuty integration; alerts shipped from Datadog monitors defined in `infra/datadog/monitors.tf`.
- Critical monitors: webhook handler error rate > 1% over 5 min, BullMQ failed-job depth > 50, RDS storage > 85% used.
- Warning monitors page Slack; critical monitors page the rotation.
- Run-book references in `docs/oncall/`.

## Dashboards & Run-Books

- `docs/oncall/webhook-backlog.md` — what to do when Stripe webhook lag alerts fire.
- `docs/oncall/dunning-failed-spike.md` — what to do when failed dunning attempts spike.
- `docs/oncall/revenue-snapshot-missing.md` — recovery for a skipped nightly revenue snapshot.
- Datadog dashboards `acme-billing-api`, `acme-billing-worker`, `acme-billing-db` — linked from `docs/oncall/index.md`.

## Where to Look First

- `packages/core/src/logger.ts` — the canonical logger.
- `packages/core/src/metrics.ts` — the canonical metrics client.
- `infra/datadog/monitors.tf` — alert definitions.
- `docs/oncall/index.md` — run-book index.
