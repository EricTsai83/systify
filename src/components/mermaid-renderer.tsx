import { Component, useEffect, useId, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "@/providers/theme-provider";
import { cn } from "@/lib/utils";

/**
 * MermaidRenderer — safe in-app renderer for Mermaid diagrams.
 *
 * Renders the output of `ArchitectureDiagramGenerator`. Three things make
 * this component "safe":
 *
 *   1. **Sandboxed parsing.** Mermaid is invoked with `securityLevel: 'strict'`
 *      so user-controlled diagram source cannot inject HTML/scripts. We also
 *      run `mermaid.parse(source)` first so a syntactically broken diagram
 *      surfaces a friendly error rather than throwing inside `render()`.
 *   2. **Error boundary.** Any exception from the mermaid runtime — async
 *      render, theme initialization, or our own render code — is caught and
 *      collapses to a fallback card with the offending source visible. A
 *      single broken artifact must not blank the whole right rail.
 *   3. **Theme bridge.** The renderer subscribes to the app's `useTheme()` so
 *      light / dark mode changes re-render the diagram with the matching
 *      Mermaid theme.
 *
 * Mermaid is loaded via `import('mermaid')` so its ~700KB bundle stays out of
 * the initial route chunk; right-rail artifacts are not on the critical path.
 */
export function MermaidRenderer({ source, className }: { source: string; className?: string }) {
  return (
    <MermaidErrorBoundary source={source}>
      <MermaidRendererImpl source={source} className={className} />
    </MermaidErrorBoundary>
  );
}

function MermaidRendererImpl({ source, className }: { source: string; className?: string }) {
  const reactId = useId();
  // Mermaid ids must be CSS-safe identifiers (no `:`, no leading digit). The
  // `useId` value is namespaced with `:r0:`-style braces by React, so we strip
  // anything that isn't alphanumeric.
  const elementId = useMemo(() => `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`, [reactId]);
  const { theme } = useTheme();
  const resolvedTheme = useResolvedTheme(theme);

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSvg(null);

    void (async () => {
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;

        // `initialize` is idempotent for the same theme key, but calling it
        // every effect run lets us swap themes without juggling a "did we
        // initialize yet?" flag elsewhere.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "default",
          fontFamily: "inherit",
        });

        // `parse` validates the source synchronously and throws on syntax
        // errors. Doing it first means we can show a clean error instead of
        // a half-rendered SVG when the LLM/heuristic outputs something
        // mermaid can't read.
        await mermaid.parse(source);

        const { svg: rendered } = await mermaid.render(elementId, source);
        if (!cancelled) {
          setSvg(rendered);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to render diagram.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [elementId, resolvedTheme, source]);

  if (error) {
    return <MermaidFallback message={error} source={source} className={className} />;
  }

  if (!svg) {
    return (
      <div className={cn("flex flex-col gap-3", className)} role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Rendering diagram…</span>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  return (
    <ScrollArea
      className={cn("mermaid-render w-max min-w-full rounded-md border border-border bg-background", className)}
    >
      <div
        // SVG is produced by mermaid using `securityLevel: 'strict'`, which
        // sanitises user input. Even so, this string is sourced from our own
        // generator on the backend, not from arbitrary user typing.
        dangerouslySetInnerHTML={{ __html: svg }}
        className="p-3 [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-none"
        role="img"
        aria-label="Architecture diagram"
      />
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

function MermaidFallback({ message, source, className }: { message: string; source: string; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 font-medium text-destructive">
        <WarningCircleIcon size={14} weight="bold" />
        <span>Failed to render diagram.</span>
      </div>
      <p className="text-destructive/80">{message}</p>
      <details className="text-muted-foreground">
        <summary className="cursor-pointer select-none">Show diagram source</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] leading-snug">
          {source}
        </pre>
      </details>
    </div>
  );
}

/**
 * `useTheme()` returns `'system'` as one of three values; for Mermaid we need
 * a concrete `'light' | 'dark'`. We mirror the resolution that ThemeProvider
 * applies to `<html class>` so the diagram and the surrounding chrome stay in
 * lockstep when the system preference flips at runtime.
 */
function useResolvedTheme(theme: ReturnType<typeof useTheme>["theme"]): "light" | "dark" {
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme]);

  if (theme === "system") {
    return systemTheme;
  }
  return theme;
}

interface MermaidErrorBoundaryState {
  error: Error | null;
}

/**
 * Class-based error boundary because hooks-based error trapping (`try/catch`
 * inside `useEffect`) only catches async errors. A render-time crash inside
 * `dangerouslySetInnerHTML` or future custom node renderers needs the React
 * error boundary lifecycle to reach.
 */
class MermaidErrorBoundary extends Component<{ children: ReactNode; source: string }, MermaidErrorBoundaryState> {
  state: MermaidErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): MermaidErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // Log via console.warn intentionally — the parent ArtifactPanel doesn't
    // need to know about every render failure, but we want a breadcrumb in
    // dev tools when a generator regression slips out.
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("MermaidRenderer error boundary caught", error);
    }
  }

  componentDidUpdate(prevProps: Readonly<{ children: ReactNode; source: string }>): void {
    if (this.state.error && prevProps.source !== this.props.source) {
      // Allow retry when the underlying artifact content changes.
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <MermaidFallback message={this.state.error.message || "Failed to render diagram."} source={this.props.source} />
      );
    }
    return this.props.children;
  }
}
