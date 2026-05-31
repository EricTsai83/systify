"use client";

/**
 * Composer model picker. Composes the existing
 * `PromptInputSelect` family from `prompt-input.tsx` into a feature-
 * specific control the chat composer renders alongside the grounding
 * toggles.
 *
 * Public API kept minimal: the picker takes the current `(provider,
 * modelName)` pair as a single `value` object, fires the same shape
 * on `onChange`, and accepts a thread-level `lockedProvider` to drive
 * the per-thread "locked to X" pill plus the cross-provider filter.
 * The component is dumb — every catalog read goes through Convex's
 * `useQuery(api.llmCatalog.listPickableModels, ...)` so a future
 * per-user policy change lands without a UI rewrite.
 *
 * Lock semantics:
 *
 *   - When `threadLockedProvider` is `undefined`, the picker surfaces
 *     every catalog group; the user is choosing for the first time and
 *     the first send will set the thread's lock.
 *   - When `threadLockedProvider` is set, we hide the other provider's
 *     group entirely (the backend would reject those picks anyway
 *     with `thread_provider_locked`) and render a small `<HoverCard>`
 *     pill next to the trigger explaining why the choice is narrowed.
 *
 * The composite key (`provider:modelName`) used by the underlying
 * `<Select>` element is purely a UI-internal serialization — the
 * change handler decomposes it back into the typed pair before
 * surfacing to the parent. Keeping the wire format inside this module
 * means upstream callers never have to know the catalog stores
 * `(provider, modelName)` separately.
 */

import { useMemo } from "react";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { LlmProvider, ModelCapability, ModelCatalogEntry } from "@/lib/types";
import {
  PromptInputHoverCard,
  PromptInputHoverCardContent,
  PromptInputHoverCardTrigger,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { SelectGroup, SelectLabel } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type PromptInputModelPickerValue = {
  provider: LlmProvider;
  modelName: string;
};

export interface PromptInputModelPickerProps {
  /**
   * Currently-picked pair. The trigger label resolves the entry from
   * the catalog query — when the model name no longer appears (e.g.
   * the catalog narrowed between sends), the trigger renders the raw
   * `modelName` rather than a broken empty state.
   */
  value: PromptInputModelPickerValue | null | undefined;
  /**
   * Fires when the user picks a new entry. Receives the decomposed
   * `(provider, modelName)` pair so callers never have to parse the
   * underlying composite key.
   */
  onChange: (next: PromptInputModelPickerValue) => void;
  /**
   * Provider this thread is locked to, if any. Hides the other
   * provider's group from the dropdown and renders the lock pill
   * alongside the trigger.
   */
  threadLockedProvider?: LlmProvider | null;
  /**
   * Capability filter forwarded to `listPickableModels`. The Discuss
   * composer passes `"discuss"`; the standalone System Design dialog
   * (future PR-B) passes `"sandbox"`.
   */
  capability?: ModelCapability;
  /**
   * Disables the trigger entirely. Mirrors the disabled state of the
   * grounding toggles so the whole composer toolbar flips read-only
   * together (e.g. an archived repository).
   */
  disabled?: boolean;
  /** Optional class for sizing inside the composer footer. */
  className?: string;
}

const COMPOSITE_KEY_SEPARATOR = ":";

function toCompositeKey(value: PromptInputModelPickerValue): string {
  return `${value.provider}${COMPOSITE_KEY_SEPARATOR}${value.modelName}`;
}

function fromCompositeKey(key: string): PromptInputModelPickerValue | null {
  const separatorIndex = key.indexOf(COMPOSITE_KEY_SEPARATOR);
  if (separatorIndex < 0) return null;
  const provider = key.slice(0, separatorIndex) as LlmProvider;
  const modelName = key.slice(separatorIndex + 1);
  if (!modelName) return null;
  return { provider, modelName };
}

const PROVIDER_DISPLAY_NAME: Record<LlmProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export function PromptInputModelPicker({
  value,
  onChange,
  threadLockedProvider,
  capability,
  disabled = false,
  className,
}: PromptInputModelPickerProps) {
  // `listPickableModels` is a tiny query (~10 entries); we always
  // subscribe to it even when the thread is locked so the lock pill
  // and the trigger's display label can resolve correctly. The
  // catalog narrows downstream via `useMemo`.
  const catalogEntries = useQuery(api.llmCatalog.listPickableModels, capability !== undefined ? { capability } : {});

  // `useQuery` returns either `undefined` (loading) or the typed array
  // in production. Guard with `Array.isArray` so a misbehaving mock /
  // a future projection change can't crash the picker on a non-array
  // payload — fall back to "no models available" instead. Memoize so
  // the identity-stable fallback array doesn't fire downstream
  // `useMemo` invalidations every render.
  const safeCatalog = useMemo(() => (Array.isArray(catalogEntries) ? catalogEntries : []), [catalogEntries]);
  const visibleEntries = useMemo(() => {
    if (safeCatalog.length === 0) return [];
    if (!threadLockedProvider) return safeCatalog;
    return safeCatalog.filter((entry) => entry.provider === threadLockedProvider);
  }, [safeCatalog, threadLockedProvider]);

  const groupedByProvider = useMemo(() => groupByProvider(visibleEntries), [visibleEntries]);

  const compositeValue = value ? toCompositeKey(value) : undefined;

  // The trigger renders the picked entry's `displayName` so the label
  // matches the catalog vocabulary. Falling back to the raw composite
  // key keeps the trigger non-empty even when the picked entry was
  // dropped from the catalog mid-session.
  const currentDisplayName = useMemo(() => {
    if (!value) return undefined;
    const entry = safeCatalog.find((e) => e.provider === value.provider && e.modelName === value.modelName);
    return entry?.displayName ?? value.modelName;
  }, [safeCatalog, value]);

  const handleValueChange = (next: string) => {
    const picked = fromCompositeKey(next);
    if (picked) onChange(picked);
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PromptInputSelect value={compositeValue} onValueChange={handleValueChange} disabled={disabled}>
        <PromptInputSelectTrigger
          aria-label="Pick model"
          data-testid="prompt-input-model-picker-trigger"
          className="h-8 gap-1.5 px-2 text-xs"
        >
          <PromptInputSelectValue placeholder="Pick model">{currentDisplayName}</PromptInputSelectValue>
        </PromptInputSelectTrigger>
        <PromptInputSelectContent>
          {groupedByProvider.length === 0 ? (
            // Catalog query still loading OR the lock leaves no
            // pickable entries. Either way: nothing to choose; the
            // trigger stays clickable but the menu is empty.
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No models available.</div>
          ) : (
            groupedByProvider.map((group) => (
              <SelectGroup key={group.provider}>
                <SelectLabel className="text-xs text-muted-foreground">
                  {PROVIDER_DISPLAY_NAME[group.provider]}
                </SelectLabel>
                {group.entries.map((entry) => (
                  <PromptInputSelectItem
                    key={toCompositeKey({ provider: entry.provider, modelName: entry.modelName })}
                    value={toCompositeKey({ provider: entry.provider, modelName: entry.modelName })}
                  >
                    {entry.displayName}
                  </PromptInputSelectItem>
                ))}
              </SelectGroup>
            ))
          )}
        </PromptInputSelectContent>
      </PromptInputSelect>
      {threadLockedProvider ? <ProviderLockPill provider={threadLockedProvider} /> : null}
    </div>
  );
}

interface ProviderGroup {
  provider: LlmProvider;
  entries: ModelCatalogEntry[];
}

/**
 * Stable group order: OpenAI first, then Anthropic, then any future
 * provider in insertion order. Keeping the ordering deterministic
 * avoids reflows in the dropdown when the catalog query refetches.
 */
function groupByProvider(entries: ReadonlyArray<ModelCatalogEntry>): ProviderGroup[] {
  const buckets = new Map<LlmProvider, ModelCatalogEntry[]>();
  for (const entry of entries) {
    const existing = buckets.get(entry.provider);
    if (existing) {
      existing.push(entry);
    } else {
      buckets.set(entry.provider, [entry]);
    }
  }
  return Array.from(buckets.entries()).map(([provider, providerEntries]) => ({
    provider,
    entries: providerEntries,
  }));
}

function ProviderLockPill({ provider }: { provider: LlmProvider }) {
  return (
    <PromptInputHoverCard>
      <PromptInputHoverCardTrigger asChild>
        <span
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          data-testid="prompt-input-model-picker-lock-pill"
        >
          <LockSimpleIcon weight="bold" size={10} />
          {PROVIDER_DISPLAY_NAME[provider]}
        </span>
      </PromptInputHoverCardTrigger>
      <PromptInputHoverCardContent className="w-64 text-xs leading-5">
        <p className="font-semibold">Locked to {PROVIDER_DISPLAY_NAME[provider]}</p>
        <p className="mt-1 text-muted-foreground">
          Provider responses differ in reasoning, caching, and tool formats. Start a new chat to use a different
          provider.
        </p>
      </PromptInputHoverCardContent>
    </PromptInputHoverCard>
  );
}
