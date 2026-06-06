function getStructuredErrorData(error: unknown) {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return null;
  }

  if (typeof error.data === "object" && error.data !== null) {
    return error.data;
  }

  if (typeof error.data === "string") {
    try {
      const parsed = JSON.parse(error.data);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function getStructuredErrorMessage(error: unknown) {
  const data = getStructuredErrorData(error);
  if (data && "message" in data && typeof data.message === "string" && data.message.trim()) {
    return data.message;
  }

  return null;
}

function getUsageBudgetExceededMessage(error: unknown) {
  const data = getStructuredErrorData(error);
  if (!data || !("code" in data) || data.code !== "USER_USAGE_BUDGET_EXCEEDED") {
    return null;
  }

  const resetDate =
    "periodEndMs" in data && typeof data.periodEndMs === "number" && Number.isFinite(data.periodEndMs)
      ? new Date(data.periodEndMs)
      : null;
  const hasValidResetDate = resetDate !== null && !Number.isNaN(resetDate.getTime());
  const resetSuffix = hasValidResetDate ? ` Resets ${formatUsageResetDate(resetDate)}.` : "";
  return `Usage budget reached for the current cycle. Review Settings → Usage.${resetSuffix}`;
}

function formatUsageResetDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function toUserErrorMessage(error: unknown, fallback: string) {
  const budgetMessage = getUsageBudgetExceededMessage(error);
  if (budgetMessage) {
    return budgetMessage;
  }

  const structuredMessage = getStructuredErrorMessage(error);
  if (structuredMessage) {
    return structuredMessage;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}
