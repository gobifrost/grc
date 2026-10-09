import type { CSSProperties } from "react";

export type StateTone = "neutral" | "teal" | "green" | "gold" | "red" | "purple";

export interface StateOption<T extends string> {
  value: T;
  label: string;
  tone?: StateTone;
}

interface StateSegmentedProps<T extends string> {
  value: T;
  options: Array<StateOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  compact?: boolean;
  style?: CSSProperties;
}

/**
 * Canonical finite-state control for GRC records. The selected state is both
 * text-labelled and color-coded; every option receives equal space.
 */
export default function StateSegmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  compact = false,
  style,
}: StateSegmentedProps<T>) {
  return (
    <div
      className={`cv-state-group${compact ? " cv-state-group--compact" : ""}`}
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        ...style,
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            data-selected={selected ? "true" : "false"}
            data-tone={option.tone ?? "neutral"}
            className="cv-state-group__option"
            onClick={() => onChange(option.value)}
          >
            <span className="cv-state-group__dot" aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
