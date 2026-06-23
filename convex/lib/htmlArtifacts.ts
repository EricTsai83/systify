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
const INLINE_HANDLER_RE = /<[^>]+(?:[\s/])on[a-z][a-z0-9_-]*\s*=/i;
const JAVASCRIPT_URL_RE = /\b(?:href|src|xlink:href)\s*=\s*["']?\s*javascript:/i;
const CSS_IMPORT_RE = /@import\b/i;
const META_TAG_RE = /<meta\b[^>]*>/gi;
const SRCSET_CANDIDATE_RE = /\s*((?:data:[^\s,]*,[^\s]+|#[^\s,]+)(?:\s+\d+(?:\.\d+)?[wx])?)\s*(?:,|$)/gy;

// Regex validation here is defense-in-depth only. The security boundary is the
// downstream CSP plus sandboxed iframe rendering; keep that intact even when
// tightening these checks.
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
  if (!hasRequiredCspMetaInHead(normalized)) {
    errors.push("HTML must include the required Content-Security-Policy meta tag.");
  }

  if (FORBIDDEN_TAG_RE.test(normalized)) {
    errors.push("HTML must not include script, iframe, object, embed, form, or base tags.");
  }
  if (hasCspMetaOutsideHead(normalized)) {
    errors.push("HTML Content-Security-Policy meta tags must be inside <head>.");
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
  if (firstHeadElementIsRequiredCspMeta(html)) {
    return html;
  }
  return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${HTML_ARTIFACT_CSP_META}`);
}

function hasRequiredCspMetaInHead(html: string): boolean {
  const headRange = getHeadContentRange(html);
  if (!headRange) {
    return false;
  }
  return getMetaTags(html.slice(headRange.start, headRange.end)).some(isRequiredCspMetaTag);
}

function firstHeadElementIsRequiredCspMeta(html: string): boolean {
  const headRange = getHeadContentRange(html);
  if (!headRange) {
    return false;
  }
  const headContent = html.slice(headRange.start, headRange.end).replace(/<!--[\s\S]*?-->/g, "");
  const firstElement = /<\s*[a-z][a-z0-9:-]*\b[^>]*>/i.exec(headContent)?.[0];
  return firstElement ? isRequiredCspMetaTag(firstElement) : false;
}

function hasCspMetaOutsideHead(html: string): boolean {
  const headRange = getHeadContentRange(html);
  const metaTagRe = new RegExp(META_TAG_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = metaTagRe.exec(html)) !== null) {
    if (!isCspMetaTag(match[0])) {
      continue;
    }
    if (!headRange || match.index < headRange.start || match.index >= headRange.end) {
      return true;
    }
  }
  return false;
}

function getHeadContentRange(html: string): { start: number; end: number } | null {
  const open = /<head\b[^>]*>/i.exec(html);
  if (!open) {
    return null;
  }
  const start = open.index + open[0].length;
  const close = /<\/head>/i.exec(html.slice(start));
  if (!close) {
    return null;
  }
  return { start, end: start + close.index };
}

function getMetaTags(html: string): string[] {
  return html.match(META_TAG_RE) ?? [];
}

function isCspMetaTag(tag: string): boolean {
  return readAttribute(tag, "http-equiv")?.toLowerCase() === "content-security-policy";
}

function isRequiredCspMetaTag(tag: string): boolean {
  return isCspMetaTag(tag) && readAttribute(tag, "content") === HTML_ARTIFACT_CSP;
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
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const candidateRe = new RegExp(SRCSET_CANDIDATE_RE.source, SRCSET_CANDIDATE_RE.flags);
  let offset = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = candidateRe.exec(trimmed)) !== null) {
    if (match.index !== offset) {
      return false;
    }
    const url = match[1].trim().split(/\s+/)[0] ?? "";
    if (!url.startsWith("data:") && !url.startsWith("#")) {
      return false;
    }
    matched = true;
    offset = candidateRe.lastIndex;
  }

  return matched && offset === trimmed.length;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function readAttribute(tag: string, name: string): string | undefined {
  const attributeRe = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  const match = attributeRe.exec(tag);
  if (!match) {
    return undefined;
  }
  return decodeAttributeValue(unquote(match[1]).trim());
}

function decodeAttributeValue(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
}

function uniqueErrors(errors: string[]): string[] {
  return [...new Set(errors)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
