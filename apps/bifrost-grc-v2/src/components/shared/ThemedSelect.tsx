import { BfCombobox } from "@/components/bifrost/BfCombobox";

export interface ThemedSelectOption {
  label: string;
  value: string;
  hint?: string;
}

interface ThemedSelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: ThemedSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: Record<string, string | number>;
  searchable?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
  id?: string;
}

/** Compatibility adapter for existing call sites; interaction is registry-owned BfCombobox. */
export default function ThemedSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  className = "",
  style,
  ariaLabel = "Selection",
  id,
}: ThemedSelectProps) {
  return (
    <div className={`cv-combobox-adapter ${className}`.trim()} style={style}>
      <BfCombobox
        id={id}
        label={ariaLabel}
        value={value ?? ""}
        onValueChange={onChange}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.hint,
        }))}
        placeholder={placeholder}
        searchPlaceholder={`Search ${ariaLabel.toLocaleLowerCase()}`}
        disabled={disabled}
      />
    </div>
  );
}
