import type { ReplyContext } from "./context";

export interface GatewayUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface GatewayReplyStreamSession {
  run(resolvedContext: ReplyContext): Promise<GatewayUsage>;
}

export async function runGatewayReplyStream(
  session: GatewayReplyStreamSession,
  resolvedContext: ReplyContext,
): Promise<GatewayUsage> {
  return await session.run(resolvedContext);
}
