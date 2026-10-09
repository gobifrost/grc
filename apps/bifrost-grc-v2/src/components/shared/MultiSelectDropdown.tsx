import { useState } from "react";
import { BfMultiSelect } from "@/components/bifrost/BfCombobox";

export interface MultiSelectOption {
  value: string;
  label: string;
  hint?: string;
}

interface MultiSelectDropdownProps {
  label: string;
  options: MultiSelectOption[];
  selectedValues: string[];
  onToggle: (value: string, selected: boolean) => Promise<void> | void;
  disabled?: boolean;
  placeholder?: string;
  emptyText?: string;
  hint?: string;
}

/** Registry multi-select adapter that preserves immediate relationship saves. */
export default function MultiSelectDropdown({
  label,
  options,
  selectedValues,
  onToggle,
  disabled = false,
  placeholder = "Select records…",
  emptyText = "No records match.",
  hint = "Selections save immediately.",
}: MultiSelectDropdownProps) {
  const [saving, setSaving] = useState(false);

  const update = (nextValues: string[]) => {
    if (saving) return;
    const previous = new Set(selectedValues);
    const next = new Set(nextValues);
    const changes = [
      ...nextValues.filter((value) => !previous.has(value)).map((value) => [value, true] as const),
      ...selectedValues.filter((value) => !next.has(value)).map((value) => [value, false] as const),
    ];
    if (!changes.length) return;
    setSaving(true);
    void (async () => {
      try {
        for (const [value, selected] of changes) await onToggle(value, selected);
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <BfMultiSelect
      label={label}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.hint,
      }))}
      value={selectedValues}
      onValueChange={update}
      disabled={disabled}
      loading={saving}
      placeholder={placeholder}
      searchPlaceholder={`Search ${label.toLocaleLowerCase()}`}
      emptyText={emptyText}
      maxDisplayedItems={2}
      showBulkActions
      hint={saving ? "Saving selection…" : hint}
    />
  );
}
