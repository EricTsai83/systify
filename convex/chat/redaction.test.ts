import { describe, expect, test } from "vitest";
import { REDACTION_PATTERN_TYPES, redact } from "./redaction";

/**
 * Test fixtures: each value is a *fake* secret that *exactly* matches the
 * documented pattern shape but is not, and has never been, a live
 * credential. Constructed inline (rather than fetched from a fixture
 * file) so a reader can verify by eye that the strings are deliberately
 * synthetic.
 */
const FAKE_GITHUB_INSTALLATION_TOKEN = `ghs_${"x".repeat(40)}`;
const FAKE_GITHUB_PERSONAL_TOKEN = `ghp_${"y".repeat(40)}`;
const FAKE_OPENAI_KEY = `sk-proj-${"A".repeat(48)}`;
const FAKE_ANTHROPIC_KEY = `sk-ant-${"B".repeat(48)}`;
const FAKE_GOOGLE_API_KEY = `AIza${"C".repeat(35)}`;
const FAKE_AWS_ACCESS_KEY = `AKIA${"Z".repeat(16)}`;
const FAKE_AWS_SECRET_KEY = "a".repeat(40);
const FAKE_SLACK_TOKEN = `xoxb-${"a".repeat(20)}-${"b".repeat(24)}`;

/**
 * A syntactically-valid (but semantically empty) JWT: header + payload +
 * signature, all base64url. Both header and payload start with `eyJ`,
 * the documented anchor.
 */
const FAKE_JWT = [
  "eyJhbGciOiJIUzI1NiJ9", // {"alg":"HS256"}
  "eyJzdWIiOiJ0ZXN0In0", // {"sub":"test"}
  "abcdef0123456789-_AB", // signature placeholder
].join(".");

const FAKE_BEARER_TOKEN = `Bearer ${"k".repeat(40)}`;

describe("redact()", () => {
  test("returns the original text and empty matchedTypes for input with no secrets", () => {
    const innocuous = "function hello() {\n  return 'world';\n}\n// References convex/chat/send.ts:80\n";
    const result = redact(innocuous);

    expect(result.redacted).toBe(innocuous);
    expect(result.matchedTypes).toEqual([]);
  });

  test("redacts a GitHub installation token (ghs_) and reports github_token", () => {
    const before = `clone url: https://x-access-token:${FAKE_GITHUB_INSTALLATION_TOKEN}@github.com/acme/repo.git`;
    const result = redact(before);

    expect(result.redacted).not.toContain(FAKE_GITHUB_INSTALLATION_TOKEN);
    expect(result.redacted).not.toContain("x-access-token");
    expect(result.redacted).toContain("[REDACTED:credential_url]");
    expect(result.matchedTypes).toEqual(["credential_url", "github_token"]);
  });

  test.each([
    { name: "personal token (ghp_)", token: FAKE_GITHUB_PERSONAL_TOKEN },
    { name: "installation token (ghs_)", token: FAKE_GITHUB_INSTALLATION_TOKEN },
    { name: "OAuth token (gho_)", token: `gho_${"q".repeat(40)}` },
    { name: "user-to-server (ghu_)", token: `ghu_${"r".repeat(40)}` },
    { name: "refresh token (ghr_)", token: `ghr_${"t".repeat(40)}` },
  ])("redacts GitHub $name", ({ token }) => {
    const result = redact(`secret: ${token}`);
    expect(result.redacted).not.toContain(token);
    expect(result.matchedTypes).toEqual(["github_token"]);
  });

  test("does NOT redact a too-short ghp_ prefix that fails the 36+ body rule", () => {
    // A user docstring that mentions `ghp_xxx` (placeholder, only a few
    // chars) is not a credential. The 36-char floor in the pattern keeps
    // these placeholders intact.
    const docs = "Pass a token like `ghp_xxx` to authenticate.";
    const result = redact(docs);
    expect(result.redacted).toBe(docs);
    expect(result.matchedTypes).toEqual([]);
  });

  test("redacts a JWT and reports jwt", () => {
    const before = `Authorization header value: ${FAKE_JWT}`;
    const result = redact(before);

    expect(result.redacted).not.toContain(FAKE_JWT);
    expect(result.redacted).toContain("[REDACTED:jwt]");
    expect(result.matchedTypes).toEqual(["jwt"]);
  });

  test("redacts OpenAI, Anthropic, and Google API keys", () => {
    const before = [
      `OPENAI_API_KEY=${FAKE_OPENAI_KEY}`,
      `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}`,
      FAKE_GOOGLE_API_KEY,
    ].join("\n");
    const result = redact(before);

    expect(result.redacted).not.toContain(FAKE_OPENAI_KEY);
    expect(result.redacted).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(result.redacted).not.toContain(FAKE_GOOGLE_API_KEY);
    expect(result.matchedTypes).toEqual(["anthropic_api_key", "google_api_key", "openai_api_key"]);
  });

  test("redacts an AWS access key and reports aws_access_key", () => {
    const before = `aws.accessKeyId = "${FAKE_AWS_ACCESS_KEY}"`;
    const result = redact(before);

    expect(result.redacted).not.toContain(FAKE_AWS_ACCESS_KEY);
    expect(result.matchedTypes).toEqual(["aws_access_key"]);
  });

  test("redacts a labelled AWS secret access key", () => {
    const before = `aws_secret_access_key = "${FAKE_AWS_SECRET_KEY}"`;
    const result = redact(before);

    expect(result.redacted).not.toContain(FAKE_AWS_SECRET_KEY);
    expect(result.matchedTypes).toEqual(["aws_secret_key"]);
  });

  test("does NOT redact a lowercase 'akia' string (case-sensitive guard)", () => {
    // Real AWS access key IDs are always uppercase; a lowercased lookalike
    // in user prose should not trigger redaction. Confirms the pattern
    // does NOT carry the `i` flag.
    const innocuous = `field "akia${"z".repeat(16)}" appears in the diff`;
    const result = redact(innocuous);
    expect(result.redacted).toBe(innocuous);
    expect(result.matchedTypes).toEqual([]);
  });

  test("redacts a Slack token and reports slack_token", () => {
    const before = `slack.botToken = "${FAKE_SLACK_TOKEN}"`;
    const result = redact(before);

    expect(result.redacted).not.toContain(FAKE_SLACK_TOKEN);
    expect(result.matchedTypes).toEqual(["slack_token"]);
  });

  test("redacts private key blocks", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvAIBADANBgkqhkiG9w0BAQEFAASC",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const result = redact(`key:\n${privateKey}\n`);

    expect(result.redacted).not.toContain("MIIEvAIB");
    expect(result.matchedTypes).toEqual(["private_key"]);
  });

  test("redacts database and credential-bearing URLs", () => {
    const databaseUrl = "postgres://app:supersecretpassword@example.com:5432/app";
    const cloneUrl = "https://x-access-token:githubtokenvalue@example.com/acme/repo.git";
    const result = redact([databaseUrl, cloneUrl].join("\n"));

    expect(result.redacted).not.toContain("supersecretpassword");
    expect(result.redacted).not.toContain("githubtokenvalue");
    expect(result.matchedTypes).toEqual(["credential_url", "database_url"]);
  });

  test("redacts assignment-style secrets and Basic auth headers", () => {
    const assignment = `password = "${"p".repeat(32)}"`;
    const basic = `Authorization: Basic ${"Q".repeat(28)}`;
    const result = redact([assignment, basic].join("\n"));

    expect(result.redacted).not.toContain("p".repeat(32));
    expect(result.redacted).not.toContain("Q".repeat(28));
    expect(result.matchedTypes).toEqual(["assignment_secret", "basic_auth"]);
  });

  test("redacts a Bearer header (case-insensitive) and reports bearer_token", () => {
    const before = `Authorization: ${FAKE_BEARER_TOKEN}`;
    const result = redact(before);

    expect(result.redacted).not.toContain(FAKE_BEARER_TOKEN);
    expect(result.redacted).toContain("[REDACTED:bearer_token]");
    expect(result.matchedTypes).toEqual(["bearer_token"]);
  });

  test("matches a lowercase 'bearer' header (case-insensitive flag in pattern)", () => {
    // Some clients emit `bearer` (lowercase). The Bearer pattern is the
    // only one in the registry with the `i` flag, and this test pins
    // that contract.
    const result = redact(`authorization: bearer ${"k".repeat(40)}`);
    expect(result.matchedTypes).toEqual(["bearer_token"]);
  });

  test("does NOT redact a too-short Bearer token (under 20 chars)", () => {
    // The 20-char floor exists to avoid false positives on short opaque
    // tokens (UUIDs, request IDs) that surface in logs.
    const tooShort = "Bearer abc123def";
    const result = redact(`Authorization: ${tooShort}`);
    expect(result.redacted).toContain(tooShort);
    expect(result.matchedTypes).toEqual([]);
  });

  test("preserves the surrounding 'Bearer ' prefix when the token body is itself a JWT (specific-before-general ordering)", () => {
    // The registry runs JWT before Bearer, so the JWT body is redacted
    // first and the Bearer pattern can no longer match (the redacted
    // sentinel contains brackets that fall outside the Bearer body
    // class). The human-readable `Bearer ` stays visible — strictly
    // more useful for the LLM than collapsing the whole header into one
    // opaque sentinel.
    const before = `Authorization: Bearer ${FAKE_JWT}`;
    const result = redact(before);

    expect(result.redacted).toBe(`Authorization: Bearer [REDACTED:jwt]`);
    expect(result.matchedTypes).toEqual(["jwt"]);
  });

  test("redacts multiple matches of the same pattern in one input (regex `g` flag is non-negotiable)", () => {
    // Silent loss of a duplicated secret is the most insidious failure
    // mode for this layer: a non-global regex would pass the
    // `not.toContain(tokenA)` assertion (first match scrubbed) while
    // leaving `tokenB` untouched. Pinning both tokens individually
    // catches that regression without coupling to sentinel-count
    // implementation detail.
    const tokenA = `ghs_${"a".repeat(40)}`;
    const tokenB = `ghs_${"b".repeat(40)}`;
    const result = redact(`first: ${tokenA}\nsecond: ${tokenB}\n`);

    expect(result.redacted).not.toContain(tokenA);
    expect(result.redacted).not.toContain(tokenB);
    expect(result.matchedTypes).toEqual(["github_token"]);
  });

  test("redacts a mix of distinct pattern types in one input and reports all matched types in sorted order", () => {
    const before = [
      `github=${FAKE_GITHUB_INSTALLATION_TOKEN}`,
      `aws=${FAKE_AWS_ACCESS_KEY}`,
      `slack=${FAKE_SLACK_TOKEN}`,
    ].join("\n");
    const result = redact(before);

    // matchedTypes must be alphabetically sorted regardless of pattern
    // registry order — the contract is "stable diff for audit logs".
    expect(result.matchedTypes).toEqual(["aws_access_key", "github_token", "slack_token"]);
    expect(result.redacted).not.toContain(FAKE_GITHUB_INSTALLATION_TOKEN);
    expect(result.redacted).not.toContain(FAKE_AWS_ACCESS_KEY);
    expect(result.redacted).not.toContain(FAKE_SLACK_TOKEN);
  });

  test("returns empty matchedTypes for the empty string", () => {
    const result = redact("");
    expect(result.redacted).toBe("");
    expect(result.matchedTypes).toEqual([]);
  });

  test.each([
    { name: "undefined", value: undefined as unknown as string },
    { name: "null", value: null as unknown as string },
    { name: "number", value: 42 as unknown as string },
  ])("treats $name input as a no-op without throwing (defensive guard)", ({ value }) => {
    // The TS signature requires `string`, but a defensive call from a
    // tool execute path that mistakenly passes a non-string value must
    // not crash the entire chat reply. The guard returns the input
    // unchanged with an empty matchedTypes list.
    const result = redact(value);
    expect(result.redacted).toBe(value);
    expect(result.matchedTypes).toEqual([]);
  });

  test("handles a large input efficiently (single-scan-per-pattern, no regex backtracking)", () => {
    // Build ~64 KiB of innocuous text — the same upper bound that
    // `read_file` enforces — and confirm the redactor returns quickly
    // without allocating new strings in the no-match path. No timing
    // assertion (flaky in CI), only a correctness assertion: the
    // redactor must not have wandered.
    const big = "alpha bravo charlie delta echo foxtrot ".repeat(2000);
    const result = redact(big);

    expect(result.redacted).toBe(big);
    expect(result.matchedTypes).toEqual([]);
  });

  test("redacts a secret embedded in a 64 KiB buffer (end-to-end large-input behaviour)", () => {
    // The defensive contract requires `redact()` to find a single
    // needle in a haystack the size of the read_file cap. If a future
    // change introduces an early-return optimisation that misses
    // matches near the end of the buffer, this test catches it.
    const filler = "x".repeat(64 * 1024 - FAKE_GITHUB_PERSONAL_TOKEN.length);
    const haystack = `${filler}${FAKE_GITHUB_PERSONAL_TOKEN}`;
    const result = redact(haystack);

    expect(result.redacted).not.toContain(FAKE_GITHUB_PERSONAL_TOKEN);
    expect(result.matchedTypes).toEqual(["github_token"]);
  });

  test("REDACTION_PATTERN_TYPES exposes every pattern slug exactly once", () => {
    // Documents the public surface so that adding a pattern without a
    // dedicated coverage case fails this assertion. Tests above cover
    // each of these slugs at least once.
    const unique = new Set(REDACTION_PATTERN_TYPES);
    expect(unique.size).toBe(REDACTION_PATTERN_TYPES.length);
    expect(unique).toEqual(
      new Set([
        "github_token",
        "openai_api_key",
        "anthropic_api_key",
        "google_api_key",
        "jwt",
        "private_key",
        "database_url",
        "credential_url",
        "aws_access_key",
        "aws_secret_key",
        "slack_token",
        "assignment_secret",
        "basic_auth",
        "bearer_token",
      ]),
    );
  });

  test("never produces a sentinel that itself contains a matchable substring (no infinite-loop / second-pass regression)", () => {
    // Defense in depth: if a future change makes the sentinel format
    // contain something that matches a pattern (e.g. a `Bearer` prefix
    // for some reason), running `redact(redact(x).redacted)` would
    // re-redact the sentinel and confuse audit consumers. This test
    // pins the invariant at the format level.
    const result = redact(`token: ${FAKE_GITHUB_INSTALLATION_TOKEN}`);
    const reRedacted = redact(result.redacted);

    expect(reRedacted.redacted).toBe(result.redacted);
    expect(reRedacted.matchedTypes).toEqual([]);
  });
});
