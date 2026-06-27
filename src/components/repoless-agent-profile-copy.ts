export function getRepolessChatTypeTooltip({ isAgent }: { isAgent: boolean }): string {
  if (isAgent) {
    return "Agent mode follows the saved agent profile for this repoless chat.";
  }

  return "Conversation mode replies directly without an agent profile.";
}

export function getRepolessSingleTurnTooltip({ isOn, resetPending }: { isOn: boolean; resetPending: boolean }): string {
  if (resetPending) {
    return "Clearing previous messages before the next single reply starts.";
  }

  if (isOn) {
    return "Single reply uses only the latest prompt, without earlier thread messages.";
  }

  return "Threaded replies include earlier messages from this thread.";
}
