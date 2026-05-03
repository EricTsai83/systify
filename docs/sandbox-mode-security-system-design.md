# Sandbox Mode Security System Design

## Purpose

This document explains the security model for Systify's `sandbox` chat mode, in which an LLM is given shell-like tools (`read_file`, `list_dir`, `run_shell`) over a Daytona-hosted clone of the user's repository.

The scope is the boundary between sandbox tool output and persisted message content. Network isolation, sandbox lifecycle, and Daytona's own isolation properties are out of scope here.

## Problem Statement

The sandbox is ephemeral — it is created for analysis, used for one or more chat turns, then deleted. A naive reading of that lifecycle suggests that nothing inside the sandbox needs to be protected, because the sandbox itself is short-lived.

That reading is wrong. The threat is not that the sandbox is breached. The threat is that **content read by the LLM inside the sandbox flows into the LLM's response, and the response is persisted to the Convex `messages` table**.

Anything the LLM reads can become a permanent artifact in the durable chat history. Sandbox deletion does not retroactively scrub `messages`.

Two concrete classes of leakage motivate this design:

1. Credentials embedded into `.git/config` by the clone step itself.
2. Secrets hard-coded into source files by upstream contributors.

## Threat Model

### Assets to protect

- The Systify GitHub App installation access token used to clone private repos.
- Third-party secrets accidentally committed into customer repositories (API keys, JWTs, bearer tokens).
- The integrity of `messages` as a record that can be safely shown to teammates and stored long-term.

### Adversary capabilities

The relevant adversary is not a malicious user attacking Systify. It is the combination of:

- An LLM with shell access that has no concept of "sensitive file."
- Repository contents that may contain secrets the customer has not noticed.
- Persistence behavior that writes any tool output that informs an answer into a durable, queryable table.

In other words, the adversary is the system itself behaving normally.

### Out of scope

- Daytona container escape.
- Network exfiltration from inside the sandbox (covered separately by Daytona network isolation).
- Compromise of the Convex deployment.
- Pre-existing secrets already present in `messages` before this design lands.

## Why The Ephemeral-Sandbox Argument Fails

The intuitive argument is:

> The sandbox is deleted after analysis. We do not run the customer's service inside it. So no real secrets exist there.

This argument breaks in two places:

**First**, the sandbox is not empty when it starts. The clone step itself writes a credential into the sandbox — see "Confirmed Leak Path" below. This credential is not a customer secret; it is Systify's own GitHub App token.

**Second**, even when the sandbox starts clean, the cloned repository may contain hard-coded secrets that the customer either did not know about or did not consider sensitive. The LLM has no way to distinguish a secret from a normal string. Once it reads such a string, the string can appear verbatim in the assistant message, which is then written to `messages` and to the audit log.

In both cases, the leak point is downstream of the sandbox. Deleting the sandbox does nothing.

## Confirmed Leak Path: `.git/config`

The current clone implementation in `convex/daytona.ts:204-227` calls:

```ts
await sandbox.git.clone(
  args.url,
  "repo",
  args.branch,
  undefined,
  args.token ? "x-access-token" : undefined,
  args.token,
);
```

The Daytona SDK forwards the username/password pair to `git clone` over HTTPS. Git's default behavior is to persist the credential into `.git/config` on the cloned remote URL:

```
[remote "origin"]
    url = https://x-access-token:ghs_xxxxxxxxxxxxxxxx@github.com/owner/repo.git
```

The token is a GitHub App installation access token (`convex/githubAppNode.ts:110-129`). It is valid for one hour and scoped to whatever repositories the installation has been granted. That scope is small relative to a personal access token, but it is not negligible — for a multi-repo installation it covers every repo the customer has granted Systify.

There is no post-clone scrubbing in `convex/importsNode.ts:186-206`. The token sits in `.git/config` for the lifetime of the sandbox.

If sandbox mode lands without addressing this, an LLM running `run_shell` (Plan 08) can issue `cat .git/config` or `git remote -v`, see the token in the result, and emit it as part of its answer. The answer is then persisted to `messages`.

This is the dominant near-term threat. It is independent of customer behavior — the customer cannot avoid it by keeping their repo clean.

## Hard-Coded Secrets In Source Files

Once `.git/config` is handled, the next class of leakage is secrets hard-coded into committed source files:

```ts
// Real example pattern
const STRIPE_SECRET = "sk_live_[SECRET_REMOVED_FOR_DOCS]";
```

These files have unremarkable paths. No path-based blocklist can catch them. The only defense is content-based: scan tool output for high-confidence secret patterns and replace matches with a sentinel before the output reaches the LLM and before it reaches `messages`.

The relevant patterns for Systify are:

- GitHub tokens (`gh[pousr]_…`) — directly relevant given Systify's domain.
- JWTs (`eyJ…\.eyJ…\.[…]`) — common in modern auth code.
- Generic Bearer tokens (`Bearer\s+…{20,}`) — catches a wide tail of API auth.

AWS, Slack, Stripe, and similar provider-specific patterns are nice-to-have but not load-bearing for this product. They can be added without changing the design.

## Design Goals

1. Remove the unconditional `.git/config` token leak before sandbox tools see any production traffic.
2. Make secret scrubbing happen at the boundary between tool execution and LLM input, so that no path-aware logic in the tool layer can be bypassed by reading "innocent" files.
3. Apply the same scrubbing at the boundary between tool execution and durable storage (`messages`, audit log).
4. Avoid building a path-based blocklist that suggests a stronger guarantee than it provides.

## Chosen Design

The design has two layers, applied in order.

### Layer 1: Eliminate the `.git/config` token at clone time

After `sandbox.git.clone(...)` succeeds, immediately rewrite the remote URL to remove credentials:

```ts
await sandbox.process.executeCommand(
  `git remote set-url origin ${args.url}`,
  "repo",
);
```

Where `args.url` is the canonical HTTPS URL without embedded credentials.

This is preferred over alternatives because:

- It is a single command, runs once at clone time, and has no ongoing cost.
- It keeps the rest of the clone path unchanged — no migration to SSH, no new credential helper.
- It removes the credential from the only place it would otherwise persist.
- After scrubbing, subsequent `git fetch` / `git pull` will fail without credentials, which is the desired posture for a read-only analysis sandbox.

If the sandbox later needs to fetch additional refs, it should request a fresh installation token at that time and pass it via `GIT_ASKPASS` or a one-shot `-c http.extraheader`, never by re-embedding into the URL.

### Layer 2: Output redaction

A `redact(text)` function scans tool output for the three load-bearing patterns (GitHub token, JWT, Bearer) and replaces matches with `[REDACTED:<type>]`. Optional patterns (AWS, Slack, Stripe) can be added without changing the contract.

Redaction is applied at two points:

1. Before the tool result is returned to the LLM. This prevents the LLM from reasoning over or quoting the secret.
2. Before any tool input or output is written to `messages.toolCalls`, `messageToolCallEvents`, or `sandboxToolCallLog`.

`redact()` returns both the scrubbed text and a list of matched pattern types. The matched-types list is informational — it lets the LLM know that something was filtered without exposing what.

### What is deliberately not in scope

A path-based blocklist (`.env`, `.aws/credentials`, `secrets/`, etc.) is not part of the chosen design.

The reasoning is:

- `.env` files are not committed to repositories under normal practice and therefore do not appear in clones.
- `~/.aws/credentials` lives in the home directory, not the cloned repo path.
- `secrets/` directories are typically gitignored.
- A blocklist that mostly catches files that would not be present anyway provides false reassurance.

The two classes of secret that actually appear in cloned repositories — `.git/config` credentials and hard-coded secrets in source files — are addressed by Layer 1 and Layer 2 respectively. A path blocklist would not catch either.

If a future threat justifies it (for example, allowing users to upload arbitrary files into the sandbox), a focused blocklist can be added at that time.

## Defense In Depth Boundary

```mermaid
flowchart TD
  llm[LLM tool call]
  exec[Sandbox tool execute]
  raw[Raw tool output]
  redact[redact 'text']
  scrubbed[Scrubbed output + matched types]
  llmInput[LLM next-step input]
  durable[messages / toolCalls / audit log]

  llm --> exec --> raw --> redact
  redact --> scrubbed
  scrubbed --> llmInput
  scrubbed --> durable
```

The key property is that no path leads from `raw` to `llmInput` or `durable` without passing through `redact`. This is enforced inside the tool execute function rather than at the call site, so callers cannot accidentally bypass it.

## Trade-Offs

The chosen design accepts the following trade-offs:

- Redaction is regex-based and will both miss obfuscated secrets and occasionally false-positive on plausible-looking strings. This is acceptable because the alternative — a perfect classifier — does not exist, and the path-block alternative has worse coverage.
- Removing the credential from `.git/config` means subsequent `git fetch` inside the sandbox will fail without explicit re-auth. This is desired, not a defect.
- Per-pattern redaction means each new high-value pattern costs a regex and a test. This is cheap.

## Result

The result is a security boundary with a small, defensible surface:

- The clone step no longer writes a Systify credential into the sandbox at all.
- All tool output passes through a single redaction function before it reaches either the LLM or durable storage.
- The design does not lean on a path blocklist whose coverage would be largely illusory.

## Implementation

This design is realized by Plan 05 in `systify-chat-modes-multi-plan-implementation.md`. The clone-time scrub is a new requirement on `convex/daytona.ts`; the redaction module and its application points are unchanged from the original Plan 05 sketch but with a tightened pattern set.
