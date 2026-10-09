import type { RiskLevel } from "../../lib/types";
import { BfChip } from "@/components/bifrost/BfChip";

interface RiskBadgeProps {
  level: RiskLevel | string | null | undefined;
}

const MAP: Record<RiskLevel, { tone: "danger" | "warning" | "success"; label: string }> = {
  very_high: { tone: "danger", label: "Very High" },
  high: { tone: "danger", label: "High" },
  medium: { tone: "warning", label: "Medium" },
  low: { tone: "success", label: "Low" },
};

export default function RiskBadge({ level }: RiskBadgeProps) {
  if (!level) return <BfChip>—</BfChip>;
  const entry = MAP[level as RiskLevel];
  if (!entry) return <BfChip>{level}</BfChip>;
  return <BfChip tone={entry.tone}>{entry.label}</BfChip>;
}
