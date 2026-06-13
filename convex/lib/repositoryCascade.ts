import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { runRepositoryOwnedDataLifecycleDelete } from "./repositoryOwnedDataLifecycle";

export async function runRepositoryCascadeDelete(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<void> {
  await runRepositoryOwnedDataLifecycleDelete(ctx, args);
}
