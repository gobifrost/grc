import { useEffect, useState } from "react";

interface ImplementationSliderProps {
  value: number | undefined | null;
  onCommit: (pct: number) => void;
  disabled?: boolean;
}

export default function ImplementationSlider({
  value,
  onCommit,
  disabled,
}: ImplementationSliderProps) {
  const initial = Math.max(0, Math.min(100, Math.round(value ?? 0)));
  const [local, setLocal] = useState<number>(initial);

  // Keep in sync if parent value changes (e.g. workflow refresh).
  useEffect(() => {
    setLocal(Math.max(0, Math.min(100, Math.round(value ?? 0))));
  }, [value]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
      <input
        type="range"
        min={0}
        max={100}
        step={10}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={() => {
          if (local !== initial) onCommit(local);
        }}
        onTouchEnd={() => {
          if (local !== initial) onCommit(local);
        }}
        onKeyUp={() => {
          if (local !== initial) onCommit(local);
        }}
        style={{ flex: 1, accentColor: "var(--cv-cb)" }}
      />
      <span
        className="cv-mono"
        style={{
          minWidth: 44,
          textAlign: "right",
          fontSize: 13,
          color: "var(--cv-fg-1)",
        }}
      >
        {local}%
      </span>
    </div>
  );
}
