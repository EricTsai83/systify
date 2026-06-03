# [HIGH_BUG] Sandbox tool caps are enforced after unbounded payloads are buffered

**File:** [`convex/chat/sandboxTools.ts`](https://github.com/EricTsai83/systify/blob/main/convex/chat/sandboxTools.ts#L751-L965) (lines 751, 796, 821, 942, 965)
**Project:** systify
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-resource-exhaustion`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

`read_file`, `list_dir`, and `run_shell` advertise capped output, but the caps are applied only after Daytona has already returned the full payload to the Convex action. `executeReadFile` downloads the entire file into a `Uint8Array` before slicing to 64 KiB, `executeListDir` fetches and sorts the complete directory before slicing to 200 entries, and `executeRunShell` receives the full command output string before truncating to 32 KiB. An authenticated user, or a prompt-injected repository that steers the LLM tools, can request a very large checked-in file, list a huge directory, or run a command that emits massive output. The 15s/60s timeouts reduce duration but do not bound memory or control-plane payload size, so a single tool call can exhaust action memory or severely degrade the worker despite the visible result being capped.

## Recommendation

Enforce size limits before buffering full payloads. Use Daytona metadata/range/streaming APIs if available, reject files above the read cap before download, avoid sorting unbounded directory listings, and run shell commands through an output-limited wrapper or SDK option that stops collection after the configured byte cap.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-28)
