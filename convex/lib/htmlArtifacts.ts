export const HTML_ARTIFACT_MAX_BYTES = 750 * 1024;

export const HTML_ARTIFACT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const HTML_ARTIFACT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`;

export type HtmlArtifactValidationResult =
  | {
      valid: true;
      html: string;
      byteLength: number;
      errors: [];
    }
  | {
      valid: false;
      html: string;
      byteLength: number;
      errors: string[];
    };

const HTML_ENCODER = new TextEncoder();

const FORBIDDEN_TAG_RE = /<\s*(script|iframe|object|embed|form|base)\b/i;
const META_REFRESH_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i;
const INLINE_HANDLER_RE = /<[^>]+\son[a-z][a-z0-9_-]*\s*=/i;
const JAVASCRIPT_URL_RE = /\b(?:href|src|xlink:href)\s*=\s*["']?\s*javascript:/i;
const CSS_IMPORT_RE = /@import\b/i;
const CSP_META_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/i;
const EXACT_CSP_RE = new RegExp(escapeRegExp(HTML_ARTIFACT_CSP), "i");

export function validateHtmlArtifact(html: string): HtmlArtifactValidationResult {
  const normalized = injectCspMeta(html);
  const errors: string[] = [];
  const byteLength = HTML_ENCODER.encode(normalized).byteLength;

  if (byteLength > HTML_ARTIFACT_MAX_BYTES) {
    errors.push(`HTML must be at most ${HTML_ARTIFACT_MAX_BYTES} bytes.`);
  }
  if (!/^\s*<!doctype html>/i.test(normalized)) {
    errors.push("HTML must start with <!doctype html>.");
  }
  if (!hasElement(normalized, "html")) {
    errors.push("HTML must include an <html> element.");
  }
  if (!hasElement(normalized, "head")) {
    errors.push("HTML must include a <head> element.");
  }
  if (!hasElement(normalized, "body")) {
    errors.push("HTML must include a <body> element.");
  }
  if (!hasUtf8Meta(normalized)) {
    errors.push("HTML must include a UTF-8 charset meta tag.");
  }
  if (!hasViewportMeta(normalized)) {
    errors.push("HTML must include a responsive viewport meta tag.");
  }
  if (!hasNonEmptyBody(normalized)) {
    errors.push("HTML body must not be empty.");
  }
  if (!CSP_META_RE.test(normalized) || !EXACT_CSP_RE.test(normalized)) {
    errors.push("HTML must include the required Content-Security-Policy meta tag.");
  }

  if (FORBIDDEN_TAG_RE.test(normalized)) {
    errors.push("HTML must not include script, iframe, object, embed, form, or base tags.");
  }
  if (META_REFRESH_RE.test(normalized)) {
    errors.push("HTML must not include meta refresh.");
  }
  if (INLINE_HANDLER_RE.test(normalized)) {
    errors.push("HTML must not include inline event handlers.");
  }
  if (JAVASCRIPT_URL_RE.test(normalized)) {
    errors.push("HTML must not include javascript: URLs.");
  }
  if (CSS_IMPORT_RE.test(normalized)) {
    errors.push("HTML must not include CSS @import.");
  }

  errors.push(...validateAttributes(normalized));
  errors.push(...validateCssUrls(normalized));

  if (errors.length === 0) {
    return { valid: true, html: normalized, byteLength, errors: [] };
  }
  return { valid: false, html: normalized, byteLength, errors: uniqueErrors(errors) };
}

function injectCspMeta(html: string): string {
  if (CSP_META_RE.test(html) && EXACT_CSP_RE.test(html)) {
    return html;
  }
  return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${HTML_ARTIFACT_CSP_META}`);
}

function hasElement(html: string, tag: string): boolean {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "i");
  const close = new RegExp(`</${tag}>`, "i");
  return open.test(html) && close.test(html);
}

function hasUtf8Meta(html: string): boolean {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  return metaTags.some((tag) => {
    const lower = tag.toLowerCase();
    return (
      /\bcharset\s*=\s*["']?utf-8["']?/i.test(lower) ||
      (/\bhttp-equiv\s*=\s*["']?content-type["']?/i.test(lower) && /\bcharset\s*=\s*utf-8\b/i.test(lower))
    );
  });
}

function hasViewportMeta(html: string): boolean {
  return /<meta\b[^>]*\bname\s*=\s*["']viewport["'][^>]*>/i.test(html);
}

function hasNonEmptyBody(html: string): boolean {
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (!bodyMatch) {
    return false;
  }
  const body = bodyMatch[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
  return body.length > 0 || /<(svg|img|table|canvas)\b/i.test(bodyMatch[1]);
}

function validateAttributes(html: string): string[] {
  const errors: string[] = [];
  const attributeRe = /\b(href|xlink:href|src|srcset)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = attributeRe.exec(html)) !== null) {
    const attribute = match[1].toLowerCase();
    const value = unquote(match[2]).trim();
    if (attribute === "href" || attribute === "xlink:href") {
      if (!value.startsWith("#")) {
        errors.push("HTML links must be fragment-only anchors.");
      }
      continue;
    }
    if (attribute === "src") {
      if (!value.startsWith("data:")) {
        errors.push("HTML src attributes must use data: URLs only.");
      }
      continue;
    }
    if (attribute === "srcset" && !srcsetUsesOnlyDataUrls(value)) {
      errors.push("HTML srcset attributes must use data: URLs only.");
    }
  }
  return errors;
}

function validateCssUrls(html: string): string[] {
  const errors: string[] = [];
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(html)) !== null) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value.length > 0 && !value.startsWith("data:") && !value.startsWith("#")) {
      errors.push("CSS url(...) values must use data: URLs or fragment references only.");
    }
  }
  return errors;
}

function srcsetUsesOnlyDataUrls(value: string): boolean {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .every((url) => url.startsWith("data:"));
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function uniqueErrors(errors: string[]): string[] {
  return [...new Set(errors)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
