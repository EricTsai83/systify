import { ChatCircleTextIcon, GitBranchIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportRepoDialog } from "@/components/import-repo-dialog";
import type { OnImportedCallback } from "@/lib/types";

const EMPTY_STATE_OWL = ["   ^...^   ", "  / o,o \\  ", "  |):::(|  ", "====w=w===="].join("\n");

const EMPTY_STATE_OWL_BLINK = ["   ^...^   ", "  / -,- \\  ", "  |):::(|  ", "====w=w===="].join("\n");

/**
 * Workspace empty state — what the user sees the very first time they sign
 * in (no threads, no repos) and any time they hit `/chat` without any
 * threads to redirect to.
 *
 * Home is repo-free by design: start with unscoped design notes here, or
 * import a repository to create a dedicated repo workspace.
 */
export function EmptyState({
  onStartConversation,
  onImported,
  isStartingConversation = false,
}: {
  onStartConversation: () => void;
  onImported: OnImportedCallback;
  isStartingConversation?: boolean;
}) {
  return (
    <div className="flex flex-1 animate-in items-center justify-center px-5 py-10 fade-in duration-300">
      <div className="w-full max-w-3xl">
        <div className="mx-auto mb-7 flex max-w-xl flex-col items-center text-center">
          <TerminalOwl />
          <Badge variant="default" className="mt-5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Choose your starting point
          </Badge>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center border border-border bg-background text-foreground">
                <ChatCircleTextIcon size={18} weight="bold" />
              </div>
              <div className="min-w-0 text-left">
                <CardTitle className="text-base">Start without a repository</CardTitle>
                <CardDescription className="mt-1 leading-6">
                  Best for loose ideas, system design tradeoffs, and questions that are not tied to code yet.
                </CardDescription>
              </div>
            </CardHeader>
            <CardFooter>
              <Button
                type="button"
                variant="default"
                size="lg"
                className="w-full justify-center"
                disabled={isStartingConversation}
                onClick={onStartConversation}
              >
                {isStartingConversation ? "Starting..." : "Start design conversation"}
              </Button>
            </CardFooter>
          </Card>

          <Card className="bg-card/80">
            <CardHeader className="flex flex-row items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center border border-border bg-background text-foreground">
                <GitBranchIcon size={18} weight="bold" />
              </div>
              <div className="min-w-0 text-left">
                <CardTitle className="text-base">Import a repository</CardTitle>
                <CardDescription className="mt-1 leading-6">
                  Best when answers should cite project context, inspect files, or use sandbox-backed analysis.
                </CardDescription>
              </div>
            </CardHeader>
            <CardFooter>
              <ImportRepoDialog
                onImported={onImported}
                trigger={
                  <Button type="button" variant="outline" size="lg" className="w-full justify-center">
                    Import repository
                  </Button>
                }
              />
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

function TerminalOwl() {
  return (
    <div role="img" aria-label="Owl" className="relative mb-1 inline-grid place-items-center">
      <pre
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 select-none font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
      >
        {EMPTY_STATE_OWL}
      </pre>
      <pre
        aria-hidden="true"
        className="animate-terminal-owl-double-blink pointer-events-none col-start-1 row-start-1 select-none bg-background font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
      >
        {EMPTY_STATE_OWL_BLINK}
      </pre>
    </div>
  );
}
