import { useEffect, useMemo, useRef, useState } from "react";
import { BifrostHeader, useWorkflowMutation, useWorkflowQuery } from "bifrost";
import { usePdfBranding } from "./lib/pdf-branding";
import { Check, ChevronRight, Download, FileText, LoaderCircle, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";

import { addendumBundle, assignmentForId, assignmentVersionLabel, policySummary, splitAssignments } from "./lib/policy-viewer.js";

const GET_ASSIGNMENTS = "workflows/grc_v2/grc_policy_recipient.py::grc_v2_get_my_policy_assignments";
const EXPORT_ASSIGNMENT_PDF = "workflows/grc_v2/grc_exports.py::grc_v2_export_my_policy_assignment_pdf";
const RECORD_ACCEPTANCE = "workflows/grc_v2/grc_policy_recipient.py::grc_v2_record_policy_acceptance";

type Policy = { id: string; name: string; version?: string | null; content: string; policy_role?: string | null; base_policy_id?: string | null; organization_name?: string | null };
type Assignment = {
  assignment_id: string;
  campaign_id: string;
  status: "assigned" | "accepted";
  due_date?: string | null;
  accepted_at?: string | null;
  policies: Policy[];
  recipient_name?: string | null;
  stale?: boolean;
  superseded_by_assignment_id?: string | null;
};
type AssignmentsResult = { assignments?: Assignment[]; organization_name?: string | null };
type AcceptanceResult = { status?: string; acceptance?: { accepted_at?: string | null; actor_display_name?: string | null } };

const previewAssignments: Assignment[] = [
  {
    assignment_id: "preview-open",
    campaign_id: "preview-campaign",
    status: "assigned",
    due_date: "2026-10-15T23:59:00Z",
    recipient_name: "Taylor Morgan",
    policies: [
      { id: "preview-policy", name: "AI Acceptable Use Policy", version: "2.0", policy_role: "base", content: "## Approved AI Tools\n\nUse only the AI tools listed in your organization's addendum, signed in with your work account. Do not use personal or free AI accounts for work. Ask the contact named in the addendum before you try a different AI tool or connect one to email, files, or other systems.\n\n## What Not to Put Into AI\n\nDo not type, paste, or upload:\n\n- passwords, security codes, or account recovery details\n- payment card numbers, bank account numbers, or Social Security numbers\n- health or medical information about any person\n- anything your addendum lists as restricted\n\nUse client or customer information only in an approved tool, and only when your work needs it. If you are unsure whether something is sensitive, leave it out or ask.\n\n## Check the Work\n\nAI can be wrong and still sound confident. Check facts, numbers, and names before you use, send, or act on anything AI produced. You are responsible for your work, whether or not AI helped.\n\n## Decisions About People\n\nDo not let AI make decisions about hiring, pay, discipline, or whether a customer qualifies for something. A person must review and make those decisions.\n\n## Meetings and Recordings\n\nFollow your addendum's rule for AI meeting notes and recordings. Never record or transcribe anyone without telling them first.\n\n## Report Problems Right Away\n\nTell the contact named in your addendum right away if:\n\n- you put information into AI that you should not have\n- an AI tool shows you information you should not be able to see\n- an AI tool does something you did not ask it to do\n\nReporting a mistake quickly is always the right choice.\n\n## Acknowledgement\n\nI have read this policy and my organization's addendum, and I will follow them. I understand they may be updated, and that I will be asked to acknowledge changes.\n" },
      { id: "preview-addendum", name: "AI Acceptable Use Policy Addendum", version: "1.0", policy_role: "extension", base_policy_id: "preview-policy", organization_name: "Example Organization", content: "**Example Organization** · Owner: Pat Owner, Operations Manager · Effective October 1, 2026\n\n## Approved AI Tools\n\n**ChatGPT Enterprise and Claude Team**. The approved tools may connect to: Microsoft 365.\n\n## Also Never Enter\n\n- Client credentials\n\n## Client Information\n\nSome of our client contracts limit how their information may be used. Get your manager's approval before you put any client information into AI.\n\n## Meetings and Recordings\n\nAsk the IT team before you use AI to record, transcribe, or summarize a meeting or call.\n\n## Questions and Problems\n\nContact the IT team.\n" },
    ],
  },
  {
    assignment_id: "preview-signed",
    campaign_id: "preview-campaign-signed",
    status: "accepted",
    accepted_at: "2026-09-18T14:30:00Z",
    recipient_name: "Taylor Morgan",
    policies: [{ id: "preview-signed-policy", name: "Information Security", version: "2.1", content: "## Information Security\n\nKeep organization information secure and report anything that does not look right." }],
  },
];

function policyTitle(assignment: Assignment) {
  const bundle = addendumBundle(assignment.policies);
  if (bundle) return bundle.base.name;
  const names = assignment.policies.map((policy) => policy.name).filter(Boolean);
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] ?? "Policy";
}

function formatDate(value?: string | null, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

function isOverdue(assignment: Assignment) {
  return assignment.status === "assigned" && Boolean(assignment.due_date) && new Date(assignment.due_date!).getTime() < Date.now();
}

function policyVersion(assignment: Assignment) {
  const label = assignmentVersionLabel(assignment.policies);
  return label ? `${label} · ` : "";
}

function firstName(name?: string | null) {
  return name?.trim().split(/\s+/)[0] || "";
}

function AssignmentCard({ assignment }: { assignment: Assignment }) {
  const overdue = isOverdue(assignment);
  return (
    <article className="assignment-card">
      <div className="assignment-card__icon" aria-hidden="true"><FileText size={20} /></div>
      <div className="assignment-card__copy">
        <h3>{policyTitle(assignment)}</h3>
        <p className={overdue ? "is-overdue" : undefined}>{policyVersion(assignment)}{overdue ? "Overdue · " : ""}Due {formatDate(assignment.due_date)}</p>
      </div>
      <Link className="button button--primary assignment-card__action" to={`/sign/${assignment.assignment_id}`}>
        Review and Sign <ChevronRight size={18} aria-hidden="true" />
      </Link>
    </article>
  );
}

function PoliciesHome({ data, loading, error, onRetry }: {
  data: AssignmentsResult | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const assignments = data?.assignments ?? [];
  const { toSign, signed } = splitAssignments(assignments) as { toSign: Assignment[]; signed: Assignment[] };

  const organization = data?.organization_name || "Your organization";
  const total = toSign.length + signed.length;
  return (
    <main className="page-shell" aria-busy={loading}>
      <p className="eyebrow">{organization}</p>
      {/* The header already says "Policies", so the title carries the status instead. */}
      <h1>{loading || error ? "Policies" : toSign.length ? `${toSign.length} ${toSign.length === 1 ? "Policy" : "Policies"} to Sign` : "You’re All Set"}</h1>
      {!loading && !error && total > 0 ? <p className="page-lede">{toSign.length
        ? `${organization} asks everyone to read and sign the policies below. Each one takes a few minutes.`
        : `You’ve signed everything ${organization} has asked for. We’ll email you if anything new needs your signature.`}</p> : null}
      {error ? (
        <section className="notice notice--error" role="alert">
          <p>We couldn’t load your policies. Please try again.</p>
          <button className="button button--secondary" type="button" onClick={onRetry}><RefreshCw size={17} /> Try again</button>
        </section>
      ) : loading ? <PoliciesSkeleton /> : toSign.length === 0 && signed.length === 0 ? (
        <section className="empty-state"><Check size={28} aria-hidden="true" /><h2>You’re all caught up.</h2><p>There’s nothing waiting for your signature.</p></section>
      ) : (
        <div className="policy-groups">
          {toSign.length > 0 ? <section aria-labelledby="to-sign"><h2 id="to-sign">To Sign</h2><div className="assignment-list">{toSign.map((assignment) => <AssignmentCard key={assignment.assignment_id} assignment={assignment} />)}</div></section> : null}
          {signed.length > 0 ? <section aria-labelledby="signed"><h2 id="signed">Signed</h2><div className="signed-list">{signed.map((assignment) => <Link key={assignment.assignment_id} to={`/sign/${assignment.assignment_id}`} className="signed-row"><span>{policyTitle(assignment)}</span><span><Check size={14} aria-hidden="true" /> {policyVersion(assignment)}Signed {formatDate(assignment.accepted_at)}</span><ChevronRight size={18} aria-hidden="true" /></Link>)}</div></section> : null}
        </div>
      )}
      {!loading && !error ? <p className="page-help">Questions about a policy? Ask your manager or the contact named in the policy.</p> : null}
    </main>
  );
}

function PoliciesSkeleton() {
  return <div className="skeleton-list" role="status"><span className="sr-only">Loading policies</span><div /><div /><div /></div>;
}

function SuccessScreen({ assignment, acceptedAt, actorName }: { assignment: Assignment; acceptedAt?: string | null; actorName?: string | null }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const name = firstName(actorName || assignment.recipient_name);
  return <main className="page-shell success-screen"><div className="success-icon"><Check size={32} aria-hidden="true" /></div><h1 ref={headingRef} tabIndex={-1}>Signed. Thank you{name ? `, ${name}` : ""}.</h1><p>You signed {policySummary(assignment.policies)} · {formatDate(acceptedAt, true)}</p><AssignmentPdfExport assignmentId={assignment.assignment_id} /><Link className="back-link" to="/"><ChevronRight size={17} aria-hidden="true" /> Back to Your Policies</Link></main>;
}

function StaleNotice({ assignment }: { assignment: Assignment }) {
  return <section className="notice notice--warning" role="alert"><p>This policy was updated. Please review the new version.</p>{assignment.superseded_by_assignment_id ? <Link to={`/sign/${assignment.superseded_by_assignment_id}`}>Review the new policy</Link> : null}</section>;
}

function PolicyDocuments({ policies }: { policies: Policy[] }) {
  const bundle = addendumBundle(policies);
  if (bundle) return <div className="policy-documents"><article className="policy-content"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{withoutLeadingTitle(bundle.base.content, bundle.base.name)}</ReactMarkdown></article><article className="policy-content policy-content--addendum"><h2 className="policy-content__divider">Addendum for {bundle.organizationName}</h2><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ h1: ({ children }) => <h3>{children}</h3>, h2: ({ children }) => <h3>{children}</h3> }}>{bundle.extension.content}</ReactMarkdown></article></div>;
  return <div className="policy-documents">{policies.map((policy) => <article className="policy-content" key={policy.id}>{policies.length > 1 ? <h2 className="policy-content__divider">{policy.name}</h2> : null}<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ h1: ({ children }) => <h2>{children}</h2> }}>{withoutLeadingTitle(policy.content, policy.name)}</ReactMarkdown></article>)}</div>;
}

function AssignmentPdfExport({ assignmentId }: { assignmentId: string }) {
  const pdf = useWorkflowMutation<{ content_base64: string; filename: string; content_type: string }>(EXPORT_ASSIGNMENT_PDF);
  const branding = usePdfBranding();
  const [preparing, setPreparing] = useState(false);
  const [failed, setFailed] = useState(false);
  async function download() {
    setFailed(false);
    setPreparing(true);
    try {
      const result = await pdf.mutate({ assignment_id: assignmentId, branding: await branding.prepare() });
      if (!result?.content_base64 || result.content_type !== "application/pdf") throw new Error("Missing PDF");
      const bytes = Uint8Array.from(atob(result.content_base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url; link.download = result.filename || "policy.pdf";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setFailed(true); }
    finally { setPreparing(false); }
  }
  return <div className="policy-export"><button type="button" className="button button--secondary" onClick={download} disabled={branding.loading || preparing || pdf.loading}>{preparing ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}{preparing ? "Preparing PDF…" : "Download PDF"}</button>{failed ? <p role="alert">We couldn’t download the PDF. Please try again.</p> : null}</div>;
}

function SignHeading({ assignment }: { assignment: Assignment }) {
  return <div className="policy-page__heading"><Link to="/" className="back-link"><ChevronRight size={17} aria-hidden="true" /> Back to Your Policies</Link><p className="eyebrow">{assignment.status === "accepted" ? "Signed" : "Review and Sign"}</p><h1>{policyTitle(assignment)}</h1><p className="policy-page__meta">{assignmentVersionLabel(assignment.policies) || "Policy"}{assignment.due_date ? ` · Due ${formatDate(assignment.due_date)}` : ""}</p><AssignmentPdfExport assignmentId={assignment.assignment_id} /></div>;
}

function SignPolicy({ assignment, onAccepted }: { assignment: Assignment; onAccepted: (result: AcceptanceResult) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<"error" | "stale" | null>(null);
  const acceptance = useWorkflowMutation<AcceptanceResult>(RECORD_ACCEPTANCE);
  const isStale = assignment.stale || problem === "stale";
  const isAddendum = Boolean(addendumBundle(assignment.policies));
  const isMultiPolicy = assignment.policies.length !== 1 && !isAddendum;
  const signAction = isMultiPolicy ? "Sign Policies" : "Sign Policy";
  const signingAction = isMultiPolicy ? "Signing Policies…" : "Signing Policy…";

  async function sign() {
    setProblem(null);
    try {
      const result = await acceptance.mutate({ campaign_id: assignment.campaign_id });
      onAccepted(result);
    } catch (error) {
      setProblem(String(error).toLowerCase().includes("stale") ? "stale" : "error");
    }
  }

  return <main className="policy-page">
    <SignHeading assignment={assignment} />
    {isStale ? <StaleNotice assignment={assignment} /> : null}
    <PolicyDocuments policies={assignment.policies} />
    {problem === "error" ? <section className="notice notice--error" role="alert"><p>We couldn’t sign this policy. Your confirmation is still selected, so you can try again.</p><button className="button button--secondary" type="button" onClick={sign} disabled={acceptance.loading}>Try again</button></section> : null}
    {!isStale ? <div className="sign-bar"><label className="confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{isAddendum ? "I have read this policy and my organization's addendum, and will follow them." : isMultiPolicy ? "I have read these policies and will follow them." : "I have read this policy and will follow it."}</span></label><div className="sign-bar__action"><button className="button button--primary" type="button" disabled={!confirmed || acceptance.loading} onClick={sign}>{acceptance.loading ? <><LoaderCircle className="spin" size={18} /> {signingAction}</> : signAction}</button>{!confirmed ? <p>Tick the box to sign</p> : null}</div></div> : null}
  </main>;
}

function SignRoute({ assignments }: { assignments: Assignment[] }) {
  const { assignmentId } = useParams();
  const assignment = assignmentForId(assignments, assignmentId) as Assignment | undefined;
  const [accepted, setAccepted] = useState<AcceptanceResult | null>(null);
  if (!assignment) return <main className="page-shell"><section className="notice notice--error"><h1>Policy Not Found</h1><p>This policy may no longer be available.</p><Link className="back-link" to="/">Back to Your Policies</Link></section></main>;
  if (accepted) return <SuccessScreen assignment={assignment} acceptedAt={accepted.acceptance?.accepted_at} actorName={accepted.acceptance?.actor_display_name} />;
  if (assignment.status === "accepted") return <main className="policy-page"><SignHeading assignment={assignment} /><section className="notice notice--success"><Check size={19} aria-hidden="true" /><p>Signed on {formatDate(assignment.accepted_at, true)}</p></section><PolicyDocuments policies={assignment.policies} /></main>;
  return <SignPolicy assignment={assignment} onAccepted={setAccepted} />;
}

export default function App() {
  const assignmentsQuery = useWorkflowQuery<AssignmentsResult>(GET_ASSIGNMENTS, {});
  const fixture = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("fixture") : null;
  const fixtureData = fixture === "empty" ? { assignments: [], organization_name: "Acme Services" } : { assignments: previewAssignments, organization_name: "Acme Services" };
  const data = fixture ? fixtureData : assignmentsQuery.data;
  const assignments = useMemo(() => data?.assignments ?? [], [data?.assignments]);
  const signElement = fixture === "success" ? <SuccessScreen assignment={previewAssignments[0]} acceptedAt="2026-10-02T10:00:00Z" actorName="Taylor Morgan" /> : assignmentsQuery.loading && !fixture ? <main className="page-shell"><PoliciesSkeleton /></main> : <SignRoute assignments={assignments} />;
  return <div className="app"><BifrostHeader className="policies-header" title="Policies" /><div className="app-scroll"><Routes><Route index element={<PoliciesHome data={data} loading={assignmentsQuery.loading && !fixture} error={fixture ? null : assignmentsQuery.error} onRetry={() => { void assignmentsQuery.refresh(); }} />} /><Route path="sign/:assignmentId" element={signElement} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></div></div>;
}

// The page title already names the policy; drop a leading "# <name>" so it isn't repeated.
function withoutLeadingTitle(content: string, name: string): string {
  const match = /^\s*#{1,2}\s+(.+)\n+/.exec(content || "");
  return match && match[1].trim().toLowerCase() === (name || "").trim().toLowerCase() ? content.slice(match[0].length) : content;
}
