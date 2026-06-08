import { useEffect, useState } from "react";
import type { RepositoryId } from "@/lib/types";

const EVENT_NAME = "systify:sandbox-activation-signal";
const STORAGE_PREFIX = "systify.sandboxActivation.requestedAt.";
const PENDING_TTL_MS = 2 * 60_000;

type SandboxActivationSignalEvent = CustomEvent<{ repositoryId: RepositoryId }>;

export function markSandboxActivationRequested(repositoryId: RepositoryId) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(storageKey(repositoryId), String(Date.now()));
  dispatchSignal(repositoryId);
}

export function clearSandboxActivationRequest(repositoryId: RepositoryId) {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(storageKey(repositoryId));
  dispatchSignal(repositoryId);
}

export function useSandboxActivationSignal(repositoryId: RepositoryId): boolean {
  const [isPending, setIsPending] = useState(() => readPending(repositoryId));

  useEffect(() => {
    const update = () => setIsPending(readPending(repositoryId));
    update();

    const onSignal = (event: Event) => {
      const detail = (event as SandboxActivationSignalEvent).detail;
      if (detail?.repositoryId === repositoryId) {
        update();
      }
    };
    const intervalId = window.setInterval(update, 5_000);

    window.addEventListener(EVENT_NAME, onSignal);
    return () => {
      window.removeEventListener(EVENT_NAME, onSignal);
      window.clearInterval(intervalId);
    };
  }, [repositoryId]);

  return isPending;
}

function readPending(repositoryId: RepositoryId): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.sessionStorage.getItem(storageKey(repositoryId));
  if (!raw) return false;
  const requestedAt = Number(raw);
  if (!Number.isFinite(requestedAt) || Date.now() - requestedAt > PENDING_TTL_MS) {
    window.sessionStorage.removeItem(storageKey(repositoryId));
    return false;
  }
  return true;
}

function dispatchSignal(repositoryId: RepositoryId) {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { repositoryId } }));
}

function storageKey(repositoryId: RepositoryId) {
  return `${STORAGE_PREFIX}${repositoryId}`;
}
