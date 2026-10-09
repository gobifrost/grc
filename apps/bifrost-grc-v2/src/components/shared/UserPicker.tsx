import { useMemo } from "react";
import ThemedSelect, { type ThemedSelectOption } from "./ThemedSelect";
import { useUsersList, type UserEntry } from "../../lib/directory";

interface UserPickerProps {
  value: string | null;
  onChange: (userId: string | null, user?: UserEntry) => void;
  orgId?: string | null;
  label?: string;
  required?: boolean;
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  id?: string;
}

const CLEAR_SENTINEL = "__unassigned__";

/**
 * User picker backed by the platform-org `bifrost-users` mirror table.
 * Optionally filters by orgId. When allowClear is true, the first entry is
 * "Unassigned" and emits null.
 */
export default function UserPicker({
  value,
  onChange,
  orgId,
  label,
  required = false,
  placeholder = "Select user…",
  allowClear = true,
  disabled = false,
  id,
}: UserPickerProps) {
  const { users, isLoading, isError } = useUsersList(orgId);

  const options: ThemedSelectOption[] = useMemo(() => {
    const opts: ThemedSelectOption[] = [];
    if (allowClear) {
      opts.push({ label: "Unassigned", value: CLEAR_SENTINEL });
    }
    for (const u of users) {
      if (!u.id) continue;
      const label = u.name || u.email || u.id;
      opts.push({
        label,
        value: u.id,
        hint: u.email && u.email !== label ? u.email : undefined,
      });
    }
    if (value && !opts.some((option) => option.value === value)) {
      opts.push({ label: value, value, hint: "Existing value" });
    }
    return opts;
  }, [users, allowClear, value]);

  const selectValue = value ?? (allowClear ? CLEAR_SENTINEL : "");

  const handleChange = (v: string) => {
    if (v === CLEAR_SENTINEL) {
      onChange(null, undefined);
    } else {
      const u = users.find((x) => x.id === v);
      onChange(v, u);
    }
  };

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
        placeholder={
          isLoading
            ? "Loading users…"
            : isError
            ? "Couldn't load users"
            : placeholder
        }
        disabled={disabled || isLoading || isError}
        searchable
        ariaLabel={label ?? "User"}
      />
    </div>
  );
}
