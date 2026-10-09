import type {
  AppliedControl,
  AppliedControlStatus,
  ReviewStatus,
} from "./types";
import type { StateOption } from "../components/shared/StateSegmented";

export type AppliedControlState =
  | "draft"
  | "needs_review"
  | "active"
  | "partial"
  | "retired"
  | "rejected";

export const APPLIED_CONTROL_STATE_OPTIONS: Array<StateOption<AppliedControlState>> = [
  { value: "draft", label: "Draft", tone: "neutral" },
  { value: "needs_review", label: "Needs review", tone: "gold" },
  { value: "active", label: "Active", tone: "green" },
  { value: "partial", label: "Partial", tone: "teal" },
  { value: "retired", label: "Retired", tone: "purple" },
  { value: "rejected", label: "Rejected", tone: "red" },
];

export function appliedControlState(
  row: Pick<AppliedControl, "status" | "review_status">,
): AppliedControlState {
  if (row.review_status === "rejected") return "rejected";
  if (row.status === "retired") return "retired";
  if (row.review_status === "needs_review") return "needs_review";
  if (row.review_status === "draft") return "draft";
  if (row.status === "partial") return "partial";
  return "active";
}

export function appliedControlStatePatch(
  state: AppliedControlState,
): { status: AppliedControlStatus; review_status: ReviewStatus } {
  switch (state) {
    case "draft":
      return { status: "planned", review_status: "draft" };
    case "needs_review":
      return { status: "planned", review_status: "needs_review" };
    case "partial":
      return { status: "partial", review_status: "approved" };
    case "retired":
      return { status: "retired", review_status: "approved" };
    case "rejected":
      return { status: "retired", review_status: "rejected" };
    default:
      return { status: "active", review_status: "approved" };
  }
}

const TYPE_ALIASES: Record<string, string> = {
  technical: "technical",
  technology: "technical",
  administrative: "administrative",
  "administrative / policy": "administrative",
  "administrative/policy": "administrative",
  policy: "administrative",
  process: "process",
  procedural: "process",
  physical: "physical",
  compensating: "compensating",
};

export function normalizeControlType(value?: string | null): string {
  const normalized = (value ?? "").trim().toLocaleLowerCase().replace(/_/g, " ");
  if (TYPE_ALIASES[normalized]) return TYPE_ALIASES[normalized];
  if (normalized.includes("technical") || normalized.includes("technology")) return "technical";
  if (normalized.includes("administrative") || normalized.includes("policy")) return "administrative";
  if (normalized.includes("process") || normalized.includes("procedure") || normalized === "questionnaire") return "process";
  if (normalized.includes("physical")) return "physical";
  if (normalized.includes("compensat")) return "compensating";
  return normalized;
}
