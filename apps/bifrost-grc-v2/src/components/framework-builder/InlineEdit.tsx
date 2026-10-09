import { useEffect, useRef, useState } from "react";

interface InlineEditProps {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void | Promise<void>;
  multiline?: boolean;
  className?: string;
  mono?: boolean;
  autoFocus?: boolean;
  readOnly?: boolean;
  // optional display when value is empty AND not editing
  emptyLabel?: string;
}

/**
 * Click-to-edit text. Commits on blur or Enter (single-line) /
 * Shift+Enter newline ok in multiline. Escapes revert.
 */
export default function InlineEdit({
  value,
  placeholder,
  onCommit,
  multiline,
  className,
  mono,
  autoFocus,
  readOnly = false,
  emptyLabel,
}: InlineEditProps) {
  const [editing, setEditing] = useState(!!autoFocus);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      try {
        (inputRef.current as HTMLInputElement).select?.();
      } catch {
        /* noop */
      }
    }
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    if (draft === value) return;
    try {
      await onCommit(draft);
    } catch {
      /* parent handles toast — keep local draft to avoid surprising user */
    }
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const fontFamily = mono ? "var(--cv-font-mono)" : undefined;

  if (!editing) {
    const display = value?.length ? value : emptyLabel ?? placeholder ?? "—";
    const isEmpty = !value?.length;
    return (
      <span
        role={readOnly ? undefined : "button"}
        tabIndex={readOnly ? undefined : 0}
        onClick={readOnly ? undefined : () => setEditing(true)}
        onKeyDown={(e) => {
          if (!readOnly && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setEditing(true);
          }
        }}
        className={className}
        style={{
          cursor: readOnly ? "inherit" : "text",
          fontFamily,
          color: isEmpty ? "var(--cv-fg-3)" : undefined,
          fontStyle: isEmpty ? "italic" : undefined,
          display: "inline-block",
          minWidth: 24,
          padding: "2px 4px",
          margin: "-2px -4px",
          borderRadius: 4,
        }}
        onMouseEnter={readOnly ? undefined : (e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--cv-bg-3)";
        }}
        onMouseLeave={readOnly ? undefined : (e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        {display}
      </span>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={(el) => {
          inputRef.current = el;
        }}
        className={"cv-field " + (className ?? "")}
        style={{ fontFamily, minHeight: 60, width: "100%" }}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
        }}
      />
    );
  }

  return (
    <input
      ref={(el) => {
        inputRef.current = el;
      }}
      className={"cv-field " + (className ?? "")}
      style={{ fontFamily, width: "100%" }}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          cancel();
        }
      }}
    />
  );
}
