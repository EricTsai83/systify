import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { loadOwnedDoc, requireOwnedDoc } from "../lib/ownedDocs";

type ReadCtx = QueryCtx | MutationCtx;

export function isActiveThread(thread: Doc<"threads"> | null | undefined): thread is Doc<"threads"> {
  return !!thread && thread.deletionRequestedAt === undefined && thread.archivedAt === undefined;
}

export async function requireActiveOwnedThread(
  ctx: ReadCtx,
  threadId: Id<"threads">,
  options?: { notFoundMessage?: string },
) {
  const result = await requireOwnedDoc(ctx, threadId, options);
  if (!isActiveThread(result.doc)) {
    throw new Error(options?.notFoundMessage ?? "Thread not found.");
  }
  return result;
}

export async function loadActiveOwnedThread(ctx: ReadCtx, threadId: Id<"threads">) {
  const result = await loadOwnedDoc(ctx, threadId);
  return isActiveThread(result.doc) ? result : { identity: result.identity, doc: null };
}
