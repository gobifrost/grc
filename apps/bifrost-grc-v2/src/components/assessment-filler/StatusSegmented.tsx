import type { ControlStatus } from "../../lib/types";

interface StatusSegmentedProps {
  value: ControlStatus | undefined | null;
  onChange: (next: ControlStatus) => void;
  disabled?: boolean;
  fullWidth?: boolean;
}

const OPTIONS: Array<{ value: ControlStatus; label: string }> = [
  { value: "compliant", label: "Compliant" },
  { value: "partially_compliant", label: "Partial" },
  { value: "non_compliant", label: "Non-comp." },
  { value: "not_assessed", label: "N/A" },
];

export default function StatusSegmented({ value, onChange, disabled, fullWidth = false }: StatusSegmentedProps) {
  return (
    <div
      className={"cv-segmented cv-segmented--equal" + (fullWidth ? " cv-segmented--full" : "")}
      role="radiogroup"
      aria-label="Control status"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={"cv-segmented__btn " + (active ? "cv-segmented__btn--active" : "")}
            onClick={(e) => {
              e.stopPropagation();
              if (!active) onChange(opt.value);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
