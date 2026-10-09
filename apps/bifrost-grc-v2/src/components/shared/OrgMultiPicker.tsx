import { useMemo, useState } from "react";
import { Search, Check } from "lucide-react";
import { useOrgsList } from "../../lib/directory";

interface OrgMultiPickerProps {
  value: string[];
  onChange: (orgIds: string[]) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Multi-select org picker. Renders a searchable, scrollable list with a
 * checkbox per row. Used by the "Apply framework to organizations" flow.
 */
export default function OrgMultiPicker({
  value,
  onChange,
  label,
  placeholder = "Search organizations…",
  disabled = false,
}: OrgMultiPickerProps) {
  const { orgs, isLoading, isError } = useOrgsList();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orgs;
    return orgs.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.domain ?? "").toLowerCase().includes(q),
    );
  }, [orgs, query]);

  const selectedSet = useMemo(() => new Set(value), [value]);

  const toggle = (id: string) => {
    if (disabled) return;
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((o) => selectedSet.has(o.id));
  const toggleAllFiltered = () => {
    if (disabled) return;
    const next = new Set(selectedSet);
    if (allFilteredSelected) {
      filtered.forEach((o) => next.delete(o.id));
    } else {
      filtered.forEach((o) => next.add(o.id));
    }
    onChange(Array.from(next));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label ? <label className="cv-field-label">{label}</label> : null}
      <div style={{ position: "relative" }}>
        <Search
          size={13}
          style={{
            position: "absolute",
            left: 10,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--cv-fg-3)",
          }}
        />
        <input
          type="text"
          className="cv-field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={isLoading ? "Loading organizations…" : isError ? "Couldn't load orgs" : placeholder}
          disabled={disabled || isLoading || isError}
          style={{ paddingLeft: 30 }}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 12,
          color: "var(--cv-fg-3)",
        }}
      >
        <span>
          {value.length} selected · {filtered.length} shown
        </span>
        {filtered.length > 0 ? (
          <button
            type="button"
            className="cv-btn cv-btn--ghost cv-btn--sm"
            onClick={toggleAllFiltered}
            disabled={disabled}
            style={{ padding: "2px 8px" }}
          >
            {allFilteredSelected ? "Clear shown" : "Select all shown"}
          </button>
        ) : null}
      </div>
      <div
        style={{
          maxHeight: 260,
          overflowY: "auto",
          border: "1px solid var(--cv-border)",
          borderRadius: "var(--cv-r-md)",
          background: "var(--cv-bg-1)",
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: 16, color: "var(--cv-fg-3)", fontSize: 13 }}>
            {isLoading ? "Loading…" : "No organizations match."}
          </div>
        ) : (
          filtered.map((o) => {
            const selected = selectedSet.has(o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.id)}
                disabled={disabled}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "8px 12px",
                  background: selected ? "var(--cv-bg-3)" : "transparent",
                  border: 0,
                  borderBottom: "1px solid var(--cv-border)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  textAlign: "left",
                  color: "var(--cv-fg-1)",
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: "1px solid var(--cv-border)",
                    background: selected ? "var(--cv-action)" : "transparent",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {selected ? <Check size={12} style={{ color: "white" }} /> : null}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{o.name}</span>
                  {o.domain ? (
                    <span
                      className="cv-small"
                      style={{ marginLeft: 8, color: "var(--cv-fg-3)" }}
                    >
                      {o.domain}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
