const SEARCH_HISTORY_KEY = "wavestack:search-history";
const SEARCH_HISTORY_LIMIT = 12;

export function readSearchHistory(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEARCH_HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, SEARCH_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(query: string): string[] {
  const normalized = query.trim();

  if (!normalized) {
    return readSearchHistory();
  }

  const next = [normalized, ...readSearchHistory().filter((item) => item.toLowerCase() !== normalized.toLowerCase())]
    .slice(0, SEARCH_HISTORY_LIMIT);
  window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  return next;
}
