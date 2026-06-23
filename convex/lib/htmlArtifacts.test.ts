import { describe, expect, test } from "vitest";
import { HTML_ARTIFACT_MAX_BYTES, validateHtmlArtifact } from "./htmlArtifacts";

const VALID_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Report</title>
  <style>body { font-family: system-ui; } .hero { background-image: url("#local"); }</style>
</head>
<body>
  <main>
    <h1>System report</h1>
    <p>Grounded in Library evidence.</p>
    <a href="#sources">Sources</a>
  </main>
</body>
</html>`;

describe("validateHtmlArtifact", () => {
  test("accepts valid full documents and injects the CSP meta", () => {
    const result = validateHtmlArtifact(VALID_HTML);

    expect(result.valid).toBe(true);
    expect(result.html).toContain("Content-Security-Policy");
    expect(result.html).toContain("default-src 'none'");
  });

  test.each([
    ["script tags", VALID_HTML.replace("</body>", "<script>alert(1)</script></body>"), /script/i],
    ["inline handlers", VALID_HTML.replace("<main>", '<main onclick="alert(1)">'), /event handlers/i],
    ["external src", VALID_HTML.replace("</main>", '<img src="https://example.com/a.png"></main>'), /src/i],
    ["external srcset", VALID_HTML.replace("</main>", '<img srcset="https://example.com/a.png 1x"></main>'), /srcset/i],
    ["external css urls", VALID_HTML.replace('url("#local")', "url(https://example.com/a.png)"), /CSS url/i],
    ["css imports", VALID_HTML.replace("</style>", "@import url('x.css');</style>"), /@import/i],
    ["iframes", VALID_HTML.replace("</main>", "<iframe></iframe></main>"), /iframe/i],
    ["forms", VALID_HTML.replace("</main>", "<form></form></main>"), /form/i],
    ["meta refresh", VALID_HTML.replace("<title>", '<meta http-equiv="refresh" content="0"><title>'), /refresh/i],
    ["javascript links", VALID_HTML.replace('href="#sources"', 'href="javascript:alert(1)"'), /javascript/i],
    ["non-fragment links", VALID_HTML.replace('href="#sources"', 'href="/local"'), /fragment-only/i],
  ])("rejects %s", (_label, html, expectedError) => {
    const result = validateHtmlArtifact(html);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(expectedError);
  });

  test("rejects oversized HTML", () => {
    const oversized = VALID_HTML.replace("Grounded in Library evidence.", "x".repeat(HTML_ARTIFACT_MAX_BYTES));

    const result = validateHtmlArtifact(oversized);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/at most/);
  });
});
