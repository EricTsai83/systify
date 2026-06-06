import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { shortSha } from "@/lib/format";
import { useRelativeTime } from "@/hooks/use-relative-time";
import type { TopBarRepoDetail } from "@/components/top-bar";

/** Single row inside the repo-info popover. */
function InfoRow({
  label,
  value,
  truncate,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  truncate?: boolean;
  mono?: boolean;
  highlight?: "positive" | "negative";
}) {
  let valueClass = "truncate text-foreground";
  if (truncate) valueClass = "max-w-[60%] truncate text-right text-foreground";
  if (mono) valueClass += " font-mono";
  if (highlight === "positive") valueClass += " text-primary";
  if (highlight === "negative") valueClass += " text-destructive";

  return (
    <div className="flex justify-between gap-4">
      <span>{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

/** Derives a human-readable combined status for the popover. */
function deriveStatusLabel(repoDetail: TopBarRepoDetail): string {
  const importLower = repoDetail.repository.importStatus.toLowerCase();
  const importDone =
    importLower.includes("complete") || importLower.includes("ready") || importLower.includes("success");

  if (!importDone) {
    return `Sync: ${repoDetail.repository.importStatus}`;
  }

  if (!repoDetail.sandbox) return "Ready";

  const sb = repoDetail.sandbox;
  if (sb.status === "failed") return "Live source error";
  if (sb.status === "archived" || Date.now() > sb.ttlExpiresAt) return "Live source expired";
  if (sb.status === "provisioning") return "Live source starting…";
  return "Ready";
}

/** Live-updating "Last synced" row inside the repo-info popover. */
function PopoverLastSynced({ timestamp }: { timestamp?: number }) {
  const label = useRelativeTime(timestamp);
  if (!label) return null;
  return <InfoRow label="Last synced" value={label} />;
}

export function RepoInfoPopover({ repoDetail, title }: { repoDetail: TopBarRepoDetail; title: string }) {
  const isSandboxAvailable = repoDetail.sandboxModeStatus.reasonCode === "available";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto min-w-0 truncate px-0 text-left text-sm font-semibold tracking-tight text-foreground hover:bg-transparent hover:underline md:text-base"
        >
          {title}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Repository info</p>
        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          <InfoRow label="Status" value={deriveStatusLabel(repoDetail)} />
          <InfoRow label="Branch" value={repoDetail.repository.defaultBranch ?? "Unknown"} />
          <InfoRow label="Files indexed" value={repoDetail.fileCountLabel} />
          <InfoRow label="Languages" value={repoDetail.repository.detectedLanguages.join(", ") || "Unknown"} truncate />
          <PopoverLastSynced timestamp={repoDetail.repository.lastImportedAt} />
          {repoDetail.repository.lastSyncedCommitSha ? (
            <InfoRow label="Commit" value={shortSha(repoDetail.repository.lastSyncedCommitSha)} mono />
          ) : null}
          <InfoRow
            label="Live source"
            value={isSandboxAvailable ? "Available" : "Unavailable"}
            highlight={isSandboxAvailable ? "positive" : "negative"}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
