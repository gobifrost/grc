interface ProgressRingProps {
  value: number; // 0–100
  size?: number;
  strokeWidth?: number;
  label?: string;
  sublabel?: string;
  // visual tone — defaults: <50 warn, <80 teal, >=80 good
  tone?: "auto" | "good" | "warn" | "bad" | "teal";
  ariaLabel?: string;
}

function toneClass(tone: ProgressRingProps["tone"], pct: number): string {
  if (tone === "good") return "cv-ring__fill--good";
  if (tone === "warn") return "cv-ring__fill--warn";
  if (tone === "bad") return "cv-ring__fill--bad";
  if (tone === "teal") return "";
  // auto
  if (pct >= 80) return "cv-ring__fill--good";
  if (pct < 40) return "cv-ring__fill--warn";
  return "";
}

export default function ProgressRing({
  value,
  size = 72,
  strokeWidth = 6,
  label,
  sublabel,
  tone = "auto",
  ariaLabel,
}: ProgressRingProps) {
  const safe = Math.max(0, Math.min(100, Math.round(value || 0)));
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - safe / 100);
  const fillCls = toneClass(tone, safe);
  const labelSize = size <= 52 ? 8 : size <= 72 ? 12 : 15;
  const labelPadding = size <= 52 ? 10 : 8;

  return (
    <div
      className="cv-ring"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={ariaLabel ?? sublabel ?? "Progress"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={safe}
      aria-valuetext={`${safe}%`}
    >
      <svg className="cv-ring__svg" width={size} height={size} aria-hidden="true">
        <circle
          className="cv-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={strokeWidth}
        />
        <circle
          className={"cv-ring__fill " + fillCls}
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={strokeWidth}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div
        className="cv-ring__label"
        style={{ fontSize: labelSize, paddingInline: labelPadding }}
        aria-hidden="true"
      >
        <span>{label ?? `${safe}%`}</span>
        {sublabel ? <span className="cv-ring__label-sub">{sublabel}</span> : null}
      </div>
    </div>
  );
}
