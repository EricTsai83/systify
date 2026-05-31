# Deployment Overview

## Runtime Targets

The three apps run on AWS ECS Fargate. The `api` and `worker` services are independent ECS services behind one ALB; the `admin` SPA is served from S3 + CloudFront. Postgres is RDS; Redis is ElastiCache. All defined in `infra/terraform/`.

## Build & Release Pipeline

- `.github/workflows/ci.yml` runs `pnpm install`, `pnpm lint`, `pnpm test` on every PR.
- `.github/workflows/deploy.yml` runs on merge to `main`. It builds three Docker images, tags them with the short SHA, pushes to ECR, and updates the ECS task definitions via `aws ecs update-service`.
- Migrations run as a separate ECS task before the rolling deploy, via `.github/workflows/migrate.yml`. The job aborts the deploy if the migration step exits non-zero.

## Environment & Secrets

- Environment variables shipped via SSM Parameter Store, mounted into ECS tasks at boot.
- Application code reads them via `packages/core/src/env.ts`, which validates the schema with Zod and throws fast on missing keys.
- Stripe webhook secret, SendGrid key, and the WorkOS client secret are written as `SecureString` parameters and rotated quarterly via the `infra/scripts/rotate-secrets.sh` runbook.

## Infrastructure Dependencies

- Postgres 16 on RDS, single-AZ in staging, multi-AZ in production.
- Redis 7 on ElastiCache, single-node — queue state is rebuildable from Postgres, so no replica is provisioned.
- S3 bucket `acme-billing-reports-prod` for revenue exports.
- CloudWatch log groups per ECS service; subscription filter ships to Datadog.
- WorkOS tenant — managed in the WorkOS console, not in Terraform.

## Where to Look First

- `infra/terraform/main.tf` — top-level module wiring.
- `.github/workflows/deploy.yml` — release pipeline.
- `Dockerfile.api`, `Dockerfile.worker` — production images.
- `packages/core/src/env.ts` — environment schema.
