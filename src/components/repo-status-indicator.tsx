import { CircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";

/**
 * Shows a badge in the TopBar ONLY for sandbox-related states that need the
 * user's attention. Import / sync status is handled exclusively by SyncButton
 * to avoid duplication.
 *
 * Happy path (sandbox ready / stopped / null) renders nothing.
 */
export function RepoStatusIndicator({ sandbox }: { sandbox: { status: string; ttlExpiresAt: number } | null }) {
  const badgeClassName = "ml-1 gap-1 text-[10px] uppercase tracking-wide animate-in fade-in duration-300 ease-out";

  if (sandbox?.status === "failed") {
    return (
      <Badge variant="destructive" className={badgeClassName}>
        <WarningCircleIcon size={10} weight="fill" />
        Sandbox error
      </Badge>
    );
  }

  if (sandbox?.status === "provisioning") {
    return (
      <Badge variant="muted" className={badgeClassName}>
        <CircleIcon size={8} weight="fill" className="animate-pulse text-primary" />
        Starting…
      </Badge>
    );
  }

  return null;
}
