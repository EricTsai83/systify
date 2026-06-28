import { memo, isValidElement, useCallback, useMemo, useState, type ReactNode } from "react";
import type { AllowedTags, Components } from "streamdown";
import type { Doc } from "../../convex/_generated/dataModel";
import { Message, MessageContent, MessageActions, MessageAction } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { LocalEditorSetupDialog } from "@/components/local-editor-setup-dialog";
import { ToolCallTrace } from "@/components/tool-call-trace";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/markdown";
import { useClipboard } from "@/hooks/use-clipboard";
import { CITATION_TOKEN_REGEX, prepareAssistantMarkdown } from "@/lib/assistant-markdown";
import {
  buildEditorUrl,
  openEditorUrl,
  readLocalEditorConfig,
  removeLocalEditorConfig,
  type LocalEditorRepositoryConfig,
} from "@/lib/local-editor";
import {
  buildGitHubSourceUrl,
  formatCodeFileRanges,
  parseCodeFileSources,
  type CodeFileSource,
} from "@/lib/source-citations";
import type { ActiveMessageStream, ArtifactId, RepositorySource } from "@/lib/types";
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  CpuIcon,
  FileCodeIcon,
  FileTextIcon,
  GearSixIcon,
  GithubLogoIcon,
  HashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

/**
 * Derive the grounding chip label from a persisted assistant message.
 *
 * Returns one of:
 *   - `"Library + Sandbox"` — both grounding flags on
 *   - `"Library"` — only library grounding
 *   - `"Sandbox"` — only sandbox grounding
 *   - `null` — ungrounded Discuss replies and user messages
 *
 * Library-mode rows do not need a mode badge; the Library page already
 * provides that context. Discuss-mode grounding chips remain useful because
 * they explain which optional grounding axes produced the reply.
 */
function deriveGroundingChip(message: Doc<"messages">): string | null {
  if (message.role !== "assistant") {
    return null;
  }
  if (message.mode === "library") {
    return null;
  }
  const groundLibrary = message.groundLibrary === true;
  const groundSandbox = message.groundSandbox === true;
  if (groundLibrary && groundSandbox) {
    return "Library + Sandbox";
  }
  if (groundLibrary) {
    return "Library";
  }
  if (groundSandbox) {
    return "Sandbox";
  }
  return null;
}

/**
 * Custom tags the assistant markdown pass keeps through streamdown's
 * sanitizer. The empty arrays mean no attributes are allowed on either
 * tag — `CitationRef` / `UnverifiedMark` derive everything they need
 * from the tag's children, never from attributes. Module-level so the
 * reference stays stable across renders.
 */
const ASSISTANT_ALLOWED_TAGS: AllowedTags = { citation: [], unverified: [] };

type MessageBubbleViewModel = {
  fromRole: "system" | "user" | "assistant";
  isAssistant: boolean;
  isInFlight: boolean;
  isLiveStream: boolean;
  displayContent: string;
  statusLabel: string | null;
  groundingChip: string | null;
  showHeader: boolean;
  isTerminalSystemError: boolean;
  isSystemErrorOnly: boolean;
  errorMessage: string | null;
  reasoning: {
    content: string | null;
    isStreaming: boolean;
    durationSeconds: number | undefined;
  };
  usage: {
    costTicker: string | null;
    tickerAriaLabel: string;
    nerdStats: ReactNode | null;
  };
  markdown: {
    prepared: string;
    unverifiedClaims: Doc<"messages">["unverifiedClaims"] | undefined;
  };
};

function buildMessageBubbleViewModel(
  message: Doc<"messages">,
  activeMessageStream: ActiveMessageStream | null,
  showStatsForNerds: boolean,
): MessageBubbleViewModel {
  const isAssistant = message.role === "assistant";
  const fromRole: "system" | "user" | "assistant" = message.role === "tool" ? "assistant" : message.role;
  const statusLabel = getMessageStatusLabel(message.status);
  const isInFlight = message.status === "streaming" || message.status === "pending";
  const isLiveStream = isAssistant && activeMessageStream?.assistantMessageId === message._id;
  const displayContent = isLiveStream ? activeMessageStream.content || message.content : message.content;
  const isTerminalSystemError =
    isAssistant &&
    (message.status === "failed" || message.status === "cancelled") &&
    message.errorMessage !== undefined &&
    message.errorMessage.trim().length > 0;
  const errorMessage = message.errorMessage?.trim() ? message.errorMessage : null;
  const isSystemErrorOnly =
    isTerminalSystemError && errorMessage !== null && errorMessage.trim() === displayContent.trim();
  const groundingChip = deriveGroundingChip(message);
  const unverifiedClaims = isAssistant && !isInFlight ? message.unverifiedClaims : undefined;
  const costTicker = isAssistant && !isInFlight ? buildCostTickerLabel(message) : null;
  const tickerAriaLabel =
    costTicker === null
      ? "Cost information"
      : message.estimatedCostUsd !== undefined
        ? `Reply cost ${costTicker}`
        : `Usage ${costTicker}`;
  const reasoningContent = isAssistant
    ? isLiveStream
      ? (activeMessageStream?.reasoning ?? null)
      : (message.reasoning ?? null)
    : null;
  const isReasoningStreaming = Boolean(
    isAssistant &&
    isLiveStream &&
    activeMessageStream &&
    activeMessageStream.reasoningStartedAt !== null &&
    activeMessageStream.reasoningEndedAt === null,
  );
  const nerdStats =
    isAssistant && showStatsForNerds ? buildNerdStats(message, displayContent, activeMessageStream) : null;

  return {
    fromRole,
    isAssistant,
    isInFlight,
    isLiveStream,
    displayContent,
    statusLabel,
    groundingChip,
    showHeader: groundingChip !== null || statusLabel !== null,
    isTerminalSystemError,
    isSystemErrorOnly,
    errorMessage,
    reasoning: {
      content: reasoningContent,
      isStreaming: isReasoningStreaming,
      durationSeconds: isAssistant
        ? computeReasoningDurationSeconds(message, activeMessageStream, isLiveStream)
        : undefined,
    },
    usage: {
      costTicker,
      tickerAriaLabel,
      nerdStats: nerdStats ? (
        <MessageNerdStats stats={nerdStats} costTicker={costTicker} tickerAriaLabel={tickerAriaLabel} />
      ) : null,
    },
    markdown: {
      prepared: isAssistant ? prepareAssistantMarkdown(displayContent, unverifiedClaims) : "",
      unverifiedClaims,
    },
  };
}

/**
 * One assistant- or user-message bubble. Pure presentational: every
 * piece of content (mode badge, status label, cost ticker, citation
 * buttons, unverified-claim highlights) is derived from the persisted
 * `Doc<"messages">` plus an optional in-flight `activeMessageStream`,
 * so the bubble re-renders correctly whether the message is mid-stream
 * or terminal.
 *
 * Lives in its own module so the panel shell does not have to import
 * the full citation / cost-ticker rendering pipeline; the panel only
 * cares about the bubble's identity and click handlers.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  activeMessageStream,
  onSelectArtifact,
  repositorySource,
  showStatsForNerds = false,
}: {
  message: Doc<"messages">;
  activeMessageStream: ActiveMessageStream | null;
  onSelectArtifact?: (artifactId: ArtifactId) => void;
  repositorySource?: RepositorySource;
  showStatsForNerds?: boolean;
}) {
  const viewModel = buildMessageBubbleViewModel(message, activeMessageStream, showStatsForNerds);
  const codeSources = useMemo(
    () =>
      viewModel.isAssistant && message.groundSandbox === true ? parseCodeFileSources(viewModel.displayContent) : [],
    [message.groundSandbox, viewModel.displayContent, viewModel.isAssistant],
  );
  // Custom-tag renderers for the markdown pass, bound to *this* message's
  // citation map and the artifact-select handler. Memoized so streamdown's
  // per-block memo isn't busted on every unrelated re-render of the bubble.
  const markdownComponents = useMemo<Components>(() => {
    const indexToArtifactId = new Map<number, ArtifactId>();
    for (const entry of message.citationMap ?? []) {
      indexToArtifactId.set(entry.index, entry.artifactId);
    }
    return {
      citation: ({ children }) => (
        <CitationRef indexToArtifactId={indexToArtifactId} onSelectArtifact={onSelectArtifact}>
          {children as ReactNode}
        </CitationRef>
      ),
      unverified: ({ children }) => <UnverifiedMark>{children as ReactNode}</UnverifiedMark>,
    };
  }, [message.citationMap, onSelectArtifact]);
  return (
    // `Message` (ai-elements) handles the role-based alignment (user →
    // right, assistant → left) and constrains bubble width to max-w-95%.
    // Cost ticker sits BELOW `MessageContent` for the same reason.
    <Message from={viewModel.fromRole}>
      <MessageBubbleHeader
        groundingChip={viewModel.groundingChip}
        statusLabel={viewModel.statusLabel}
        isInFlight={viewModel.isInFlight}
      />
      <MessageReasoningBlock reasoning={viewModel.reasoning} />
      <MessageContent>
        <MessageBodyContent viewModel={viewModel} message={message} markdownComponents={markdownComponents} />
        {viewModel.isAssistant ? (
          <MessageSources
            citationMap={message.citationMap}
            codeSources={codeSources}
            onSelectArtifact={onSelectArtifact}
            repositorySource={repositorySource}
          />
        ) : null}
        {viewModel.isAssistant ? (
          <ToolCallTrace
            messageId={message._id}
            persistedToolCalls={message.toolCalls}
            isStreaming={message.status === "streaming"}
          />
        ) : null}
      </MessageContent>
      {/*
       * Reserve a fixed-height slot under every assistant bubble so the
       * streaming → completed handoff (when the cost ticker becomes
       * available) doesn't push subsequent messages down by ~28px each
       * time a reply settles. The row hosts both the cost ticker (left)
       * and the copy action (right), reserving space for the action
       * even when streaming so no shift occurs when the action becomes
       * visible on completion.
       */}
      {viewModel.isAssistant ? (
        <MessageUsageFooter
          isInFlight={viewModel.isInFlight}
          costTicker={viewModel.usage.costTicker}
          nerdStats={viewModel.usage.nerdStats}
          tickerAriaLabel={viewModel.usage.tickerAriaLabel}
          content={viewModel.displayContent}
        />
      ) : null}
    </Message>
  );
});

function MessageBubbleHeader({
  groundingChip,
  statusLabel,
  isInFlight,
}: {
  groundingChip: string | null;
  statusLabel: string | null;
  isInFlight: boolean;
}) {
  if (groundingChip === null && statusLabel === null) {
    return null;
  }
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <div className="flex items-center gap-2">
        {groundingChip ? (
          <Badge
            variant="muted"
            className="border-transparent px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider"
            data-testid="message-grounding-badge"
          >
            {groundingChip}
          </Badge>
        ) : null}
      </div>
      {statusLabel ? (
        isInFlight ? (
          <Shimmer as="p" className="text-[10px]" duration={1.6}>
            {statusLabel}
          </Shimmer>
        ) : (
          <p className="text-[10px] text-muted-foreground">{statusLabel}</p>
        )
      ) : null}
    </div>
  );
}

function MessageReasoningBlock({ reasoning }: { reasoning: MessageBubbleViewModel["reasoning"] }) {
  if (!reasoning.content && !reasoning.isStreaming) {
    return null;
  }
  return (
    <div data-testid="message-reasoning" className="px-1">
      <Reasoning isStreaming={reasoning.isStreaming} duration={reasoning.durationSeconds} defaultOpen={false}>
        <ReasoningTrigger />
        <ReasoningContent>{reasoning.content ?? ""}</ReasoningContent>
      </Reasoning>
    </div>
  );
}

function MessageBodyContent({
  viewModel,
  message,
  markdownComponents,
}: {
  viewModel: MessageBubbleViewModel;
  message: Doc<"messages">;
  markdownComponents: Components;
}) {
  return (
    <>
      {viewModel.isSystemErrorOnly ? (
        <SystemErrorNotice status={message.status} message={viewModel.errorMessage ?? ""} />
      ) : viewModel.isAssistant ? (
        viewModel.displayContent ? (
          <Markdown
            className="text-sm leading-6"
            isAnimating={message.status === "streaming"}
            allowedTags={ASSISTANT_ALLOWED_TAGS}
            components={markdownComponents}
          >
            {viewModel.markdown.prepared}
          </Markdown>
        ) : (
          <p className="text-sm leading-6">…</p>
        )
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6">{viewModel.displayContent || "…"}</p>
      )}
      {viewModel.isTerminalSystemError && !viewModel.isSystemErrorOnly ? (
        <SystemErrorNotice status={message.status} message={viewModel.errorMessage ?? ""} />
      ) : null}
    </>
  );
}

type CitationMapEntry = NonNullable<Doc<"messages">["citationMap"]>[number];

type LibraryDocumentSource = {
  artifactId: ArtifactId;
  title: string;
  indexesLabel: string;
  secondary: string | null;
};

function MessageSources({
  citationMap,
  codeSources,
  onSelectArtifact,
  repositorySource,
}: {
  citationMap: Doc<"messages">["citationMap"] | undefined;
  codeSources: CodeFileSource[];
  onSelectArtifact?: (artifactId: ArtifactId) => void;
  repositorySource?: RepositorySource;
}) {
  const librarySources = useMemo(() => buildLibraryDocumentSources(citationMap), [citationMap]);
  const [actionSource, setActionSource] = useState<CodeFileSource | null>(null);
  const [setupSource, setSetupSource] = useState<CodeFileSource | null>(null);
  const [, refreshLocalEditorConfig] = useState(0);
  const localEditorConfig = repositorySource ? readLocalEditorConfig(repositorySource.repositoryId) : null;

  const openCodeSourceWithConfig = useCallback(
    (source: CodeFileSource, config: LocalEditorRepositoryConfig): boolean => {
      const firstRange = source.ranges[0];
      if (!firstRange) {
        return false;
      }
      try {
        openEditorUrl(
          buildEditorUrl({
            editor: config.editor,
            rootPath: config.rootPath,
            relativePath: source.path,
            line: firstRange.startLine,
          }),
        );
        return true;
      } catch {
        setActionSource(source);
        return false;
      }
    },
    [],
  );

  const handleCodeSourceClick = useCallback(
    (source: CodeFileSource) => {
      if (localEditorConfig && openCodeSourceWithConfig(source, localEditorConfig)) {
        return;
      }
      setActionSource(source);
    },
    [localEditorConfig, openCodeSourceWithConfig],
  );

  const handleClearLocalPath = useCallback(() => {
    if (!repositorySource) {
      return;
    }
    removeLocalEditorConfig(repositorySource.repositoryId);
    refreshLocalEditorConfig((revision) => revision + 1);
  }, [repositorySource]);

  if (librarySources.length === 0 && codeSources.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 border-t border-border/70 pt-3" data-testid="message-sources">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sources</p>
      <div className="grid gap-3">
        {librarySources.length > 0 ? (
          <SourceSection title="Library documents">
            {librarySources.map((source) => (
              <LibrarySourceButton key={source.artifactId} source={source} onSelectArtifact={onSelectArtifact} />
            ))}
          </SourceSection>
        ) : null}
        {codeSources.length > 0 ? (
          <SourceSection title="Code files">
            {codeSources.map((source) => (
              <CodeSourceButton key={source.path} source={source} onOpen={handleCodeSourceClick} />
            ))}
          </SourceSection>
        ) : null}
      </div>
      <CodeSourceActionsDialog
        source={actionSource}
        repositorySource={repositorySource}
        localEditorConfig={localEditorConfig}
        onOpenLocal={(source, config) => {
          if (openCodeSourceWithConfig(source, config)) {
            setActionSource(null);
          }
        }}
        onClearLocalPath={handleClearLocalPath}
        onOpenChange={(open) => {
          if (!open) setActionSource(null);
        }}
        onSetLocalPath={() => {
          setSetupSource(actionSource);
          setActionSource(null);
        }}
      />
      {setupSource ? (
        <LocalEditorSetupDialog
          open
          onOpenChange={(open) => {
            if (!open) setSetupSource(null);
          }}
          repositoryId={repositorySource?.repositoryId ?? null}
          initialConfig={localEditorConfig}
          onSaved={(config) => {
            refreshLocalEditorConfig((revision) => revision + 1);
            if (setupSource) {
              openCodeSourceWithConfig(setupSource, config);
            }
            setSetupSource(null);
          }}
        />
      ) : null}
    </div>
  );
}

function SourceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5" aria-label={title}>
      <p className="text-xs font-medium text-foreground">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function LibrarySourceButton({
  source,
  onSelectArtifact,
}: {
  source: LibraryDocumentSource;
  onSelectArtifact?: (artifactId: ArtifactId) => void;
}) {
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <FileTextIcon size={14} weight="bold" className="shrink-0 text-primary" />
        <span className="truncate font-medium">{source.title}</span>
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{source.indexesLabel}</span>
      {source.secondary ? (
        <span className="basis-full truncate text-left text-[11px] text-muted-foreground">{source.secondary}</span>
      ) : null}
    </>
  );

  const className =
    "inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border border-border bg-background px-2 py-1.5 text-left text-xs text-foreground";

  if (!onSelectArtifact) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      type="button"
      className={`${className} transition-colors hover:border-primary/40 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
      onClick={() => onSelectArtifact(source.artifactId)}
    >
      {content}
    </button>
  );
}

function CodeSourceButton({ source, onOpen }: { source: CodeFileSource; onOpen: (source: CodeFileSource) => void }) {
  return (
    <button
      type="button"
      className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border border-border bg-background px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={() => onOpen(source)}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <FileCodeIcon size={14} weight="bold" className="shrink-0 text-primary" />
        <span className="truncate font-medium">{source.basename}</span>
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{formatCodeFileRanges(source.ranges)}</span>
      <span className="basis-full truncate text-left text-[11px] text-muted-foreground">{source.path}</span>
    </button>
  );
}

function CodeSourceActionsDialog({
  source,
  repositorySource,
  localEditorConfig,
  onOpenLocal,
  onClearLocalPath,
  onOpenChange,
  onSetLocalPath,
}: {
  source: CodeFileSource | null;
  repositorySource: RepositorySource | undefined;
  localEditorConfig: LocalEditorRepositoryConfig | null;
  onOpenLocal: (source: CodeFileSource, config: LocalEditorRepositoryConfig) => void;
  onClearLocalPath: () => void;
  onOpenChange: (open: boolean) => void;
  onSetLocalPath: () => void;
}) {
  const { copied, copy } = useClipboard({ resetAfterMs: 1500 });
  const firstRange = source?.ranges[0];
  const gitHubRef = repositorySource?.lastSyncedCommitSha ?? repositorySource?.defaultBranch ?? null;
  const gitHubUrl =
    source && firstRange && repositorySource && gitHubRef
      ? buildGitHubSourceUrl({
          sourceRepoFullName: repositorySource.sourceRepoFullName,
          ref: gitHubRef,
          path: source.path,
          startLine: firstRange.startLine,
          endLine: firstRange.endLine,
        })
      : null;

  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      {source ? (
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Open code source</DialogTitle>
            <DialogDescription className="break-all">{source.path}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {localEditorConfig ? (
              <Button
                type="button"
                variant="secondary"
                className="justify-start"
                onClick={() => {
                  onOpenLocal(source, localEditorConfig);
                }}
              >
                <FileCodeIcon weight="bold" />
                Open locally
              </Button>
            ) : null}
            {repositorySource ? (
              <Button type="button" variant="secondary" className="justify-start" onClick={onSetLocalPath}>
                <GearSixIcon weight="bold" />
                {localEditorConfig ? "Change local path" : "Set local path"}
              </Button>
            ) : null}
            {repositorySource && localEditorConfig ? (
              <Button type="button" variant="ghost" className="justify-start" onClick={onClearLocalPath}>
                <GearSixIcon weight="bold" />
                Forget local path
              </Button>
            ) : null}
            {gitHubUrl ? (
              <Button
                type="button"
                variant="ghost"
                className="justify-start"
                onClick={() => {
                  window.open(gitHubUrl, "_blank", "noopener,noreferrer");
                  onOpenChange(false);
                }}
              >
                <GithubLogoIcon weight="bold" />
                Open on GitHub
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                void copy(source.path);
              }}
            >
              {copied ? <CheckIcon weight="bold" /> : <CopyIcon weight="bold" />}
              {copied ? "Copied" : "Copy path"}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function buildLibraryDocumentSources(citationMap: Doc<"messages">["citationMap"] | undefined): LibraryDocumentSource[] {
  const groups = new Map<ArtifactId, { entries: CitationMapEntry[] }>();
  for (const entry of citationMap ?? []) {
    const artifactId = entry.artifactId;
    const group = groups.get(artifactId) ?? { entries: [] };
    group.entries.push(entry);
    groups.set(artifactId, group);
  }

  return [...groups.entries()].map(([artifactId, group]) => {
    const first = group.entries[0];
    const title = first?.artifactTitle?.trim() || "Referenced artifact";
    const headingPath = group.entries.find((entry) => entry.headingPath && entry.headingPath.length > 0)?.headingPath;
    const kind = group.entries.find((entry) => entry.artifactKind !== undefined)?.artifactKind;
    const kindLabel = kind ? formatArtifactKindLabel(kind) : null;
    const secondary =
      headingPath && headingPath.length > 0
        ? headingPath.join(" > ")
        : kindLabel && kindLabel !== title
          ? kindLabel
          : null;
    return {
      artifactId,
      title,
      indexesLabel: `[${group.entries.map((entry) => `A${entry.index}`).join(", ")}]`,
      secondary,
    };
  });
}

function formatArtifactKindLabel(kind: string): string {
  return kind
    .split("_")
    .map((word) => {
      const upper = word.toUpperCase();
      if (upper === "API" || upper === "README") {
        return upper;
      }
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function MessageUsageFooter({
  isInFlight,
  costTicker,
  nerdStats,
  tickerAriaLabel,
  content,
}: {
  isInFlight: boolean;
  costTicker: string | null;
  nerdStats: ReactNode | null;
  tickerAriaLabel: string;
  content: string;
}) {
  return (
    <div className="min-h-8" data-testid="message-usage-footer">
      <div className="-mt-1! -ml-0.5 flex w-full flex-row justify-start gap-1 opacity-100 transition-opacity select-none md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 md:group-focus:opacity-100 md:group-has-aria-[describedby]:opacity-100 md:group-has-data-[state='delayed-open']:opacity-100 md:group-has-data-[state='instant-open']:opacity-100 print:hidden">
        <div className="flex min-h-8 w-full items-center justify-between gap-3 px-2 py-1">
          <div className="min-w-0 flex-1">
            {nerdStats ? (
              nerdStats
            ) : costTicker ? (
              <p
                className="truncate text-[13px] font-medium text-muted-foreground/90 tabular-nums"
                data-testid="message-cost-ticker"
                aria-label={tickerAriaLabel}
              >
                {costTicker}
              </p>
            ) : null}
          </div>
          <MessageCopyActions isInFlight={isInFlight} content={content} />
        </div>
      </div>
    </div>
  );
}

function MessageNerdStats({
  stats,
  costTicker,
  tickerAriaLabel,
}: {
  stats: {
    model: string;
    messageTokens: string;
    timeToFirstToken: string | null;
  };
  costTicker: string | null;
  tickerAriaLabel: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground/90 tabular-nums"
      data-testid="message-nerd-stats"
    >
      {costTicker ? (
        <span
          className="truncate text-[13px] font-medium"
          data-testid="message-cost-ticker"
          aria-label={tickerAriaLabel}
        >
          {costTicker}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1">
        <CpuIcon size={14} />
        {stats.model}
      </span>
      <span className="inline-flex items-center gap-1">
        <HashIcon size={14} />
        {stats.messageTokens}
      </span>
      {stats.timeToFirstToken ? (
        <span className="inline-flex items-center gap-1">
          <ClockIcon size={14} />
          {stats.timeToFirstToken}
        </span>
      ) : null}
    </div>
  );
}

function MessageCopyActions({ isInFlight, content }: { isInFlight: boolean; content: string }) {
  if (isInFlight) {
    return null;
  }
  return (
    <MessageActions className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <CopyMessageAction content={content} />
    </MessageActions>
  );
}

function SystemErrorNotice({ status, message }: { status: Doc<"messages">["status"]; message: string }) {
  const title = status === "cancelled" ? "Reply cancelled" : "Reply could not finish";
  return (
    <Alert variant="destructive" className="max-w-xl bg-destructive/5">
      <WarningCircleIcon size={16} weight="fill" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/**
 * Resolve the "Thought for N seconds" duration the `<Reasoning>` trigger
 * renders. Three cases:
 *
 *   - **Terminal reply** with `reasoningDurationMs` persisted → derive
 *     seconds from the durable field (rounded up so a sub-second reply
 *     still reads as `1`, matching the Reasoning trigger's own
 *     `Math.ceil` convention).
 *   - **Live stream** with both a start and an end timestamp → compute
 *     from the active-stream timestamps so the trigger settles on the
 *     correct duration immediately at `reasoning-end` without waiting
 *     for finalize to copy the field across.
 *   - **Mid-stream** (no end timestamp yet) → return `undefined` and
 *     let `<Reasoning>` paint the "Thinking…" shimmer.
 */
function computeReasoningDurationSeconds(
  message: Doc<"messages">,
  activeMessageStream: ActiveMessageStream | null,
  isLiveStream: boolean,
): number | undefined {
  if (isLiveStream && activeMessageStream) {
    const start = activeMessageStream.reasoningStartedAt;
    const end = activeMessageStream.reasoningEndedAt;
    if (start !== null && end !== null) {
      return Math.max(1, Math.ceil((end - start) / 1000));
    }
    return undefined;
  }
  if (message.reasoningDurationMs !== undefined) {
    return Math.max(1, Math.ceil(message.reasoningDurationMs / 1000));
  }
  return undefined;
}

/**
 * Copy button for assistant messages. Shows a checkmark briefly after
 * clicking to confirm the copy succeeded.
 *
 * Delegates to {@link useClipboard} so the timer cleanup (auto-reset
 * after 1.5s), unmount guard, and `navigator.clipboard` availability
 * check all match the rest of the app's copy affordances rather than
 * being re-derived here. The hook swallows clipboard failures and
 * leaves `copied` false on rejection — the affordance stays idle when
 * the browser blocks the write (insecure context, permissions policy)
 * instead of falsely confirming a successful copy.
 */
function CopyMessageAction({ content }: { content: string }) {
  const { copied, copy } = useClipboard({ resetAfterMs: 1500 });
  const handleCopy = useCallback(() => {
    void copy(content);
  }, [copy, content]);
  return (
    <MessageAction
      tooltip={copied ? "Copied" : "Copy reply"}
      size="sm"
      onClick={handleCopy}
      data-testid="message-copy-button"
    >
      {copied ? <CheckIcon size={16} weight="bold" /> : <CopyIcon size={16} />}
    </MessageAction>
  );
}

/**
 * Render the chat-bubble cost ticker.
 *
 * Tries to surface as much information as is available, in this order:
 *
 *   1. `~$0.03 · 1.2k tokens · 5 tools` — full info (priced model,
 *      tokens reported, tool-call trace persisted).
 *   2. `~$0.03 · 1.2k tokens` — full info minus tool calls (discuss /
 *      docs replies have no tools by design).
 *   3. `1.2k tokens · 5 tools` — pricing miss (model not in
 *      `llmPricing.ts`); we still show what we know.
 *   4. `1.2k tokens` — discuss/docs reply for a model we don't price.
 *   5. `null` — heuristic reply (no cost, no tokens). Skips the ticker
 *      entirely so the user isn't shown an empty "—" line.
 *
 * Sub-cent costs get rendered as `<$0.01` rather than `$0.00` so the
 * user can distinguish "cheap reply" from "free reply".
 */
function buildCostTickerLabel(message: Doc<"messages">): string | null {
  const inputTokens = message.estimatedInputTokens;
  const outputTokens = message.estimatedOutputTokens;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : null;
  const cost = message.estimatedCostUsd;
  const toolCallCount = message.toolCalls?.length ?? 0;

  // Heuristic / no-token replies don't get a ticker — there's nothing
  // useful to show beyond what the bubble already says.
  if (totalTokens === null && cost === undefined && toolCallCount === 0) {
    return null;
  }

  const parts: string[] = [];
  if (cost !== undefined) {
    parts.push(formatCostUsd(cost));
  }
  if (totalTokens !== null) {
    parts.push(`${formatTokenCount(totalTokens)} tokens`);
  }
  if (toolCallCount > 0) {
    parts.push(`${toolCallCount} ${toolCallCount === 1 ? "tool" : "tools"}`);
  }
  return parts.join(" · ");
}

function buildNerdStats(
  message: Doc<"messages">,
  displayContent: string,
  activeMessageStream: ActiveMessageStream | null,
): {
  model: string;
  messageTokens: string;
  timeToFirstToken: string | null;
} {
  const outputTokens = message.estimatedOutputTokens ?? estimateMessageTokens(displayContent);
  const timeToFirstTokenMs =
    message.timeToFirstTokenMs ??
    (activeMessageStream?.firstContentAt != null
      ? Math.max(0, activeMessageStream.firstContentAt - activeMessageStream.startedAt)
      : null);

  return {
    model: message.modelName ?? "model unavailable",
    messageTokens: `${formatTokenCount(outputTokens)} est. tokens`,
    timeToFirstToken: timeToFirstTokenMs == null ? null : `TTFT ${formatDurationSeconds(timeToFirstTokenMs)}`,
  };
}

function estimateMessageTokens(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function formatDurationSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} sec`;
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) {
    return "<$0.01";
  }
  return `~$${usd.toFixed(2)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  // 1.2k granularity — sufficient for the ticker and avoids noisy
  // single-token differences across re-renders.
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Renders the injected `<citation>` tag for `[A#]` citation tokens.
 *
 * The tag wraps exactly the `[A1]` / `[A1#path]` token text, so this
 * parses the numeric index out of `children` and resolves it against
 * the message's citation map: a resolved index renders the clickable
 * citation button (forwarding the artifact id to `onSelectArtifact`),
 * an unresolved or unparseable one falls back to the literal token text
 * so the model's intent stays visible even when the map is missing it.
 */
function CitationRef({
  children,
  indexToArtifactId,
  onSelectArtifact,
}: {
  children?: ReactNode;
  indexToArtifactId: ReadonlyMap<number, ArtifactId>;
  onSelectArtifact?: (artifactId: ArtifactId) => void;
}) {
  const match = CITATION_TOKEN_REGEX.exec(getNodeText(children));
  const tokenIndex = match ? Number.parseInt(match[1], 10) : Number.NaN;
  const artifactId = Number.isNaN(tokenIndex) ? undefined : indexToArtifactId.get(tokenIndex);

  if (!artifactId || !onSelectArtifact) {
    // Unresolved tokens render as plain text so the model's intent is
    // visible even when the citation map is missing or out of range.
    return <>{children}</>;
  }

  return (
    <button
      type="button"
      onClick={() => onSelectArtifact(artifactId)}
      className="mx-0.5 inline-flex items-center border border-primary/30 bg-primary/5 px-1 py-0 text-[11px] font-semibold leading-5 text-primary hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-testid={`citation-link-${tokenIndex}`}
      aria-label={`Open referenced artifact A${tokenIndex}`}
    >
      {children}
    </button>
  );
}

/**
 * Flatten a React node tree to its text content. The injected
 * `<citation>` tag wraps exactly the `[A#]` token, so for a citation
 * this returns the literal token text `CitationRef` parses the index
 * out of. Defensive against streamdown handing back the token as a
 * nested node rather than a bare string.
 */
function getNodeText(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }
  if (typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getNodeText).join("");
  }
  if (isValidElement(node)) {
    return getNodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * UnverifiedMark wraps content in the existing styled mark for
 * unverified claims, with soft-yellow background and dotted underline.
 */
function UnverifiedMark({ children }: { children?: ReactNode }) {
  return (
    <mark
      className="rounded-sm bg-highlight/20 px-0.5 underline decoration-highlight/70 decoration-dotted underline-offset-2 dark:bg-highlight/15"
      data-testid="unverified-claim"
      title="The model did not cite a tool-verified source for this sentence. Read with skepticism."
    >
      {children}
    </mark>
  );
}

function getMessageStatusLabel(status: Doc<"messages">["status"]): string | null {
  switch (status) {
    case "pending":
      return "Queued";
    case "streaming":
      return "Generating";
    case "completed":
      // The default terminal state — every settled reply lands here, so
      // labelling it would just paint "Ready" on every bubble forever.
      // Suppress entirely; the absence of a status IS the "ok" signal.
      return null;
    case "failed":
      return "Failed";
    case "cancelled":
      // Distinct from "Failed" so the user can tell at a glance that they
      // themselves stopped the reply (vs. an upstream error).
      return "Cancelled";
    default:
      return status;
  }
}
