const ACRONYMS: Record<string, string> = {
  grc: "GRC",
  ir: "IR",
  msp: "MSP",
  ssp: "SSP",
};
const LOWERCASE_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);

/** Turn stored identifiers and sentence-cased taxonomy values into UI labels. */
export function titleCase(value: unknown, fallback = "Other"): string {
  const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
  const normalized = text.split("_").join(" ").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  const words = normalized.split(" ");
  return words
    .map((word: string, index: number) => {
      const lower = word.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      if (index > 0 && index < words.length - 1 && LOWERCASE_WORDS.has(lower)) return lower;
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}
