import { Streamdown, type AllowedTags, type Components, type ControlsConfig } from "streamdown";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  /** Raw markdown string. A streaming chat reply passes partial markdown. */
  children: string;
  /** Extra classes merged onto the renderer's root element. */
  className?: string;
  /**
   * True while a chat reply is still streaming. Lets Streamdown skip
   * re-animating text that has already settled across stream chunks.
   * Artifacts render static content and leave this unset.
   */
  isAnimating?: boolean;
  /**
   * Custom (non-HTML) tags to keep through Streamdown's sanitizer. The
   * chat surface passes `citation` / `unverified`; artifacts pass nothing.
   */
  allowedTags?: AllowedTags;
  /** Renderers for the custom tags declared in {@link allowedTags}. */
  components?: Components;
}

/**
 * Shared markdown renderer for both the chat bubble and the artifact
 * Reader. Routing both surfaces through one wrapper keeps them visually
 * consistent (the shared-primitive pattern) and means any future token
 * override only has to be made once.
 *
 * Wraps Vercel's `<Streamdown>` — a streaming-aware `react-markdown`
 * replacement that safely renders incomplete markdown mid-stream.
 *
 * Deliberately keeps Streamdown's *default* plugin chain (`remark-gfm`
 * plus `rehype-raw` + `rehype-sanitize` + `rehype-harden`): passing a
 * custom `rehypePlugins`/`remarkPlugins` array would *replace* those
 * defaults and drop the sanitization pass. The chat surface's two inline
 * annotations (`[A#]` citations and unverified-claim highlights) instead
 * ride through Streamdown's `allowedTags` + `components` mechanism, which
 * leaves the security pipeline intact.
 */
export function Markdown({ children, className, isAnimating, allowedTags, components }: MarkdownProps) {
  return (
    <Streamdown
      className={cn("systify-markdown", className)}
      controls={MARKDOWN_CONTROLS}
      // No Shiki plugin is installed, so code fences render as a plain
      // block; a line-number gutter would add weight neither surface
      // carried before this renderer.
      lineNumbers={false}
      isAnimating={isAnimating}
      allowedTags={allowedTags}
      components={components}
    >
      {children}
    </Streamdown>
  );
}

/**
 * Keep only the code-block copy button. Table copy/download and the
 * mermaid control overlay are affordances neither surface needs — no
 * mermaid plugin is installed, and table export is not a workflow here.
 */
const MARKDOWN_CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
};
