import type {
  AssessmentStatus,
  ControlStatus,
  PolicyStatus,
  ExceptionStatus,
} from "../../lib/types";
import { BfChip } from "@/components/bifrost/BfChip";

type Kind = "assessment" | "policy" | "exception" | "control";

interface StatusBadgeProps {
  kind: Kind;
  value: string | null | undefined;
}

type ChipTone = "neutral" | "info" | "success" | "warning" | "danger";
const ASSESSMENT_MAP: Record<AssessmentStatus, { tone: ChipTone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  in_progress: { tone: "info", label: "In Progress" },
  completed: { tone: "success", label: "Completed" },
  reviewed: { tone: "info", label: "Reviewed" },
};

const POLICY_MAP: Record<PolicyStatus, { tone: ChipTone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  active: { tone: "success", label: "Active" },
  archived: { tone: "warning", label: "Archived" },
};

const EXCEPTION_MAP: Record<ExceptionStatus, { tone: ChipTone; label: string }> = {
  pending: { tone: "warning", label: "Pending" },
  approved: { tone: "success", label: "Approved" },
  denied: { tone: "danger", label: "Denied" },
  expired: { tone: "danger", label: "Expired" },
};

const CONTROL_MAP: Record<ControlStatus, { tone: ChipTone; label: string }> = {
  compliant: { tone: "success", label: "Compliant" },
  partially_compliant: { tone: "warning", label: "Partial" },
  non_compliant: { tone: "danger", label: "Non-compliant" },
  not_assessed: { tone: "neutral", label: "Not assessed" },
  not_applicable: { tone: "neutral", label: "N/A" },
};

export default function StatusBadge({ kind, value }: StatusBadgeProps) {
  if (!value) return <BfChip>Unknown</BfChip>;
  let entry: { tone: ChipTone; label: string } | undefined;
  if (kind === "assessment") entry = ASSESSMENT_MAP[value as AssessmentStatus];
  else if (kind === "policy") entry = POLICY_MAP[value as PolicyStatus];
  else if (kind === "exception") entry = EXCEPTION_MAP[value as ExceptionStatus];
  else if (kind === "control") entry = CONTROL_MAP[value as ControlStatus];

  if (!entry) return <BfChip>{value}</BfChip>;
  return <BfChip tone={entry.tone}>{entry.label}</BfChip>;
}
