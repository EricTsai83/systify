/**
 * Three-mode restructure — shared markdown heading extraction.
 *
 * Used by the Library shell's minimap, breadcrumb, table-of-contents
 * sheet, and citation deep-link resolver so the call sites read from one
 * source of truth instead of several nearly-identical copies.
 *
 * The function is intentionally simple — the artifact pipeline produces
 * a small, well-formed subset of markdown (see `artifact-markdown.tsx`).
 * Anything ambiguous or non-conforming should still parse cleanly to a
 * "no headings" outline rather than throw.
 */
export interface MarkdownHeading {
  /**
   * Slugified id for `<a href="#…">` deep links and for matching the
   * `headingPath` snapshots stored on chunk-level citations. Stable
   * within an artifact body; collisions are de-duplicated by appending
   * a numeric suffix (mirrors GitHub-flavored markdown's anchor logic).
   */
  id: string;
  /** 1..3 — H1 / H2 / H3 only, the levels the chunker accumulates into headingPath. */
  level: 1 | 2 | 3;
  /** Display text with markdown punctuation stripped. */
  text: string;
}

const HEADING_REGEX = /^(#{1,3})\s+(.+?)\s*#*\s*$/gm;

export function extractHeadings(source: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  const seen = new Map<string, number>();
  HEADING_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADING_REGEX.exec(source))) {
    const level = match[1].length as 1 | 2 | 3;
    const text = match[2].trim();
    const baseId = slugifyHeading(text);
    const count = seen.get(baseId) ?? 0;
    seen.set(baseId, count + 1);
    const id = count === 0 ? baseId : `${baseId}-${count}`;
    out.push({ id, level, text });
  }
  return out;
}

function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}

/**
 * Three-mode restructure — resolve a `headingPath` (the H1/H2/H3 stack
 * stored on a citation entry) to the matching `MarkdownHeading` id so a
 * `[A1#section]` chip can deep-link directly to the heading anchor.
 *
 * The match walks the headings list and locks onto the deepest level
 * that matches the corresponding entry in `path`. Returns `null` when no
 * match is found (a stale path against an artifact that has since been
 * rewritten; the caller should fall back to scrolling to the top).
 */
export function findHeadingIdByPath(headings: MarkdownHeading[], path: ReadonlyArray<string>): string | null {
  if (path.length === 0) {
    return null;
  }
  // Walk forward and track the most recent heading at each level so we
  // can match against the path tip without re-scanning. The chunker's
  // contract is that `headingPath` is the stack at chunk time, so when
  // every entry of `path` is satisfied by a heading at the appropriate
  // level we have a hit.
  const stack: Array<MarkdownHeading | null> = [null, null, null]; // index 0 = H1
  for (const heading of headings) {
    stack[heading.level - 1] = heading;
    // Reset deeper levels — opening a new H2 invalidates the previous H3
    // anchor.
    for (let i = heading.level; i < stack.length; i += 1) {
      stack[i] = null;
    }
    const matches = path.every((entry, index) => {
      const stackEntry = stack[index];
      return stackEntry !== null && stackEntry.text === entry;
    });
    if (matches && stack[path.length - 1]?.text === path[path.length - 1]) {
      return stack[path.length - 1]!.id;
    }
  }
  return null;
}
