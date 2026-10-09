const FACT_MARKER_SOURCE = String.raw`\{\{fact:((?:[a-z0-9_.-]|\\[_.-])+)(?:\|([^}]+))?\}\}`;

function factMarkerPattern(): RegExp {
  return new RegExp(FACT_MARKER_SOURCE, "gi");
}

export function normalizeFactKey(key: string): string {
  return key.replace(/\\([_.-])/g, "$1");
}

/** TipTap escapes Markdown punctuation, including underscores inside fact keys. */
export function normalizeFactMarkers(source: string): string {
  return source.replace(factMarkerPattern(), (_marker, key: string, fallback?: string) => (
    `{{fact:${normalizeFactKey(key)}${fallback === undefined ? "" : `|${fallback}`}}}`
  ));
}

export function extractFactKeys(source: string | null | undefined): string[] {
  return Array.from(new Set(
    Array.from((source ?? "").matchAll(factMarkerPattern())).map((match) => normalizeFactKey(match[1])),
  ));
}

export function replaceFactMarkers(
  source: string,
  replace: (key: string, fallback?: string) => string,
): string {
  return source.replace(factMarkerPattern(), (_marker, key: string, fallback?: string) => (
    replace(normalizeFactKey(key), fallback)
  ));
}
