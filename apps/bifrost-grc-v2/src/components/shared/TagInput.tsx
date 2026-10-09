import { useMemo } from "react";
import TagCombobox from "./TagCombobox";

interface ParsedTags {
  tags: string[];
  preserved: unknown[];
}

function uniqueTags(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const tag = value.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return;
    seen.add(key);
    result.push(tag);
  });
  return result;
}

export function parseTagsJson(raw?: string | null): ParsedTags {
  if (!raw?.trim()) return { tags: [], preserved: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        tags: uniqueTags(parsed.filter((item): item is string => typeof item === "string")),
        preserved: parsed.filter((item) => typeof item !== "string"),
      };
    }
    return { tags: [], preserved: [parsed] };
  } catch {
    return {
      tags: uniqueTags(raw.split(/[\n,]+/)),
      preserved: [],
    };
  }
}

export function serializeTagsJson(tags: string[], preserved: unknown[] = []): string | null {
  const value = [...preserved, ...uniqueTags(tags)];
  return value.length > 0 ? JSON.stringify(value) : null;
}

interface TagInputProps {
  id: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  suggestions?: string[];
}

/**
 * A token editor for legacy `tags_json` columns. Non-string imported metadata
 * is retained byte-for-byte at the value level while users manage only tags.
 */
export default function TagInput({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "Add a tag…",
  suggestions = [],
}: TagInputProps) {
  const parsed = useMemo(() => parseTagsJson(value), [value]);

  return (
    <div className="cv-tag-editor">
      <TagCombobox
        id={id}
        value={parsed.tags}
        onChange={(tags) => onChange(serializeTagsJson(tags, parsed.preserved))}
        suggestions={suggestions}
        disabled={disabled}
        placeholder={placeholder}
      />
      <div className="cv-field-help">
        Choose an existing tag or press Enter to create one.
        {parsed.preserved.length > 0
          ? ` ${parsed.preserved.length} imported metadata entr${
              parsed.preserved.length === 1 ? "y is" : "ies are"
            } preserved automatically.`
          : ""}
      </div>
    </div>
  );
}
