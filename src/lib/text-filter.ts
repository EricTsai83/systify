/**
 * Case-insensitive substring filter used by in-memory pickers
 * (e.g. QuickOpenDialog).
 *
 * Behavior: trims the query; empty query returns every item unchanged.
 * Otherwise, each item is kept if its `getSearchText(item)` lowercased
 * value contains the lowercased needle. Matching is plain `includes` —
 * deliberately not true fuzzy/subsequence matching, so multi-word
 * queries should be space-stripped or pre-split by the caller if a
 * different semantic is wanted.
 */
export function filterByQuery<T>(
  items: ReadonlyArray<T>,
  query: string,
  getSearchText: (item: T) => string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => getSearchText(item).toLowerCase().includes(needle));
}
