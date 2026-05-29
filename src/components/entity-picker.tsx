import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { filterByQuery } from "@/lib/text-filter";
import { cn } from "@/lib/utils";

const DEFAULT_SEARCH_THRESHOLD = 8;

type PickerCtx = { close: () => void };
const PickerContext = createContext<PickerCtx | null>(null);

export type EntityPickerProps<T> = {
  items: ReadonlyArray<T>;
  getItemKey: (item: T) => string;
  getSearchText: (item: T) => string;
  renderItem: (item: T, ctx: { isActive: boolean }) => ReactNode;
  isItemActive?: (item: T) => boolean;
  onSelect: (item: T) => void;
  trigger: ReactNode;
  /**
   * Sticky region rendered above the scrollable list and below the search
   * input. Use {@link PickerActionRow} for selectable entries so the visual
   * matches in-list rows and the popover closes automatically on click.
   */
  header?: ReactNode;
  /**
   * Sticky region rendered below the scrollable list. Typical use: an
   * action like "Import repository" that opens a dialog. {@link PickerActionRow}
   * applies if the entry is a simple click, but raw ReactNode works too
   * (e.g. a Dialog `trigger` already rendered as a button).
   */
  footer?: ReactNode;
  searchPlaceholder?: string;
  /**
   * Item count at which the search input appears. Below this, the picker
   * stays simple — search-input chrome on a tiny list is pure noise.
   */
  searchThreshold?: number;
  emptyHint?: ReactNode;
  noResultsHint?: ReactNode;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  ariaLabel?: string;
};

/**
 * Popover-based picker for entity lists (repositories, threads, folders…).
 * Designed to replace `DropdownMenu` for data-bound, variable-length lists
 * where DropdownMenu's menu semantics ("a short list of actions") become
 * a poor fit: no scroll, no filter, items can overflow the viewport.
 *
 * Reserve DropdownMenu for actual action menus (kebab, profile menu).
 * Use EntityPicker whenever the list is bound to a Convex query or a
 * variable-length data source.
 */
export function EntityPicker<T>({
  items,
  getItemKey,
  getSearchText,
  renderItem,
  isItemActive,
  onSelect,
  trigger,
  header,
  footer,
  searchPlaceholder = "Search…",
  searchThreshold = DEFAULT_SEARCH_THRESHOLD,
  emptyHint,
  noResultsHint = "No matches.",
  contentClassName = "w-64",
  align = "start",
  side = "bottom",
  ariaLabel,
}: EntityPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const shouldShowSearch = items.length >= searchThreshold;

  // Reset query / activeIndex when the popover closes so the next open
  // is a clean state. When opening with search visible, defer focus a
  // tick so Radix finishes mounting PopoverContent before we focus.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      setActiveIndex(0);
      return;
    }
    if (shouldShowSearch) {
      const handle = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(handle);
    }
  }, [open, shouldShowSearch]);

  const filtered = useMemo(() => filterByQuery(items, query, getSearchText), [items, query, getSearchText]);

  // Clamp activeIndex when the filter shrinks the list so the keyboard
  // cursor never points past the end. Deriving this purely during render
  // would loop because the clamp itself feeds into the next render.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveIndex(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [filtered.length, activeIndex]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        const maxIndex = filtered.length - 1;
        setActiveIndex((c) => Math.min(maxIndex, c + 1));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        setActiveIndex((c) => Math.max(0, c - 1));
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = filtered[activeIndex];
      if (target) {
        onSelect(target);
        setOpen(false);
      }
    }
  };

  const ctx = useMemo<PickerCtx>(() => ({ close: () => setOpen(false) }), []);

  return (
    <PickerContext.Provider value={ctx}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          // Keep Popover's default scale-95 entry — it's the recommended
          // pattern for surfaces appearing from a trigger (the small
          // transform gives the "pop" that fade-only menus lack). Just
          // shorten the duration so the picker feels snappy like a
          // dropdown rather than the heavier-popover default.
          //
          // `motion-safe:` so reduced-motion users keep the global 1ms
          // fallback from animations.css instead of cascade-racing this
          // override.
          className={cn("p-0 motion-safe:duration-100", contentClassName)}
          align={align}
          side={side}
        >
          {shouldShowSearch ? (
            <div className="border-b border-border px-2 py-1.5">
              <Input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                aria-activedescendant={
                  filtered[activeIndex] ? `entity-picker-row-${getItemKey(filtered[activeIndex])}` : undefined
                }
                aria-label={ariaLabel ?? searchPlaceholder}
                className="h-7 border-0 bg-transparent px-1 text-sm focus-visible:border-transparent"
              />
            </div>
          ) : null}
          {header ? <div className="border-b border-border p-1">{header}</div> : null}
          <ScrollArea className="max-h-72">
            <ul role="listbox" className="flex flex-col p-1">
              {items.length === 0 ? (
                <li className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyHint ?? "No items."}</li>
              ) : filtered.length === 0 ? (
                <li className="px-2 py-3 text-center text-xs text-muted-foreground">{noResultsHint}</li>
              ) : (
                filtered.map((item, index) => {
                  const key = getItemKey(item);
                  const active = isItemActive?.(item) ?? false;
                  return (
                    <li key={key} id={`entity-picker-row-${key}`} role="option" aria-selected={index === activeIndex}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(item);
                          setOpen(false);
                        }}
                        onMouseEnter={() => setActiveIndex(index)}
                        className={cn(
                          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors",
                          index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                        )}
                      >
                        {renderItem(item, { isActive: active })}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </ScrollArea>
          {footer ? <div className="border-t border-border p-1">{footer}</div> : null}
        </PopoverContent>
      </Popover>
    </PickerContext.Provider>
  );
}

type PickerActionRowProps = {
  children: ReactNode;
  onSelect: () => void;
  isActive?: boolean;
  closeOnSelect?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children">;

/**
 * Row primitive for header / footer slots. Matches the in-list row visual
 * (same padding / hover) and auto-closes the picker on click via
 * {@link PickerContext}. Set `closeOnSelect={false}` for footer rows whose
 * onSelect opens a Dialog — letting the popover stay open avoids a focus
 * race with the Dialog mount.
 *
 * `forwardRef` + rest-prop spread lets this row sit inside a Radix
 * `asChild` trigger (e.g. `<DialogTrigger asChild>`); Slot's injected
 * onClick composes with the row's own click logic instead of being dropped.
 */
export const PickerActionRow = forwardRef<HTMLButtonElement, PickerActionRowProps>(function PickerActionRow(
  { children, onSelect, isActive = false, disabled = false, closeOnSelect = true, onClick: externalOnClick, ...rest },
  ref,
) {
  const ctx = useContext(PickerContext);
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      onClick={(event) => {
        if (disabled) return;
        externalOnClick?.(event);
        if (event.defaultPrevented) return;
        onSelect();
        if (closeOnSelect) ctx?.close();
      }}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors",
        isActive ? "bg-muted" : "hover:bg-muted/60",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
});
