import type { ReactNode } from "react";

import type { LucideIcon } from "lucide-react";
interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  iconTone?: "teal" | "gold" | "green" | "red" | "purple";
  numberTone?: "neutral" | "good" | "warn" | "bad" | "accent";
}

const TONE_TO_CLS: Record<NonNullable<StatTileProps["iconTone"]>, string> = {
  teal: "",
  gold: "cv-stat-tile__icon--gold",
  green: "cv-stat-tile__icon--green",
  red: "cv-stat-tile__icon--red",
  purple: "cv-stat-tile__icon--purple",
};

export default function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  iconTone = "teal",
  numberTone = "neutral",
}: StatTileProps) {
  const numCls =
    numberTone === "good"
      ? "cv-stat-tile__num--good"
      : numberTone === "warn"
      ? "cv-stat-tile__num--warn"
      : numberTone === "bad"
      ? "cv-stat-tile__num--bad"
      : numberTone === "accent"
      ? "cv-stat-tile__num--accent"
      : "";

  return (
    <div className="cv-stat-tile">
      <div className="cv-stat-tile__top">
        {Icon ? (
          <span className={`cv-stat-tile__icon ${TONE_TO_CLS[iconTone]}`}>
            <Icon size={16} />
          </span>
        ) : null}
        <span className="cv-stat-tile__label">{label}</span>
      </div>
      <div className={`cv-stat-tile__num ${numCls}`}>{value}</div>
      {sub ? <div className="cv-stat-tile__sub">{sub}</div> : null}
    </div>
  );
}
