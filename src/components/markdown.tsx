import {
  Streamdown,
  type AllowedTags,
  type Components,
  type ControlsConfig,
  type MermaidErrorComponentProps,
  type PluginConfig,
} from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { useState } from "react";
import { cn } from "@/lib/utils";

export interface MermaidRepairRequest {
  chart: string;
  error: string;
}

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
  return (
    <Streamdown
      className={cn("systify-markdown", className)}
      controls={MARKDOWN_CONTROLS}
      plugins={MARKDOWN_PLUGINS}
      mermaid={{
        errorComponent: (props) => <MermaidRenderError {...props} onRepair={onRepairMermaid} />,
      }}
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
 * Shared plugin set for both chat and artifact surfaces:
 *   - `code`     — Shiki syntax highlighting for fenced code blocks
 *   - `cjk`      — CJK-friendly tokenization (Chinese/Japanese/Korean
 *                  word boundaries and emphasis handling)
 *   - `math`     — `$...$` / `$$...$$` rendered through KaTeX
 *   - `mermaid`  — ` ```mermaid ` fences rendered as diagrams
 *
 * Module-level so the reference stays stable across renders (Streamdown
 * uses referential equality on `plugins` to avoid re-initializing the
 * pipeline).
 */
const MARKDOWN_PLUGINS: PluginConfig = { code, cjk, math, mermaid };

/**
 * Keep only the code-block copy button. Table copy/download isn't a
 * workflow here, and the mermaid control overlay (download / fullscreen
 * / pan-zoom) would compete visually with the chat bubble's own chrome
 * — the diagram still renders, just without the overlay.
 */
const MARKDOWN_CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
};

function MermaidRenderError({
  chart,
  error,
  onRepair,
}: MermaidErrorComponentProps & {
  onRepair?: (request: MermaidRepairRequest) => Promise<void>;
}) {
  const [isRepairing, setIsRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  const handleRepair = async () => {
    if (!onRepair || isRepairing) return;

    setIsRepairing(true);
    setRepairError(null);
    try {
      await onRepair({ chart, error });
    } catch (caught) {
      setRepairError(
        caught instanceof Error && caught.message.trim() ? caught.message : "Couldn't repair this diagram.",
      );
    } finally {
      setIsRepairing(false);
    }
  };

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-destructive">Mermaid diagram could not render.</p>
          <p className="mt-1 break-words text-muted-foreground">{error}</p>
          {repairError ? <p className="mt-2 break-words text-xs text-destructive">{repairError}</p> : null}
        </div>
        {onRepair ? (
          <button
            type="button"
            onClick={() => void handleRepair()}
            disabled={isRepairing}
            className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRepairing ? "Repairing..." : "Repair diagram"}
          </button>
        ) : null}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">View Mermaid source</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
          <code>{chart}</code>
        </pre>
      </details>
    </div>
  );
}
