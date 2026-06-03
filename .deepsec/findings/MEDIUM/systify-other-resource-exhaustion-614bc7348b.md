# [MEDIUM] GitHub webhook reads unbounded bodies before signature rejection

**File:** [`convex/http.ts`](https://github.com/EricTsai83/systify/blob/main/convex/http.ts#L391-L407) (lines 391, 396, 407)
**Project:** systify
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-resource-exhaustion`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

The public /api/github/webhook endpoint only checks that a signature header exists, then calls request.text() and computes an HMAC over the full body before rejecting invalid signatures. An unauthenticated attacker can send requests with a bogus X-Hub-Signature-256 header and very large bodies, forcing memory allocation and HMAC work. The Daytona webhook path has an explicit 64 KiB capped reader, but the GitHub webhook path does not.

## Recommendation

Add a bounded raw-body reader for GitHub webhooks, reject oversized Content-Length values before reading, enforce a streaming byte cap, and return 413 for oversized payloads before HMAC work.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-19)
