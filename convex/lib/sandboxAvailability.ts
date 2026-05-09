export type SandboxAvailabilityInput = {
  status: "provisioning" | "ready" | "stopped" | "archived" | "failed";
  ttlExpiresAt: number;
  remoteId?: string;
  repoPath?: string;
};

export type SandboxUnavailableCode =
  | "missing_sandbox"
  | "sandbox_unavailable"
  | "sandbox_expired"
  | "sandbox_provisioning";

export type SandboxAvailability = {
  available: boolean;
  reasonCode: "available" | SandboxUnavailableCode;
  message: string | null;
};

export type SandboxModeStatus = Pick<SandboxAvailability, "reasonCode" | "message">;

export function getSandboxAvailability(
  sandbox: SandboxAvailabilityInput | null | undefined,
  now = Date.now(),
): SandboxAvailability {
  if (!sandbox) {
    return {
      available: false,
      reasonCode: "missing_sandbox",
      message:
        "A live sandbox is unavailable because no sandbox is ready for this repository yet. Sync the repository to provision one.",
    };
  }

  if (sandbox.status === "failed") {
    return {
      available: false,
      reasonCode: "sandbox_unavailable",
      message:
        "A live sandbox is unavailable because the sandbox failed. Sync the repository to provision a fresh sandbox.",
    };
  }

  // `archived` is a normal end-of-life state (Daytona auto-archives after the
  // configured idle interval) — treat it the same as a TTL-expired sandbox so
  // the UI surfaces it as a warning ("Sandbox expired") rather than a red
  // "Sandbox error", which is reserved for the genuine `failed` case above.
  // Mirrors the `archived → expired` collapse already in chatModeResolver.
  if (sandbox.status === "archived" || now > sandbox.ttlExpiresAt) {
    return {
      available: false,
      reasonCode: "sandbox_expired",
      message:
        "A live sandbox is unavailable because the sandbox expired. Sync the repository to provision a fresh sandbox.",
    };
  }

  if (!sandbox.remoteId || !sandbox.repoPath) {
    return {
      available: false,
      reasonCode: "sandbox_provisioning",
      message:
        "A live sandbox is unavailable because the sandbox is still provisioning. Wait for the import to finish or sync the repository again.",
    };
  }

  return {
    available: true,
    reasonCode: "available",
    message: null,
  };
}

export function getSandboxModeStatus(
  sandbox: SandboxAvailabilityInput | null | undefined,
  now = Date.now(),
): SandboxModeStatus {
  const { available: _available, ...status } = getSandboxAvailability(sandbox, now);
  return status;
}

export function getSandboxUnavailableReason(sandbox: SandboxAvailabilityInput | null | undefined, now = Date.now()) {
  return getSandboxAvailability(sandbox, now).message;
}

export function isSandboxAvailable(sandbox: SandboxAvailabilityInput | null | undefined, now = Date.now()) {
  return getSandboxAvailability(sandbox, now).available;
}
