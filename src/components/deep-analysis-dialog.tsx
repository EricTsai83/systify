import { SparkleIcon } from "@phosphor-icons/react";
import { AppNotice } from "@/components/app-notice";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import type { SandboxModeStatus } from "@/lib/types";

export function DeepAnalysisDialog({
  open,
  onOpenChange,
  analysisPrompt,
  onAnalysisPromptChange,
  sandboxModeStatus,
  errorMessage,
  isRunning,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analysisPrompt: string;
  onAnalysisPromptChange: (value: string) => void;
  sandboxModeStatus: SandboxModeStatus;
  errorMessage?: string | null;
  isRunning: boolean;
  onRun: () => Promise<void>;
}) {
  const sandboxAvailable = sandboxModeStatus.reasonCode === "available";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deep analysis</DialogTitle>
          <DialogDescription>
            Searches the live sandbox filesystem for files matching your prompt. Unlike Design Docs mode which only
            uses pre-indexed data, Sandbox mode can find any file in the repository.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={analysisPrompt}
          onChange={(e) => onAnalysisPromptChange(e.target.value)}
          className="min-h-40"
        />
        {!sandboxAvailable ? (
          <AppNotice
            title="Deep analysis unavailable"
            message={
              sandboxModeStatus.message ??
              "A live sandbox is unavailable right now. Sync the repository to provision a fresh sandbox."
            }
            tone="warning"
          />
        ) : null}
        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="default"
            className="min-w-40"
            disabled={isRunning || !analysisPrompt.trim() || !sandboxAvailable}
            onClick={() => {
              void onRun();
            }}
          >
            <SparkleIcon weight="bold" />
            {isRunning ? "Queuing…" : "Run deep analysis"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
