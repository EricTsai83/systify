import { Fragment, memo, useMemo, type ReactNode } from "react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * Artifact bodies wrap content in Radix `<ScrollArea>` so the vertical
 * thumb is a real DOM element painted with the `--scrollbar-thumb` token
 * — it re-colors with the theme through the same token cascade as every
 * other surface.
 *
 * Native `::-webkit-scrollbar-thumb` was the previous approach but Chromium
 * caches the `var()` lookup inside that pseudo against the document root
 * at first paint and won't re-evaluate when `.dark` is toggled, so the
 * thumb visibly drifts out of sync after a theme switch.
 *
 * The Viewport's `max-height` is intentionally left unset by default so
 * callers can choose how tall the body should be. Compact callers (a
 * right-rail card preview) still get a bounded box by passing a
 * `[&_[data-slot=scroll-area-viewport]]:max-h-72` override; the
 * full-screen Reader passes `:max-h-none` so long-form content scrolls
 * with the page rather than inside a tiny window.
 */

/**
 * Lightweight markdown renderer tuned for the structured artifacts the
 * pipeline emits — ADR, failure-mode analysis, deep analysis, repository
 * manifest. We intentionally avoid pulling in `react-markdown` and a
 * commonmark/remark toolchain: artifacts are produced by a small set of
 * server-side templates with predictable structure, and the bundle savings
 * matter for the artifact panel which renders inside every workspace.
 *
 * Supported syntax (everything else falls through as plain text in a
 * paragraph, which is the safe-rendering default):
 *
 *   - `# / ## / ### / ####` headings
 *   - `-` / `*` bullet lists (single level — the artifacts don't nest)
 *   - ` ``` ` fenced code blocks (with optional language tag)
 *   - inline `` `code` ``, `**bold**`, `*italic*`
 *   - blank lines as paragraph separators
 *
 * The renderer is allocation-light: it parses the source once into a flat
 * block list and memoizes the result on `source`, so re-renders driven by
 * unrelated state (panel toggling, citation jumps, …) don't reparse. Inline
 * markup is split on a single regex pass per line.
 *
 * Safety: we never render raw HTML and never inject `dangerouslySetInnerHTML`.
 * All output is React text nodes or `<code>`/`<strong>`/`<em>` wrappers, so
 * an artifact whose body happens to contain `<script>` is rendered as the
 * literal string and cannot escape into the DOM.
 */
export const ArtifactMarkdown = memo(function ArtifactMarkdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  return (
    <ScrollArea className={cn("rounded-md border border-border bg-background", className)}>
      <div className="p-3 text-[12px] leading-relaxed text-foreground/90">
        {blocks.map((block, index) => renderBlock(block, index))}
      </div>
    </ScrollArea>
  );
});

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; language: string | null; text: string };

function parseMarkdown(source: string): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line === undefined) {
      i += 1;
      continue;
    }

    // Fenced code block. We greedily consume until the next ``` or the end
    // of input so a malformed artifact can't silently swallow the rest of
    // the document via runaway state.
    const fenceMatch = line.match(/^```\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || null;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      // Skip the closing fence (or EOF — both are fine).
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", language, text: codeLines.join("\n") });
      continue;
    }

    // ATX-style heading.
    const headingMatch = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, text: headingMatch[2] });
      i += 1;
      continue;
    }

    // Bullet list — collect contiguous `-` / `*` items into a single block
    // so the renderer can emit one <ul>.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // Blank lines act as paragraph separators — skip them.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Otherwise, gather a paragraph until the next blank line / structural
    // marker.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const candidate = lines[i] ?? "";
      if (
        candidate.trim() === "" ||
        /^#{1,4}\s+/.test(candidate) ||
        /^\s*[-*]\s+/.test(candidate) ||
        /^```/.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidate);
      i += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    }
  }

  return blocks;
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case "heading": {
      // Lock heading element to a small set of tags rather than building the
      // tag name from a string template — the latter requires casting through
      // `keyof JSX.IntrinsicElements`, which is fragile under the new JSX
      // transform. The visual level is encoded in the className, so screen
      // readers still get a reasonable heading hierarchy from the actual tag.
      const className = cn(
        block.level === 1
          ? "text-sm font-semibold tracking-tight"
          : block.level === 2
            ? "text-[12px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
            : "text-[12px] font-semibold",
        index === 0 ? "mb-2" : "mb-1.5 mt-3",
      );
      const inner = renderInline(block.text);
      switch (block.level) {
        case 1:
          return (
            <h3 key={index} className={className}>
              {inner}
            </h3>
          );
        case 2:
          return (
            <h4 key={index} className={className}>
              {inner}
            </h4>
          );
        case 3:
          return (
            <h5 key={index} className={className}>
              {inner}
            </h5>
          );
        case 4:
          return (
            <h6 key={index} className={className}>
              {inner}
            </h6>
          );
      }
      return null;
    }
    case "paragraph":
      return (
        <p key={index} className="mb-2 leading-relaxed text-foreground/90">
          {renderInline(block.text)}
        </p>
      );
    case "list":
      return (
        <ul key={index} className="mb-2 ml-4 list-disc space-y-1 text-foreground/90 marker:text-muted-foreground">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "code":
      return (
        <ScrollArea key={index} className="mb-2 rounded-md border border-border/60 bg-muted/40">
          <pre className="p-2 text-[11px] leading-snug text-foreground/85">
            <code>{block.text}</code>
          </pre>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      );
  }
}

const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

function renderInline(text: string): ReactNode {
  if (!text) return null;
  const parts = text.split(INLINE_PATTERN);
  return parts.map((part, index) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      return (
        <strong key={index} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length >= 2) {
      return (
        <em key={index} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
