import { useEffect, useMemo, useState } from "react";
import { useWorkflowMutation, useWorkflowQuery } from "bifrost";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, ChevronLeft, CircleX, Clock3, Copy, Download, Loader2, Mail, Plus, Search, Send, UserPlus } from "lucide-react";
import { toast } from "sonner";

import BifrostDialogFrame from "@/components/shared/BifrostDialogFrame";
import PdfExportButton from "@/components/shared/PdfExportButton";
import EmptyState from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  WF_EXPORT_CAMPAIGN_PDF,
  WF_DEFAULT_POLICY_RECIPIENTS,
  WF_EXPORT_POLICY_CAMPAIGN_EVIDENCE,
  WF_GET_POLICY_CAMPAIGN,
  WF_LIST_POLICY_CAMPAIGNS,
  WF_REISSUE_POLICY_CAMPAIGN,
  WF_REMIND_POLICY_ASSIGNEES,
  WF_SEND_POLICY_CAMPAIGN,
  WF_WAIVE_POLICY_ASSIGNMENT,
} from "@/lib/grc-tables";
import { useSignoffSubscriptions } from "@/lib/use-signoff-subscriptions";
import type { Policy } from "@/lib/types";
import {
  campaignId,
  campaignIncludesPolicy,
  campaignSummary,
  filterPolicyAssignments,
  isRecentReminder,
  noticePresentation,
  notificationRequestPresentation,
  type PolicyCampaignSummary,
  type PolicyNotification,
  type PolicySignoffAssignment,
} from "@/lib/policy-signoff";

interface Recipient { name: string; email: string; reason?: string }
interface RecipientResult { included?: Recipient[]; excluded?: Recipient[] }
interface CampaignListResult { campaigns?: PolicyCampaignSummary[] }
interface CampaignDetailResult extends PolicyCampaignSummary { assignments?: PolicySignoffAssignment[]; people?: PolicySignoffAssignment[]; campaign?: PolicyCampaignSummary }
export interface SignoffPreview { campaign?: PolicyCampaignSummary; people?: PolicySignoffAssignment[]; recipients?: RecipientResult; step?: 1 | 2 | 3 }
interface NotificationFailure { email?: string; reason?: string; error?: string }

function dateLabel(value?: string | null, withTime = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

function defaultDueDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return date.toISOString().slice(0, 10);
}

function normalizedEmail(value: string): string { return value.trim().toLowerCase(); }

function statusLabel(status?: PolicySignoffAssignment["status"]): string {
  if (status === "signed") return "Signed";
  if (status === "waived") return "Waived";
  if (status === "overdue") return "Overdue";
  return "Not Signed";
}

function statusClass(status?: PolicySignoffAssignment["status"]): string {
  if (status === "signed") return "cv-chip--green";
  if (status === "waived") return "cv-chip--purple";
  if (status === "overdue") return "cv-chip--red";
  return "cv-chip--gold";
}

export default function PolicySignoffTab(props: { policy: Policy; organizationId: string | null; canEdit: boolean; preview?: SignoffPreview }) {
  if (!props.organizationId) return <EmptyState icon={AlertCircle} title="Choose an Organization to Manage Sign-Off" body="Policy sign-off is tracked for one organization at a time." />;
  // Switching policy or organization starts a separate draft and subscription.
  return <SignoffWorkspace key={`${props.organizationId}:${props.policy.id}`} {...props} organizationId={props.organizationId} />;
}

function SignoffWorkspace({ policy, organizationId, canEdit, preview }: { policy: Policy; organizationId: string; canEdit: boolean; preview?: SignoffPreview }) {
  const [sendOpen, setSendOpen] = useState(Boolean(preview?.step));
  const params = useMemo(() => ({ organization_id: organizationId }), [organizationId]);
  const campaignsQuery = useWorkflowQuery<CampaignListResult>(WF_LIST_POLICY_CAMPAIGNS, params);
  const live = useSignoffSubscriptions(organizationId, !preview);
  useEffect(() => {
    if (live.revision) void campaignsQuery.refresh().catch(() => {});
  }, [live.revision, campaignsQuery.refresh]);
  const campaign = useMemo(() => preview ? preview.campaign : (campaignsQuery.data?.campaigns ?? []).find((item) => campaignIncludesPolicy(item, policy.id)), [preview, campaignsQuery.data?.campaigns, policy.id]);
  const activeCampaignId = campaignId(campaign);
  const initialLoading = !preview && !campaignsQuery.data && campaignsQuery.loading;
  const unavailable = !preview && !campaignsQuery.data && Boolean(campaignsQuery.error);

  return <div className="cv-signoff-tab">
    {!preview && (live.unavailable || campaignsQuery.error) ? <div className="cv-callout cv-callout--danger"><div className="cv-callout__body">{campaignsQuery.error ? "Couldn’t refresh policy sign-off." : "Live status updates are unavailable."} <button type="button" className="cv-inline-button" onClick={() => { live.retry(); void campaignsQuery.refresh().catch(() => {}); }}>Try again</button></div></div> : null}
    {initialLoading ? <div className="cv-signoff-loading"><Loader2 className="animate-spin" size={18} /> Loading sign-off status…</div> : unavailable ? null : activeCampaignId ? <>
      {canEdit ? <div className="cv-signoff-tab__actions"><button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setSendOpen(true)}><Send size={14} /> Send for Signature</button></div> : null}
      <CampaignTracker key={activeCampaignId} campaignId={activeCampaignId} campaign={campaign!} policy={policy} canEdit={canEdit} revision={live.revision} onReissued={() => { void campaignsQuery.refresh().catch(() => {}); }} preview={preview} />
    </> : <EmptyState icon={Mail} title="Nobody Has Been Asked to Sign This Policy Yet." body="Choose the people who should review this version and send them an invitation." cta={canEdit ? <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setSendOpen(true)}><Send size={14} /> Send for Signature</button> : null} />}
    {/* One stable dialog survives refreshes and the transition to a sent campaign. */}
    {canEdit ? <SendSignoffDialog policy={policy} organizationId={organizationId} open={sendOpen} onClose={() => setSendOpen(false)} onSent={() => { void campaignsQuery.refresh().catch(() => {}); }} preview={preview} /> : null}
  </div>;
}

function SendSignoffDialog({ policy, organizationId, open, onClose, onSent, preview }: { policy: Policy; organizationId: string; open: boolean; onClose: () => void; onSent: () => void; preview?: SignoffPreview }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(preview?.step ?? 1);
  const [recipients, setRecipients] = useState<RecipientResult>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [dueDate, setDueDate] = useState(defaultDueDate);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ requested?: number; failed_notifications?: NotificationFailure[] }>({});
  const defaults = useWorkflowMutation<RecipientResult>(WF_DEFAULT_POLICY_RECIPIENTS);
  const send = useWorkflowMutation<{ requested?: number; failed_notifications?: NotificationFailure[] }>(WF_SEND_POLICY_CAMPAIGN);

  useEffect(() => {
    if (!open) return;
    let current = true;
    if (preview?.recipients) { setRecipients(preview.recipients); setSelected(new Set((preview.recipients.included ?? []).map((item) => normalizedEmail(item.email)))); return; }
    setStep(1); setSearch(""); setName(""); setEmail(""); setDueDate(defaultDueDate()); setMessage(""); setResult({});
    defaults.mutate({ organization_id: organizationId }).then((data) => {
      if (!current) return;
      setRecipients(data ?? {});
      setSelected(new Set((data?.included ?? []).map((item) => normalizedEmail(item.email))));
    }).catch((error: unknown) => { if (current) toast.error(error instanceof Error ? error.message : "Couldn’t load recipients"); });
    return () => { current = false; };
  // The dialog opens one recipient selection per organization.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, organizationId, preview]);

  const allRecipients = useMemo(() => [...(recipients.included ?? []), ...(recipients.excluded ?? [])], [recipients]);
  const selectedRecipients = useMemo(() => allRecipients.filter((item) => selected.has(normalizedEmail(item.email))), [allRecipients, selected]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (items: Recipient[]) => !query ? items : items.filter((item) => `${item.name} ${item.email}`.toLowerCase().includes(query));
  }, [search]);
  const toggle = (recipient: Recipient) => setSelected((current) => { const next = new Set(current); const key = normalizedEmail(recipient.email); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const addRecipient = () => {
    if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) return toast.error("Enter a name and a valid email address.");
    const key = normalizedEmail(email);
    if (allRecipients.some((recipient) => normalizedEmail(recipient.email) === key)) return toast.error("That email address is already listed.");
    const next = { ...recipients, included: [...(recipients.included ?? []), { name: name.trim(), email: email.trim() }] };
    setRecipients(next); setSelected((current) => new Set([...current, key])); setName(""); setEmail("");
  };
  const submit = async () => {
    if (!selectedRecipients.length) return toast.error("Choose at least one person to request this policy for.");
    try {
      const response = await send.mutate({ organization_id: organizationId, policy_ids: [policy.id], recipients: selectedRecipients.map(({ name: recipientName, email: recipientEmail }) => ({ name: recipientName, email: recipientEmail })), due_date: dueDate || undefined, message: message.trim() || undefined });
      setResult(response ?? {}); setStep(4); onSent();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t publish policy email requests"); }
  };
  if (!open) return null;
  const included = filtered(recipients.included ?? []); const excluded = filtered(recipients.excluded ?? []);
  const requestOutcome = notificationRequestPresentation(result.requested ?? 0, result.failed_notifications?.length ?? 0);
  return <BifrostDialogFrame onDismiss={() => !send.loading && onClose()} dismissDisabled={send.loading} labelledBy="send-signoff-title" style={{ width: "min(760px, calc(100vw - 2rem))" }}>
    <div className="cv-dialog__header"><h2 id="send-signoff-title" className="cv-dialog__title">Send for Signature</h2><p className="cv-small" style={{ margin: "4px 0 0" }}>Step {Math.min(step, 3)} of 3 · {step === 1 ? "Recipients" : step === 2 ? "Details" : "Confirm"}</p></div>
    {step === 1 ? <div className="cv-signoff-send">
      <div className="cv-signoff-send__toolbar"><div className="cv-signoff-search"><Search size={14} /><Input aria-label="Search Recipients" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people" /></div><button type="button" className="cv-inline-button" onClick={() => setSelected(new Set(allRecipients.map((item) => normalizedEmail(item.email))))}>Select All</button><button type="button" className="cv-inline-button" onClick={() => setSelected(new Set())}>Select None</button></div>
      {defaults.loading ? <div className="cv-signoff-loading"><Loader2 className="animate-spin" size={18} /> Loading recipients…</div> : <>
        <RecipientGroup title={`Will Receive (${recipients.included?.length ?? 0})`} recipients={included} selected={selected} onToggle={toggle} />
        <RecipientGroup title={`Not Included (${recipients.excluded?.length ?? 0})`} recipients={excluded} selected={selected} onToggle={toggle} showReason />
        <div className="cv-signoff-add"><strong><UserPlus size={15} /> Add Someone</strong><Input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" /><Input aria-label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /><button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={addRecipient}><Plus size={14} /> Add</button></div>
      </>}
      <p className="cv-signoff-count"><strong>{selectedRecipients.length}</strong> {selectedRecipients.length === 1 ? "person will" : "people will"} be asked to sign.</p>
    </div> : null}
    {step === 2 ? <div className="cv-signoff-send"><label className="cv-signoff-field"><span>Due Date</span><Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label className="cv-signoff-field"><span>Message <em>Optional</em></span><Textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Add a short note to the invitation" /></label><EmailPreview policy={policy} dueDate={dueDate} message={message} /></div> : null}
    {step === 3 ? <div className="cv-signoff-confirm"><Mail size={24} /><h3>Ready to Request Emails for {selectedRecipients.length} People?</h3><p>GRC will request an email for each person.</p><p>Each request includes a personal link to review <strong>{policy.name}</strong>{dueDate ? ` by ${dateLabel(dueDate)}` : ""}.</p><EmailPreview policy={policy} dueDate={dueDate} message={message} /></div> : null}
    {step === 4 ? <div className="cv-signoff-confirm">{result.requested ? <Check size={28} /> : <AlertTriangle className="cv-signoff-confirm__attention" size={28} />}<h3>{requestOutcome.title}</h3><p>{requestOutcome.message}</p>{result.failed_notifications?.length ? <ul className="cv-signoff-failures">{result.failed_notifications.map((failure, index) => <li key={`${failure.email ?? "failure"}-${index}`}>{failure.email ?? "Unknown recipient"}: {failure.reason ?? failure.error ?? "Couldn’t publish email request"}</li>)}</ul> : null}</div> : null}
    <div className="cv-dialog__footer">{step < 4 ? <><button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => step === 1 ? onClose() : setStep((current) => (current - 1) as 1 | 2 | 3)} disabled={send.loading}>{step === 1 ? "Cancel" : <><ChevronLeft size={14} /> Back</>}</button><button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => step === 3 ? submit() : setStep((current) => (current + 1) as 2 | 3)} disabled={defaults.loading || (step === 1 && !selectedRecipients.length) || send.loading}>{send.loading ? <><Loader2 size={14} className="animate-spin" /> Requesting…</> : step === 3 ? `Request Emails for ${selectedRecipients.length} ${selectedRecipients.length === 1 ? "Person" : "People"}` : "Continue"}</button></> : <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={onClose}>Done</button>}</div>
  </BifrostDialogFrame>;
}

function RecipientGroup({ title, recipients, selected, onToggle, showReason = false }: { title: string; recipients: Recipient[]; selected: Set<string>; onToggle: (recipient: Recipient) => void; showReason?: boolean }) {
  return <section className="cv-signoff-recipient-group"><h3>{title}</h3>{recipients.length ? recipients.map((recipient) => { const checked = selected.has(normalizedEmail(recipient.email)); return <label className="cv-signoff-recipient" key={recipient.email}><input type="checkbox" checked={checked} onChange={() => onToggle(recipient)} /><span><strong>{recipient.name}</strong><small>{recipient.email}</small>{showReason && recipient.reason ? <small className="cv-signoff-recipient__reason">{recipient.reason}</small> : null}</span></label>; }) : <p className="cv-small">No matching people.</p>}</section>;
}

function EmailPreview({ policy, dueDate, message }: { policy: Policy; dueDate: string; message: string }) {
  return <section className="cv-signoff-preview"><strong>Email Preview</strong><p><b>Subject:</b> Please Review and Sign: {policy.name}</p><p>Hello,</p><p>Please review and sign {policy.name}{dueDate ? ` by ${dateLabel(dueDate)}` : ""}.{message.trim() ? ` ${message.trim()}` : ""}</p><p><b>Review and Sign</b></p></section>;
}

function NoticeStatusIcon({ notice }: { notice: PolicyNotification | null | undefined }) {
  const { tooltip } = noticePresentation(notice);
  if (!notice?.status) return <span>—</span>;
  const Icon = notice.status === "requested" ? Clock3 : notice.status === "sent" ? CheckCircle2 : notice.status === "failed" ? CircleX : AlertTriangle;
  return <span className={`cv-notice-status cv-notice-status--${notice.status}`} title={tooltip} aria-label={tooltip}><Icon size={16} aria-hidden="true" /><span className="sr-only">{tooltip}</span></span>;
}

function CampaignTracker({ campaignId: activeCampaignId, campaign, policy, canEdit, revision, onReissued, preview }: { campaignId: string; campaign: PolicyCampaignSummary; policy: Policy; canEdit: boolean; revision: number; onReissued: () => void; preview?: SignoffPreview }) {
  const detailQuery = useWorkflowQuery<CampaignDetailResult>(WF_GET_POLICY_CAMPAIGN, useMemo(() => ({ campaign_id: activeCampaignId }), [activeCampaignId]));
  useEffect(() => {
    if (revision) void detailQuery.refresh().catch(() => {});
  }, [revision, detailQuery.refresh]);
  const remind = useWorkflowMutation(WF_REMIND_POLICY_ASSIGNEES); const waive = useWorkflowMutation(WF_WAIVE_POLICY_ASSIGNMENT); const exportEvidence = useWorkflowMutation<{ download_url?: string; url?: string }>(WF_EXPORT_POLICY_CAMPAIGN_EVIDENCE); const reissue = useWorkflowMutation(WF_REISSUE_POLICY_CAMPAIGN);
  const [filter, setFilter] = useState<"all" | NonNullable<PolicySignoffAssignment["status"]>>("all"); const [waiveAssignment, setWaiveAssignment] = useState<PolicySignoffAssignment | null>(null); const [reason, setReason] = useState("");
  const detail = preview?.campaign ?? detailQuery.data?.campaign ?? detailQuery.data ?? campaign;
  const assignments = preview?.people ?? detailQuery.data?.people ?? detailQuery.data?.assignments ?? [];
  // Derive the heading and filters from the same complete detail rows as "All".
  const summary = campaignSummary(assignments);
  const policyVersionChanged = detail.policy_version_changed || campaign.policy_version_changed || detail.policies?.some((item) => item.id === policy.id && item.version !== policy.version);
  const filtered = filterPolicyAssignments(assignments, filter);
  const filterCounts = { all: assignments.length, not_signed: summary.outstanding, signed: summary.signed, waived: summary.waived, overdue: assignments.filter((assignment) => assignment.status === "overdue").length };
  const hasNoListener = Boolean(detail.has_no_listener ?? campaign.has_no_listener ?? assignments.some((assignment) => assignment.last_notice?.status === "no_listener"));
  const policyLink = detail.link_url ?? campaign.link_url ?? "/apps/policies";
  const remindPeople = async (assignmentIds?: string[]) => { try { const result = await remind.mutate({ campaign_id: activeCampaignId, assignment_ids: assignmentIds }) as { requested?: number; failed_notifications?: NotificationFailure[] }; const failed = result?.failed_notifications?.length ?? 0; const requested = result?.requested ?? 0; toast[failed || !requested ? "warning" : "success"](requested ? `GRC published reminder requests for ${requested} ${requested === 1 ? "person" : "people"}.${failed ? ` ${failed} request${failed === 1 ? " needs" : "s need"} attention.` : ""}` : `No reminder requests were published.${failed ? ` ${failed} request${failed === 1 ? " needs" : "s need"} attention.` : ""}`); await detailQuery.refresh(); } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t publish reminder requests"); } };
  const waivePerson = async () => { const id = waiveAssignment?.assignment_id ?? waiveAssignment?.id; if (!id || !reason.trim()) return toast.error("A waiver reason is required."); try { await waive.mutate({ assignment_id: id, reason: reason.trim() }); setWaiveAssignment(null); setReason(""); toast.success("Person waived from this policy."); await detailQuery.refresh(); } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t waive this person"); } };
  const downloadEvidence = async () => { try { const result = await exportEvidence.mutate({ campaign_id: activeCampaignId }); const url = result?.download_url ?? result?.url; if (url) window.open(url, "_blank", "noopener,noreferrer"); else toast.success("Evidence export created."); } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t export evidence"); } };
  const copyPolicyLink = async () => { try { await navigator.clipboard.writeText(policyLink); toast.success("Policies link copied."); } catch { toast.error("Couldn’t copy the policies link."); } };
  return <div className="cv-signoff-tracker">{!preview && detailQuery.data && detailQuery.error ? <div className="cv-callout cv-callout--danger"><div className="cv-callout__body">Couldn’t refresh campaign details. <button type="button" className="cv-inline-button" onClick={() => { void detailQuery.refresh().catch(() => {}); }}>Try again</button></div></div> : null}{!preview && !detailQuery.data && detailQuery.loading ? <div className="cv-signoff-loading"><Loader2 className="animate-spin" size={18} /> Loading campaign…</div> : !preview && !detailQuery.data && detailQuery.error ? <div className="cv-callout cv-callout--danger"><div className="cv-callout__body">Couldn’t load campaign details. <button type="button" className="cv-inline-button" onClick={() => detailQuery.refresh()}>Try again</button></div></div> : <>
    <header className="cv-signoff-tracker__header"><div><h2>{summary.signed} of {summary.required} Signed</h2><Progress value={summary.required ? summary.signed / summary.required * 100 : 0} /><dl><div><dt>Due Date</dt><dd>{dateLabel(detail.due_date ?? campaign.due_date)}</dd></div><div><dt>Sent Date</dt><dd>{dateLabel(detail.sent_date ?? detail.sent_at ?? campaign.sent_date ?? campaign.sent_at)}</dd></div><div><dt>Waived</dt><dd>{summary.waived}</dd></div></dl></div><div className="cv-signoff-tracker__actions">{canEdit ? <><button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => remindPeople()} disabled={!summary.outstanding || remind.loading}><Mail size={14} /> Remind Everyone Who Hasn’t Signed</button>{policyVersionChanged ? <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={async () => { try { await reissue.mutate({ campaign_id: activeCampaignId }); toast.success("A new campaign was issued."); onReissued(); } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t re-issue campaign"); } }} disabled={reissue.loading}>Re-issue</button> : null}</> : null}<button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={downloadEvidence} disabled={exportEvidence.loading}><Download size={14} /> Export Evidence (CSV)</button><PdfExportButton workflow={WF_EXPORT_CAMPAIGN_PDF} params={{ campaign_id: activeCampaignId }} label="Export Sign-Off PDF" /></div></header>
    {policyVersionChanged ? <div className="cv-callout cv-callout--warn"><div className="cv-callout__body">This policy version changed after the campaign was sent. Re-issue to ask current assignees to review the updated version.</div></div> : null}
    {hasNoListener ? <div className="cv-callout cv-callout--warn cv-signoff-listener-callout"><div className="cv-callout__body">Emails are not set up on this instance. GRC published the requests, but nothing is listening for <code>grc.policy.notification_requested</code>. People can still sign at <a href={policyLink} className="cv-inline-button">Policies</a>.</div><button type="button" className="cv-btn cv-btn--secondary cv-btn--xs" onClick={copyPolicyLink}><Copy size={13} /> Copy Link</button></div> : null}
    <div className="cv-signoff-filters" role="group" aria-label="Filter sign-off status">{(["all", "not_signed", "signed", "waived", "overdue"] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} className={`cv-btn cv-btn--sm cv-signoff-filter ${filter === value ? "cv-signoff-filter--selected" : "cv-btn--secondary"}`} onClick={() => setFilter(value)}>{filter === value ? <Check size={14} aria-hidden="true" /> : null}{value === "all" ? "All" : statusLabel(value)} ({filterCounts[value]})</button>)}</div>
    <div className="cv-signoff-table"><table><thead><tr><th>Person</th><th>Status</th><th>Signed On</th><th>Last Notice</th>{canEdit ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead><tbody>{filtered.map((assignment) => { const id = assignment.assignment_id ?? assignment.id ?? assignment.email ?? ""; const notice = assignment.last_notice; const recent = isRecentReminder(notice?.kind === "reminder" ? notice.requested_at : assignment.last_reminded_at); const actionable = assignment.status === "not_signed" || assignment.status === "overdue"; return <tr key={id}><td><strong>{assignment.name ?? "Unknown"}</strong><small>{assignment.email ?? "—"}</small></td><td><span className={`cv-chip ${statusClass(assignment.status)}`}>{statusLabel(assignment.status)}</span></td><td>{dateLabel(assignment.accepted_at)}</td><td><span className="cv-last-notice"><NoticeStatusIcon notice={notice} />{notice ? <span>{dateLabel(notice.requested_at)}</span> : null}</span></td>{canEdit ? <td className="cv-signoff-row-actions">{actionable ? <><button type="button" className="cv-btn cv-btn--ghost cv-btn--xs" onClick={() => remindPeople([id])} disabled={recent || remind.loading} title={recent ? "A reminder was requested within the last 24 hours." : "Request a Reminder"}>Remind</button><button type="button" className="cv-btn cv-btn--ghost cv-btn--xs" onClick={() => setWaiveAssignment(assignment)}>Waive</button></> : "—"}</td> : null}</tr>; })}</tbody></table>{!filtered.length ? <p className="cv-signoff-table__empty">No people match this filter.</p> : null}</div>
  </>}{waiveAssignment ? <BifrostDialogFrame onDismiss={() => setWaiveAssignment(null)} labelledBy="waive-assignment-title"><div className="cv-dialog__header"><h2 id="waive-assignment-title" className="cv-dialog__title">Waive Policy Sign-Off</h2><p className="cv-small">Explain why {waiveAssignment.name ?? "this person"} does not need to sign this policy.</p></div><label className="cv-signoff-field"><span>Reason</span><Textarea value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label><div className="cv-dialog__footer"><button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setWaiveAssignment(null)}>Cancel</button><button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={waivePerson} disabled={!reason.trim() || waive.loading}>{waive.loading ? "Saving…" : "Waive Sign-Off"}</button></div></BifrostDialogFrame> : null}</div>;
}
