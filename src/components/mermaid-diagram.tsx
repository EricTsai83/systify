import type { MermaidConfig } from "mermaid";
import { Info, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

export interface MermaidRepairRequest {
  chart: string;
  error: string;
}

interface MermaidDiagramProps {
  chart: string;
  isIncomplete?: boolean;
  meta?: string;
  onRepair?: (request: MermaidRepairRequest) => Promise<void>;
}

type MermaidRenderResult = {
  svg: string;
  bindFunctions?: (element: Element) => void;
};

type RenderState =
  | { status: "idle" | "loading" }
  | { status: "success"; svg: string; bindFunctions?: (element: Element) => void }
  | { status: "error"; message: string };

type DiagramMeta = {
  caption?: string;
  title?: string;
};

const DEFAULT_MERMAID_CONFIG: MermaidConfig = {
  fontFamily: "JetBrains Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace",
  securityLevel: "strict",
  startOnLoad: false,
  suppressErrorRendering: true,
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

const subscribeToThemeClass = (callback: () => void) => {
  if (typeof document === "undefined") {
    return () => {};
  }

  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributeFilter: ["class"],
    attributes: true,
  });

  return () => observer.disconnect();
};

function getResolvedMermaidTheme(): "dark" | "default" {
  if (typeof document === "undefined") {
    return "default";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "default";
}

function getServerMermaidTheme(): "dark" | "default" {
  return "default";
}

function parseMermaidFenceMeta(meta?: string): DiagramMeta {
  if (!meta) {
    return {};
  }

  const result: DiagramMeta = {};
  const attributePattern = /(?:^|\s)(title|caption)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match = attributePattern.exec(meta);

  while (match) {
    const key = match[1];
    if (key === "title" || key === "caption") {
      const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
      if (value) {
        result[key] = value;
      }
    }
    match = attributePattern.exec(meta);
  }

  return result;
}

export function MermaidDiagram({ chart, isIncomplete = false, meta, onRepair }: MermaidDiagramProps) {
  const { title, caption } = useMemo(() => parseMermaidFenceMeta(meta), [meta]);
  const normalizedChart = useMemo(() => chart.replace(/\n+$/u, ""), [chart]);
  const renderState = useMermaidRender(normalizedChart, isIncomplete);

  if (isIncomplete) {
    return (
      <div className="my-4 border border-border bg-card p-4 text-sm text-muted-foreground">
        Mermaid diagram is still streaming...
      </div>
    );
  }

  if (renderState.status === "error") {
    return <MermaidRenderError chart={normalizedChart} error={renderState.message} onRepair={onRepair} />;
  }

  return (
    <MermaidFrame title={title} caption={caption} isLoading={renderState.status !== "success"}>
      {renderState.status === "success" ? (
        <SvgViewer
          svgHtml={renderState.svg}
          title={title}
          caption={caption}
          bindFunctions={renderState.bindFunctions}
        />
      ) : (
        <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
          <span className="mr-2 size-4 animate-spin rounded-full border border-muted-foreground/30 border-b-muted-foreground" />
          Rendering diagram...
        </div>
      )}
    </MermaidFrame>
  );
}

function useMermaidRender(chart: string, isIncomplete: boolean): RenderState {
  const reactId = useId();
  const idBase = useMemo(() => reactId.replace(/[^a-zA-Z0-9_-]/g, ""), [reactId]);
  const theme = useSyncExternalStore(subscribeToThemeClass, getResolvedMermaidTheme, getServerMermaidTheme);
  const [state, setState] = useState<RenderState>({ status: "idle" });

  useEffect(() => {
    if (isIncomplete || !chart.trim()) {
      setState({ status: "idle" });
      return;
    }

    let isActive = true;
    setState({ status: "loading" });

    const render = async () => {
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;
        const renderId = `systify-mermaid-${idBase}-${Math.random().toString(36).slice(2)}`;

        mermaid.initialize({
          ...DEFAULT_MERMAID_CONFIG,
          theme,
        });

        const result = (await mermaid.render(renderId, chart)) as MermaidRenderResult;
        if (isActive) {
          setState({
            status: "success",
            svg: result.svg,
            bindFunctions: result.bindFunctions,
          });
        }
      } catch (caught) {
        if (!isActive) {
          return;
        }
        setState({
          status: "error",
          message:
            caught instanceof Error && caught.message.trim() ? caught.message : "Failed to render Mermaid diagram.",
        });
      }
    };

    void render();

    return () => {
      isActive = false;
    };
  }, [chart, idBase, isIncomplete, theme]);

  return state;
}

function MermaidFrame({
  title,
  caption,
  isLoading,
  children,
}: {
  title?: string;
  caption?: string;
  isLoading: boolean;
  children: ReactNode;
}) {
  const heading = title?.trim() || "Mermaid diagram";

  return (
    <figure className="my-4 overflow-hidden border border-border bg-card text-card-foreground">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border bg-muted/45 px-3 py-2">
        <figcaption className="min-w-0 truncate font-mono text-xs font-semibold uppercase text-foreground">
          {heading}
        </figcaption>
        <div className="flex shrink-0 items-center gap-2">
          {caption?.trim() ? <CaptionInfo caption={caption} /> : null}
          {isLoading ? <span className="font-mono text-[10px] uppercase text-muted-foreground">Loading</span> : null}
        </div>
      </div>
      {children}
    </figure>
  );
}

function CaptionInfo({ caption }: { caption: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={caption}
            className="inline-flex size-7 items-center justify-center border border-transparent text-muted-foreground"
            role="img"
          >
            <Info className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{caption}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type ZoomActions = {
  reset: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
};

function SvgViewer({
  svgHtml,
  title,
  caption,
  bindFunctions,
}: {
  svgHtml: string;
  title?: string;
  caption?: string;
  bindFunctions?: (element: Element) => void;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const inlineActionsRef = useRef<ZoomActions | null>(null);
  const fullscreenActionsRef = useRef<ZoomActions | null>(null);
  const label = title?.trim() ? `${title} diagram` : "Mermaid diagram";

  useEffect(() => {
    if (!isFullscreen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFullscreen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  const overlay =
    isFullscreen && typeof document !== "undefined"
      ? createPortal(
          <div
            aria-label={label}
            aria-modal="true"
            className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
            role="dialog"
          >
            <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border bg-card px-4">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs font-semibold uppercase">
                  {title?.trim() || "Mermaid diagram"}
                </p>
                {caption?.trim() ? <p className="truncate text-xs text-muted-foreground">{caption}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ViewerToolbar actionsRef={fullscreenActionsRef} />
                <TooltipIconButton label="Close diagram" onClick={() => setIsFullscreen(false)} className="size-8 p-0">
                  <X className="size-4" />
                </TooltipIconButton>
              </div>
            </div>
            <ZoomableViewport actionsRef={fullscreenActionsRef} className="min-h-0 flex-1" interactive wheelZoomEnabled>
              <SvgMount
                svgHtml={svgHtml}
                bindFunctions={bindFunctions}
                ariaLabel={label}
                className="mermaid-diagram-svg mermaid-diagram-svg-fullscreen"
              />
            </ZoomableViewport>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="border-b border-border bg-background/70 px-3 py-2">
        <div className="flex items-center justify-end">
          <TooltipIconButton
            label="View diagram fullscreen"
            onClick={() => setIsFullscreen(true)}
            className="size-8 p-0"
          >
            <Maximize2 className="size-4" />
          </TooltipIconButton>
        </div>
      </div>
      <ZoomableViewport actionsRef={inlineActionsRef} className="min-h-48" interactive={false} wheelZoomEnabled={false}>
        <SvgMount svgHtml={svgHtml} bindFunctions={bindFunctions} ariaLabel={label} className="mermaid-diagram-svg" />
      </ZoomableViewport>
      {overlay}
    </>
  );
}

function ViewerToolbar({ actionsRef }: { actionsRef: RefObject<ZoomActions | null> }) {
  return (
    <>
      <TooltipIconButton label="Zoom in" onClick={() => actionsRef.current?.zoomIn()} className="size-8 p-0">
        <ZoomIn className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton label="Zoom out" onClick={() => actionsRef.current?.zoomOut()} className="size-8 p-0">
        <ZoomOut className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton label="Reset diagram view" onClick={() => actionsRef.current?.reset()} className="size-8 p-0">
        <RotateCcw className="size-4" />
      </TooltipIconButton>
    </>
  );
}

function ZoomableViewport({
  children,
  actionsRef,
  className,
  interactive,
  wheelZoomEnabled,
}: {
  children: ReactNode;
  actionsRef: RefObject<ZoomActions | null>;
  className?: string;
  interactive: boolean;
  wheelZoomEnabled: boolean;
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  const pendingViewRef = useRef<typeof view | null>(null);
  const viewFrameRef = useRef<number | null>(null);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    return () => {
      if (viewFrameRef.current !== null) {
        cancelAnimationFrame(viewFrameRef.current);
        viewFrameRef.current = null;
      }
    };
  }, []);

  const clearScheduledView = useCallback(() => {
    pendingViewRef.current = null;
    if (viewFrameRef.current !== null) {
      cancelAnimationFrame(viewFrameRef.current);
      viewFrameRef.current = null;
    }
  }, []);

  const commitView = useCallback(
    (next: typeof view) => {
      clearScheduledView();
      viewRef.current = next;
      setView(next);
    },
    [clearScheduledView],
  );

  const scheduleView = useCallback((next: typeof view) => {
    viewRef.current = next;
    pendingViewRef.current = next;
    if (viewFrameRef.current !== null) return;

    viewFrameRef.current = requestAnimationFrame(() => {
      viewFrameRef.current = null;
      const pending = pendingViewRef.current;
      if (pending === null) return;
      pendingViewRef.current = null;
      viewRef.current = pending;
      setView(pending);
    });
  }, []);

  const flushScheduledView = useCallback(() => {
    const pending = pendingViewRef.current;
    if (pending === null) return;
    clearScheduledView();
    viewRef.current = pending;
    setView(pending);
  }, [clearScheduledView]);

  const clampScale = useCallback((scale: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale)), []);

  const zoomFromViewportCenter = useCallback(
    (nextScale: number) => {
      const current = viewRef.current;
      commitView({
        ...current,
        scale: clampScale(nextScale),
      });
    },
    [clampScale, commitView],
  );

  const zoomFromCenter = useCallback(
    (direction: 1 | -1) => {
      zoomFromViewportCenter(view.scale + ZOOM_STEP * direction);
    },
    [view.scale, zoomFromViewportCenter],
  );

  const reset = useCallback(() => commitView({ scale: 1, x: 0, y: 0 }), [commitView]);

  useEffect(() => {
    actionsRef.current = {
      reset,
      zoomIn: () => zoomFromCenter(1),
      zoomOut: () => zoomFromCenter(-1),
    };
    return () => {
      actionsRef.current = null;
    };
  }, [actionsRef, reset, zoomFromCenter]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!wheelZoomEnabled) {
        return;
      }
      event.preventDefault();
      const nextScale = view.scale + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
      zoomFromViewportCenter(nextScale);
    },
    [view.scale, wheelZoomEnabled, zoomFromViewportCenter],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!interactive || event.button !== 0) {
        return;
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: viewRef.current.x,
        y: viewRef.current.y,
      };
      setIsDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [interactive],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      scheduleView({
        ...viewRef.current,
        x: drag.x + event.clientX - drag.startX,
        y: drag.y + event.clientY - drag.startY,
      });
    },
    [scheduleView],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        flushScheduledView();
        dragRef.current = null;
        setIsDragging(false);
      }
    },
    [flushScheduledView],
  );

  return (
    <div
      className={cn(
        "relative flex overflow-hidden bg-background",
        interactive ? "cursor-grab touch-none active:cursor-grabbing" : "touch-auto",
        className,
      )}
      data-mermaid-viewport={interactive ? "fullscreen" : "inline"}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      ref={outerRef}
    >
      <div
        className="flex min-h-full w-full origin-center items-center justify-center p-4"
        data-mermaid-viewport-content
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: "center center",
          transition: isDragging ? "none" : "transform 120ms ease-out",
          userSelect: interactive ? "none" : undefined,
          willChange: interactive ? "transform" : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function SvgMount({
  svgHtml,
  bindFunctions,
  ariaLabel,
  className,
}: {
  svgHtml: string;
  bindFunctions?: (element: Element) => void;
  ariaLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }

    bindFunctions?.(node);

    const svg = node.querySelector("svg");
    if (svg instanceof SVGSVGElement) {
      svg.setAttribute("draggable", "false");
      svg.setAttribute("height", "100%");
      svg.style.maxHeight = "100%";
      svg.style.maxWidth = "100%";
    }
  }, [bindFunctions, svgHtml]);

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "flex size-full items-center justify-center text-foreground [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:max-w-full",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svgHtml }}
      ref={ref}
      role="img"
    />
  );
}

function MermaidRenderError({
  chart,
  error,
  onRepair,
}: {
  chart: string;
  error: string;
  onRepair?: (request: MermaidRepairRequest) => Promise<void>;
}) {
  const [isRepairing, setIsRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  const handleRepair = async () => {
    if (!onRepair || isRepairing) {
      return;
    }

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
    <div className="my-4 border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-destructive">Mermaid diagram could not render.</p>
          <p className="mt-1 break-words text-muted-foreground">{error}</p>
          {repairError ? <p className="mt-2 break-words text-xs text-destructive">{repairError}</p> : null}
        </div>
        {onRepair ? (
          <Button
            className="shrink-0"
            disabled={isRepairing}
            onClick={() => void handleRepair()}
            size="sm"
            type="button"
            variant="outline"
          >
            {isRepairing ? "Repairing..." : "Repair diagram"}
          </Button>
        ) : null}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">View Mermaid source</summary>
        <pre className="mt-2 max-h-64 overflow-auto border border-border bg-muted p-3 text-xs text-muted-foreground">
          <code>{chart}</code>
        </pre>
      </details>
    </div>
  );
}
