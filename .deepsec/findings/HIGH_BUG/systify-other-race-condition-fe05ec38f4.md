# [HIGH_BUG] On-demand sandbox can be marked ready after repository archive/delete cleanup

**File:** [`convex/imports.ts`](https://github.com/EricTsai83/systify/blob/main/convex/imports.ts#L96-L195) (lines 96, 99, 145, 186, 195)
**Project:** systify
**Severity:** HIGH_BUG  •  **Confidence:** medium  •  **Slug:** `other-race-condition`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

reserveOnDemandSandboxRow verifies the repository is owned and active only when the provisioning row is reserved. Later, attachOnDemandSandboxRemoteInfo blindly patches remote sandbox details, and markOnDemandSandboxReady blindly marks the sandbox ready and updates the repository commit metadata without re-checking that the sandbox row is still provisioning or that the repository is still active. If a user archives or deletes the repository while Daytona provisioning/cloning is in flight, cleanup can run before remoteId is attached and archive the local row without deleting the remote sandbox; the in-flight action can then attach the remoteId and set the row back to ready. That can leave private source cloned in a live Daytona sandbox after the user intended retirement/cleanup.

## Recommendation

In attachOnDemandSandboxRemoteInfo and markOnDemandSandboxReady, re-read the sandbox and repository in the same mutation, require the sandbox to still be status=provisioning, require it to belong to the repository/owner, and require the repository not to be archived or deleting. If the check fails after a remote sandbox has been created, mark the row failed/archived and schedule remote cleanup using the attached remoteId.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
