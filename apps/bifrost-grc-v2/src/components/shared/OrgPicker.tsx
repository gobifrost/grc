import { useMemo } from "react";
import ThemedSelect, { type ThemedSelectOption } from "./ThemedSelect";
import { useOrgsList } from "../../lib/directory";

interface OrgPickerProps {
  value: string | null;
  onChange: (orgId: string | null) => void;
  allowGlobal?: boolean;
  label?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
}

const GLOBAL_SENTINEL = "__global__";

export default function OrgPicker({
  value,
  onChange,
  allowGlobal = true,
  label,
  required = false,
  placeholder = "Select organization…",
  disabled = false,
  autoFocus = false,
  id,
}: OrgPickerProps) {
  const { orgs, isLoading, isError } = useOrgsList();

  const options: ThemedSelectOption[] = useMemo(() => {
    const opts: ThemedSelectOption[] = [];
    if (allowGlobal) {
      opts.push({ label: "Global (no org)", value: GLOBAL_SENTINEL, hint: "all orgs" });
    }
    for (const org of orgs) {
      opts.push({ label: org.name, value: org.id, hint: org.domain ?? undefined });
    }
    return opts;
  }, [orgs, allowGlobal]);

  const selectValue = value ?? (allowGlobal ? GLOBAL_SENTINEL : "");

  const handleChange = (v: string) => {
    if (v === GLOBAL_SENTINEL) onChange(null);
    else onChange(v);
  };

  const placeholderText = isLoading
    ? "Loading organizations…"
    : isError
    ? "Couldn't load orgs"
    : placeholder;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label ? (
        <label className="cv-field-label" htmlFor={id}>
          {label}
          {required ? <span style={{ color: "var(--cv-red)" }}> *</span> : null}
        </label>
      ) : null}
      <ThemedSelect
        id={id}
        value={selectValue}
        onChange={handleChange}
        options={options}
        placeholder={placeholderText}
        disabled={disabled || isLoading || isError}
        searchable
        ariaLabel={label ?? "Organization"}
        autoFocus={autoFocus}
      />
    </div>
  );
}
