import { useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownHeading } from "@/lib/markdown-headings";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

const MAX_MARKERS = 200;

/**
 * Three-mode restructure — Library minimap.
 *
 * Renders heading metadata as fixed-width tick marks (not a true content
 * thumbnail) so the cost is bounded by `headings.length` rather than the
 * artifact body length. Three responsibilities:
 *
 *   1. **Position indicator.** A translucent overlay box marks the
 *      current viewport's `(scrollTop / scrollHeight)` slice of the
 *      document — the visual metaphor every IDE minimap uses.
 *   2. **Active heading.** An IntersectionObserver watches the heading
 *      anchors in the editor and highlights the most-on-screen one in
 *      the marker strip.
 *   3. **Click-to-jump.** Clicking a heading row scrolls the editor to
 *      that anchor; dragging the viewport overlay scrubs the editor
 *      position continuously.
 *
 * Heading-only rendering keeps the panel useful even on long artifacts
 * with many fenced code blocks (which a true thumbnail would render as
 * unreadable noise). Rows past {@link MAX_MARKERS} bucket into a
 * "+N more" terminator so the strip stays bounded.
 *
 * `prefers-reduced-motion` removes the smooth-scroll behaviour on
 * click; the position-overlay still animates because it's driven by
 * scroll events, but the user's scroll input is what produces the
 * animation, not us.
 */
export function MinimapPanel({
  headings,
  scrollContainerRef,
  className,
  /**
   * Optional override for the slug → DOM id resolver. Tests may pass a
   * stub to avoid coupling to the editor's anchor implementation.
   */
  resolveAnchorId,
}: {
  headings: ReadonlyArray<MarkdownHeading>;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  className?: string;
  resolveAnchorId?: (heading: MarkdownHeading) => string;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState({ top: 0, height: 0 });

  const visibleHeadings = useMemo(() => headings.slice(0, MAX_MARKERS), [headings]);
  const overflowCount = Math.max(0, headings.length - MAX_MARKERS);

  // Track the active heading via IntersectionObserver. The observer
  // root is the scroll container so headings count as "visible" only
  // when they cross the editor's own viewport (not the document
  // viewport, which would also include the sidebar / topbar).
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || visibleHeadings.length === 0) return;
    const resolver = resolveAnchorId ?? ((heading: MarkdownHeading) => heading.id);
    const targets: Array<{ id: string; element: HTMLElement }> = [];
    for (const heading of visibleHeadings) {
      const element = root.querySelector<HTMLElement>(`[id="${resolver(heading)}"]`);
      if (element) {
        targets.push({ id: resolver(heading), element });
      }
    }
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry with the largest intersection ratio. A
        // straight "first visible" pick would jump twitchy when two
        // headings meet at the viewport seam.
        let bestId: string | null = null;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            bestId = entry.target.id;
          }
        }
        if (bestId !== null) {
          setActiveId(bestId);
        }
      },
      { root, rootMargin: "-20% 0px -60% 0px", threshold: [0, 0.1, 0.5, 1] },
    );
    for (const { element } of targets) observer.observe(element);
    return () => observer.disconnect();
  }, [visibleHeadings, scrollContainerRef, resolveAnchorId]);

  // Track the viewport overlay box. The math projects the editor's
  // (scrollTop, scrollHeight) onto the minimap height, with a 12 px
  // floor so a tiny artifact still renders a visible handle.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const update = () => {
      const minimap = overlayRef.current?.parentElement;
      if (!minimap) return;
      const scrollHeight = root.scrollHeight || 1;
      const clientHeight = root.clientHeight;
      const minimapHeight = minimap.clientHeight;
      const ratioTop = root.scrollTop / scrollHeight;
      const ratioHeight = clientHeight / scrollHeight;
      setOverlay({
        top: ratioTop * minimapHeight,
        height: Math.max(12, ratioHeight * minimapHeight),
      });
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(root);
    return () => {
      root.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollContainerRef]);

  const handleHeadingClick = (heading: MarkdownHeading) => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const resolver = resolveAnchorId ?? ((h: MarkdownHeading) => h.id);
    const target = root.querySelector<HTMLElement>(`[id="${resolver(heading)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  };

  return (
    <aside
      aria-label="Document minimap"
      className={cn(
        "relative h-full w-[120px] shrink-0 select-none border-l border-border bg-muted/20 px-2 py-3",
        className,
      )}
    >
      <div className="relative h-full">
        <div
          ref={overlayRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-0 right-0 rounded-sm border border-primary/40 bg-primary/10",
            !reducedMotion && "transition-[top,height] duration-150 ease-out",
          )}
          style={{ top: overlay.top, height: overlay.height }}
        />
        <ul className="relative flex flex-col gap-[2px]">
          {visibleHeadings.map((heading, index) => {
            const widthClass = heading.level === 1 ? "w-full" : heading.level === 2 ? "w-3/4" : "w-1/2";
            const resolver = resolveAnchorId ?? ((h: MarkdownHeading) => h.id);
            const isActive = activeId === resolver(heading);
            return (
              <li key={`${heading.id}-${index}`}>
                <button
                  type="button"
                  className="block w-full text-left"
                  title={heading.text}
                  onClick={() => handleHeadingClick(heading)}
                >
                  <span
                    className={cn(
                      "block h-[3px] rounded-sm transition-colors",
                      widthClass,
                      isActive ? "bg-primary" : "bg-foreground/30 hover:bg-foreground/60",
                    )}
                  />
                </button>
              </li>
            );
          })}
          {overflowCount > 0 ? (
            <li className="pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">+{overflowCount} more</li>
          ) : null}
        </ul>
      </div>
    </aside>
  );
}
