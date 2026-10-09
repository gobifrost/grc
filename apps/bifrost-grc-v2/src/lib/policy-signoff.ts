export type PolicySignoffStatus = "signed" | "not_signed" | "waived" | "overdue";
export type PolicyNotificationStatus = "requested" | "sent" | "failed" | "no_listener";

export interface PolicyNotification {
  kind?: "invite" | "reminder";
  status?: PolicyNotificationStatus;
  requested_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
}

export function nextPolicyMinorVersion(version: string | null | undefined): string {
  const match = /^(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) throw new Error("The policy version must use major.minor format before its content can change.");
  return `${match[1]}.${Number(match[2]) + 1}`;
}

export interface PolicySignoffAssignment {
  assignment_id?: string;
  id?: string;
  name?: string;
  email?: string;
  status?: PolicySignoffStatus;
  accepted_at?: string | null;
  last_reminded_at?: string | null;
  reminders_sent?: number;
  waiver_reason?: string | null;
  last_notice?: PolicyNotification | null;
}

export interface PolicyCampaignSummary {
  id?: string;
  campaign_id?: string;
  title?: string;
  policy_ids?: string[];
  policies?: Array<{ id?: string; name?: string; version?: string }>;
  sent_at?: string | null;
  sent_date?: string | null;
  due_date?: string | null;
  required?: number;
  accepted?: number;
  waived?: number;
  outstanding?: number;
  policy_version_changed?: boolean;
  link_url?: string | null;
  has_no_listener?: boolean;
  counts?: { required?: number; accepted?: number; waived?: number; outstanding?: number };
}

export function noticePresentation(notice: PolicyNotification | null | undefined): { label: string; tooltip: string } {
  switch (notice?.status) {
    case "requested": return { label: "Requested", tooltip: "Requested" };
    case "sent": return { label: "Sent", tooltip: "Sent" };
    case "failed": return { label: "Failed", tooltip: `Failed${notice.error ? `: ${notice.error}` : ""}` };
    case "no_listener": return { label: "No Listener", tooltip: "No Listener" };
    default: return { label: "No Notices", tooltip: "No notices have been requested" };
  }
}

export function notificationRequestPresentation(requested: number, failed: number): { title: string; message: string } {
  const failedSuffix = failed ? ` ${failed} request${failed === 1 ? " needs" : "s need"} attention.` : "";
  if (!requested) return { title: "Email Requests Need Attention", message: `No email requests were published.${failedSuffix}` };
  return { title: "Email Requests Published", message: `GRC published email requests for ${requested} ${requested === 1 ? "person" : "people"}.${failedSuffix}` };
}

export function campaignSummary(assignments: Array<Pick<PolicySignoffAssignment, "status">>) {
  let signed = 0;
  let waived = 0;
  let outstanding = 0;
  for (const assignment of assignments) {
    if (assignment.status === "waived") waived += 1;
    else if (assignment.status === "signed") signed += 1;
    else outstanding += 1;
  }
  return { required: signed + outstanding, signed, waived, outstanding };
}

export function filterPolicyAssignments(assignments: PolicySignoffAssignment[], filter: "all" | PolicySignoffStatus): PolicySignoffAssignment[] {
  return assignments.filter((assignment) => filter === "all" || assignment.status === filter || (filter === "not_signed" && assignment.status === "overdue"));
}

export function isRecentReminder(lastRemindedAt: string | null | undefined, now = new Date()): boolean {
  if (!lastRemindedAt) return false;
  const remindedAt = new Date(lastRemindedAt).getTime();
  return Number.isFinite(remindedAt) && now.getTime() - remindedAt < 24 * 60 * 60 * 1000;
}

export function campaignId(campaign: PolicyCampaignSummary | null | undefined): string | null {
  return campaign?.campaign_id ?? campaign?.id ?? null;
}

export function campaignIncludesPolicy(campaign: PolicyCampaignSummary, policyId: string): boolean {
  return campaign.policy_ids?.includes(policyId) ?? campaign.policies?.some((policy) => policy.id === policyId) ?? false;
}

export function signoffLabel(campaign: PolicyCampaignSummary | undefined): string {
  if (!campaign) return "Not sent";
  const accepted = campaign.counts?.accepted ?? campaign.accepted ?? 0;
  const required = campaign.counts?.required ?? campaign.required ?? 0;
  return required ? `${accepted} of ${required}` : "Not sent";
}
