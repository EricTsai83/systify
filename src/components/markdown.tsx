import {
  Streamdown,
  type AllowedTags,
  type Components,
  type ControlsConfig,
  type CustomRendererProps,
  type PluginConfig,
} from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { useMemo } from "react";
import { MermaidDiagram, type MermaidRepairRequest } from "@/components/mermaid-diagram";
import { cn } from "@/lib/utils";

export type { MermaidRepairRequest } from "@/components/mermaid-diagram";

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
  /** Optional artifact-only repair hook for Mermaid blocks that fail to render. */
  onRepairMermaid?: (request: MermaidRepairRequest) => Promise<void>;
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
 * leaves the security pipeline intact. The `plugins` prop below is the
 * supported add-on path and composes with — does not replace — that
 * pipeline.
 */
export function Markdown({
  children,
  className,
  isAnimating,
  allowedTags,
  components,
  onRepairMermaid,
}: MarkdownProps) {
  /**
   * Shared plugin set for both chat and artifact surfaces:
   *   - `code`     — Shiki syntax highlighting for fenced code blocks
   *   - `cjk`      — CJK-friendly tokenization (Chinese/Japanese/Korean
   *                  word boundaries and emphasis handling)
   *   - `math`     — `$...$` / `$$...$$` rendered through KaTeX
   *   - `renderers` — ` ```mermaid ` fences rendered by Systify's diagram viewer
   *
   * Memoized per repair callback so Streamdown keeps a stable plugin object
   * during ordinary chat streaming while artifacts can still wire in repair.
   */
  const plugins = useMemo<PluginConfig>(() => {
    function MermaidRenderer({ code, isIncomplete, meta }: CustomRendererProps) {
      return <MermaidDiagram chart={code} isIncomplete={isIncomplete} meta={meta} onRepair={onRepairMermaid} />;
    }

    return {
      code,
      cjk,
      math,
      renderers: [{ language: "mermaid", component: MermaidRenderer }],
    };
  }, [onRepairMermaid]);

  return (
    <Streamdown
      className={cn("systify-markdown", className)}
      controls={MARKDOWN_CONTROLS}
      plugins={plugins}
      // Line-number gutter would add weight neither surface carried
      // before; Shiki still highlights syntax without it.
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
 * Keep only the code-block copy button. Table copy/download isn't a
 * workflow here. Mermaid is handled by a custom renderer so Streamdown's
 * built-in controls stay disabled.
 */
const MARKDOWN_CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
};
