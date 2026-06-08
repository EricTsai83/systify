# Sandbox / Live Source Surface Inventory

User-facing lifecycle copy should say **Live source**. The existing **Sandbox**
label remains only where it is part of the Discuss grounding vocabulary or a
historical grounding marker.

## State Sources

- `convex/lib/repositorySandbox.ts`
  - `sandboxModeStatus.reasonCode`: `available`, `missing_sandbox`, `sandbox_provisioning`, `sandbox_expired`, `sandbox_unavailable`
  - Drives lifecycle availability and disabled-reason copy.
- `convex/repositories.ts:getSandboxActivityStatus`
  - `kind`: `idle`, `activating`, `ready`, `expiring_soon`
  - Drives compact active/wake/progress badges.
- `jobs.kind`
  - `sandbox_activation`: explicit Activate/Wake/Retry live source work.
  - `chat` with `messages.groundSandbox === true`: historical Discuss answer used Sandbox grounding.
  - `system_design`: Repository Guide generation used Live source.
  - `artifact_draft`: Library Ask artifact draft generation used Live source.

## UI Surfaces

- `src/components/grounding-toggle-bar.tsx`
  - Discuss composer `Sandbox` toggle.
  - Data source: chat grounding capability verdict plus `sandboxModeStatus`.
  - Shows availability, disabled reason, and activatable state. Keeps `Sandbox` because it is the existing grounding control vocabulary.
- `src/components/chat-panel.tsx`
  - Warning notice when `groundSandbox` is on but Live source is unavailable.
  - Data source: `sandboxModeStatus`, `groundSandbox`, and access-disabled reasons.
  - Blocks Send until Live source is ready.
- `src/components/sandbox-activity-pill.tsx`
  - Chat-side Live source pill.
  - Data source: `api.repositories.getSandboxActivityStatus`.
  - Shows inactive, activating, ready, expiring soon, and Activate action.
- `src/components/chat-message.tsx`
  - Assistant grounding chips: `Sandbox`, `Library + Sandbox`.
  - Data source: persisted `messages.groundSandbox` / `messages.groundLibrary`.
  - Historical usage marker only; not current lifecycle state.
- `src/components/top-bar.tsx`
  - Hosts repo status pill, Live source badge, and status popover/sheet.
  - Data source: repository detail `sandboxModeStatus`, `sandbox`, `jobs`.
- `src/components/repo-status-indicator.tsx`
  - Top-bar Live source badge for `failed` and `provisioning`.
  - Data source: repository detail `sandbox`.
- `src/components/status-pill.tsx`
  - Compact repo status summary.
  - Data source: repository detail `sandboxModeStatus`, repository sync fields, and user-relevant jobs.
  - Live source warning/error contributes to worst-state logic; active `artifact_draft` contributes to `Working…`.
- `src/components/status-panel.tsx`
  - Detailed `Live source` card and Activity timeline.
  - Data source: `presentSandboxSurface`, repository detail jobs/artifacts.
  - Activity includes `sandbox_activation`, `system_design`, and `artifact_draft`.
- `src/pages/library.tsx`
  - `LibraryLiveSourceBadge`.
  - Data source: `api.repositories.getSandboxActivityStatus` plus pending activation signal.
  - Shows active, starting, inactive, and loading in the Library header.
- `src/components/library-ask-panel.tsx`
  - Library Ask document actions and artifact draft cards.
  - Data source: `api.libraryArtifactDrafts.*`, `api.repositories.getSandboxActivityStatus` passed from `src/pages/library.tsx`.
  - Normal Ask answers are artifact-only; `Create artifact` and `Update open artifact` draft cards are Live-source-backed and require explicit Apply.
- `src/components/library-artifact-draft-card.tsx`
  - Artifact draft confirmation, progress, preview, failure, Apply/Discard/Regenerate controls.
  - Data source: `artifactDrafts` joined with `jobs`, plus target artifact for update diffs.
  - Shows document work stages: `Preparing live source…`, `Reading codebase…`, `Drafting artifact…`, `Ready to review`.
- `src/pages/resources.tsx`
  - Cross-repo Live source status.
  - Data source: `api.repositories.listResourceInventory` and `presentSandboxSurface`.
  - Shows Activate/Wake/Retry actions and auto-stop / auto-archive metadata.
- `src/components/library-editor.tsx`
  - Artifact freshness based on sandbox-grounded verification.
  - Data source: artifact `lastVerifiedAt` and freshness projection.
  - Stale copy now says re-verify with Live source.
- `src/pages/settings.tsx`
  - Sandbox model preference scope.
  - Data source: model catalog and user preferences.
  - Keeps `Sandbox` as a technical model-scope label; description says Live source work, artifact drafts, and System Design generation.

## Normalization Rules

- Lifecycle state says `Live source`.
- Technical controls may keep `Sandbox` only when tied to the existing grounding vocabulary.
- Historical usage chips stay short: `Sandbox`, `Library + Sandbox`.
- Artifact draft generation is document work, not generic background work:
  - Job title: `Artifact draft`.
  - Stages: `Preparing live source…`, `Reading codebase…`, `Drafting artifact…`, `Ready to review`.
