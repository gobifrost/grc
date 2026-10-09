import type { RiskStatus } from "../../lib/types";

interface RiskStatusChipProps {
  status?: RiskStatus | string | null;
}

const MAP: Record<RiskStatus, { cls: string; label: string }> = {
  open: { cls: "cv-chip--gold", label: "Open" },
  mitigated: { cls: "cv-chip--teal", label: "Mitigated" },
  accepted: { cls: "cv-chip--purple", label: "Accepted" },
  closed: { cls: "cv-chip--green", label: "Closed" },
};

export default function RiskStatusChip({ status }: RiskStatusChipProps) {
  if (!status) return <span className="cv-chip cv-chip--neutral">—</span>;
  const entry = MAP[status as RiskStatus];
  if (!entry) return <span className="cv-chip cv-chip--neutral">{status}</span>;
  return <span className={"cv-chip " + entry.cls}>{entry.label}</span>;
}
