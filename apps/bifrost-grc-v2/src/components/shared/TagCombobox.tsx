import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";

interface TagComboboxProps {
  id: string;
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  disabled?: boolean;
  placeholder?: string;
}

function uniqueTags(values: string[]): string[] {
  const seen = new Set<string>();
  return values.reduce<string[]>((result, value) => {
    const tag = value.trim();
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
    return result;
  }, []);
}

/**
 * Tags are entered directly in the token field. Matching existing tags are
 * offered as autocomplete choices; any other value becomes a new tag.
 */
export default function TagCombobox({
  id,
  value,
  onChange,
  suggestions = [],
  disabled = false,
  placeholder = "Type to find or create a tag…",
}: TagComboboxProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const tags = useMemo(() => uniqueTags(value), [value]);

  const matching = useMemo(() => {
    const selected = new Set(tags.map((tag) => tag.toLocaleLowerCase()));
    const q = query.trim().toLocaleLowerCase();
    return uniqueTags(suggestions)
      .filter((tag) => !selected.has(tag.toLocaleLowerCase()))
      .filter((tag) => !q || tag.toLocaleLowerCase().includes(q))
      .slice(0, 8);
  }, [query, suggestions, tags]);

  const exactSuggestion = matching.find(
    (tag) => tag.toLocaleLowerCase() === query.trim().toLocaleLowerCase(),
  );
  const canCreate = Boolean(query.trim()) && !exactSuggestion;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const commit = (candidate = query) => {
    const next = candidate.trim().replace(/,+$/, "").trim();
    if (!next) return;
    onChange(uniqueTags([...tags, next]));
    setQuery("");
    setOpen(false);
  };

  const remove = (tag: string) => {
    onChange(tags.filter((candidate) => candidate !== tag));
  };

  return (
    <div ref={rootRef} className="cv-tag-combobox">
      <div className="cv-tag-editor__tokens">
        {tags.map((tag) => (
          <span key={tag} className="cv-tag-editor__tag">
            {tag}
            <button
              type="button"
              className="cv-tag-editor__remove"
              onClick={() => remove(tag)}
              disabled={disabled}
              aria-label={`Remove ${tag}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={`${id}-suggestions`}
          aria-expanded={open}
          className="cv-tag-editor__input"
          value={query}
          disabled={disabled}
          placeholder={tags.length === 0 ? placeholder : "Add another…"}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            if (query.trim()) commit();
            else setOpen(false);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") setOpen(false);
            if (event.key === "Backspace" && !query && tags.length > 0) {
              remove(tags[tags.length - 1]);
            }
          }}
        />
      </div>
      {open && (matching.length > 0 || canCreate) ? (
        <div id={`${id}-suggestions`} role="listbox" className="cv-tag-combobox__menu">
          {matching.map((tag) => (
            <button
              key={tag}
              type="button"
              role="option"
              aria-selected="false"
              className="cv-tag-combobox__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(tag)}
            >
              <Check size={13} aria-hidden="true" />
              <span>{tag}</span>
              <span className="cv-tag-combobox__hint">Existing</span>
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              role="option"
              aria-selected="false"
              className="cv-tag-combobox__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit()}
            >
              <Plus size={13} aria-hidden="true" />
              <span>Create “{query.trim()}”</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
