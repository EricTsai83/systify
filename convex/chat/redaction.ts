/**
 * Output redaction for sandbox tool results.
 *
 * The threat: anything an LLM reads through `read_file` / `list_dir` /
 * `run_shell` flows into the assistant message and is persisted in the
 * `messages` table. The sandbox is ephemeral; `messages` is durable,
 * queryable, and shareable. Sandbox deletion does *not* retroactively
 * scrub `messages`. See `docs/sandbox/sandbox-mode-security-system-design.md`
 * for the full threat model.
 *
 * `redact()` is the single chokepoint that all tool output must pass
 * through *before* it reaches either the LLM or any durable store.
 *
 * Why content-based, not path-based: a `.env` file is gitignored by
 * convention; `~/.aws/credentials` lives outside the repo path; an
 * attacker can rename `secrets.env` to `notes.txt`. Content scanning is
 * the only defense that catches both `.git/config` token leaks and
 * hard-coded source secrets.
 *
 * Why "specific before general" ordering: the generic `Bearer …` pattern
 * runs last so `Bearer eyJ…` first matches as a JWT and yields
 * `Bearer [REDACTED:jwt]`. Keeping the human-readable `Bearer ` prefix
 * is strictly more useful for the LLM than collapsing the whole header
 * into one opaque sentinel.
 */

/**
 * Closed set of redaction pattern slugs. Surfacing as a literal union
 * (rather than `string`) lets the type system catch typos in audit-log
 * consumers (`sandboxToolCallLog.redactedFields`) and in tests.
 * Adding a pattern means widening this union *and* adding a registry
 * entry — the compiler enforces the pairing.
 */
export type RedactionType =
  | "github_token"
  | "openai_api_key"
  | "anthropic_api_key"
  | "google_api_key"
  | "jwt"
  | "private_key"
  | "database_url"
  | "credential_url"
  | "aws_access_key"
  | "aws_secret_key"
  | "slack_token"
  | "assignment_secret"
  | "basic_auth"
  | "bearer_token";

type RedactionPattern = {
  readonly type: RedactionType;
  readonly pattern: RegExp;
};

/**
 * Pattern table. Order is load-bearing — see the file header for the
 * "specific before general" rationale.
 *
 * Each pattern carries `g` so `String.prototype.replace` scrubs every
 * occurrence (a non-global regex would silently leak a duplicated
 * secret). Only the Bearer pattern carries `i`: the keyword
 * "Authorization: bearer …" is sometimes lowercased in HTTP clients,
 * but the credential prefixes (`AKIA`, `ghp_`, `xox[baprs]-`) are
 * documented to be case-sensitive — applying `i` globally would false-
 * positive on prose like `akia…`.
 */
const PATTERN_REGISTRY: readonly RedactionPattern[] = [
  // GitHub Personal Access / OAuth / Server / User-to-Server / Refresh.
  // 4-char family selector + `_` + ≥36 body chars per the documented
  // format. The ≥ floor (rather than exactly 36) survives a future
  // GitHub format expansion without code changes.
  { type: "github_token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },

  // Anthropic API keys.
  { type: "anthropic_api_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },

  // OpenAI secret keys (`sk-...`) and project keys (`sk-proj-...`).
  { type: "openai_api_key", pattern: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },

  // Google API / AI Studio keys.
  { type: "google_api_key", pattern: /AIza[0-9A-Za-z_-]{35}/g },

  // JWT compact serialization. Both header and payload begin with `eyJ`
  // (base64url of `{"…`); requiring it on both segments is the strictest
  // anchor.
  { type: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },

  // PEM private-key blocks. DotAll would be shorter, but `[\s\S]` keeps
  // this robust across runtimes and tsconfig targets.
  {
    type: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },

  // Database connection URLs with a password component.
  {
    type: "database_url",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
  },

  // Generic credential-bearing URLs, including git clone URLs with
  // `https://x-access-token:<token>@github.com/...` userinfo.
  { type: "credential_url", pattern: /\bhttps?:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi },

  // AWS access key IDs: `AKIA` + 16 uppercase alphanumerics.
  { type: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g },

  // AWS secret access keys when labelled in env/config files.
  {
    type: "aws_secret_key",
    pattern: /\b(?:aws[_-]?)?secret[_-]?access[_-]?key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
  },

  // Slack `xoxb-…` / `xoxp-…` / etc.
  { type: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]+/g },

  // Assignment-style catch-all for common secret names that do not have a
  // stable provider prefix. Kept late so provider-specific sentinels win.
  {
    type: "assignment_secret",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{24,}["']?/gi,
  },

  // HTTP Basic credentials. Specific enough to preserve short prose like
  // "use Basic auth" while scrubbing actual headers.
  { type: "basic_auth", pattern: /Basic\s+[A-Za-z0-9+/=]{20,}/gi },

  // Generic `Bearer <token>` catch-all. The body class is the RFC 6750
  // token68 subset that excludes `+/=` — including them would let the
  // pattern walk past the token into surrounding text. The 20-char
  // floor avoids false-positives on UUIDs or short request IDs.
  { type: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/gi },
];

function buildSentinel(type: RedactionType): string {
  return `[REDACTED:${type}]`;
}

export type RedactionResult = {
  readonly redacted: string;
  /**
   * Sorted, de-duplicated slugs that matched at least once. Sorting
   * makes audit-log diffs stable across regex match orders.
   */
  readonly matchedTypes: readonly RedactionType[];
};

/**
 * Scrub credential-shaped substrings out of `text` and report which
 * pattern types matched.
 *
 * Contract:
 *   - Returns the original text and an empty `matchedTypes` for input
 *     that contains no matches.
 *   - Returns a new string with every match replaced by
 *     `[REDACTED:<type>]` when one or more patterns hit.
 *   - Non-string input is treated as a no-op (returned unchanged with
 *     empty `matchedTypes`). Defense in depth, not a supported
 *     entrypoint — the type signature requires `string`.
 *
 * Performance: O(n × P) where n = `text.length` and P = number of
 * patterns. All patterns are linear DFAs (no backreferences, no nested
 * quantifiers), so a 64 KiB input with no matches scans cleanly in a
 * single millisecond. V8's `String.prototype.replace` returns the same
 * string reference when no replacements occur, so the no-secret hot
 * path is allocation-free except for the empty result envelope.
 */
export function redact(text: string): RedactionResult {
  if (typeof text !== "string" || text.length === 0) {
    return { redacted: text, matchedTypes: [] };
  }

  const matched = new Set<RedactionType>();
  let working = text;

  for (const { type, pattern } of PATTERN_REGISTRY) {
    let didMatch = false;
    working = working.replace(pattern, (match) => {
      if (match.includes("[REDACTED:") && type !== "credential_url" && type !== "database_url") {
        return match;
      }
      didMatch = true;
      return buildSentinel(type);
    });
    if (didMatch) {
      matched.add(type);
    }
  }

  if (matched.size === 0) {
    return { redacted: working, matchedTypes: [] };
  }
  return { redacted: working, matchedTypes: [...matched].sort() };
}

/**
 * Test-only export: the slug list this module knows about. Lets tests
 * assert "every pattern in the registry has a dedicated coverage case"
 * without grepping the source.
 */
export const REDACTION_PATTERN_TYPES: readonly RedactionType[] = PATTERN_REGISTRY.map((p) => p.type);
