export function isRepolessAgentEnabled(args: {
  agentEnabled?: boolean;
  agentRole?: string | null;
  agentInstructions?: string | null;
}): boolean {
  return args.agentEnabled ?? (Boolean(args.agentRole?.trim()) || Boolean(args.agentInstructions?.trim()));
}
