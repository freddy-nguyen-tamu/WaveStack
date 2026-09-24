type SearchHistorySuggestionsProps = {
  history: string[];
  query: string;
  open: boolean;
  onSelect: (value: string) => void;
};

const MAX_VISIBLE_HISTORY = 8;

export function SearchHistorySuggestions({
  history,
  query,
  open,
  onSelect
}: SearchHistorySuggestionsProps) {
  if (!open) {
    return null;
  }

  const needle = query.trim().toLocaleLowerCase();
  const suggestions = history
    .filter((item) => !needle || item.toLocaleLowerCase().includes(needle))
    .slice(0, MAX_VISIBLE_HISTORY);

  if (!suggestions.length) {
    return null;
  }

  return (
    <div className="search-history-popover" role="listbox" aria-label="Recent searches">
      <span className="search-history-popover__heading">Recent searches</span>
      {suggestions.map((item) => (
        <button
          key={item}
          type="button"
          className="search-history-popover__item"
          role="option"
          aria-selected={item.toLocaleLowerCase() === needle}
          onPointerDown={(event) => {
            // Keep the text field focused until the selection is applied.
            event.preventDefault();
          }}
          onClick={() => onSelect(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
