import PolicySignoffTab, { type SignoffPreview } from "./PolicySignoffTab";
import type { Policy } from "@/lib/types";

const policy = { id: "preview-policy", name: "AI Acceptable Use Policy", version: "1.1", status: "active" } as Policy;
const people: NonNullable<SignoffPreview["people"]> = [
  { assignment_id: "a1", name: "Amelia Parker", email: "amelia@example.test", status: "signed", accepted_at: "2026-09-22T14:30:00Z", last_notice: { kind: "invite", status: "sent", requested_at: "2026-09-17T10:00:00Z", completed_at: "2026-09-17T10:00:03Z" } },
  { assignment_id: "a2", name: "Ben Carter", email: "ben@example.test", status: "signed", accepted_at: "2026-09-23T10:00:00Z", last_notice: { kind: "invite", status: "sent", requested_at: "2026-09-17T10:00:00Z", completed_at: "2026-09-17T10:00:02Z" } },
  { assignment_id: "a3", name: "Dara Lee", email: "dara@example.test", status: "signed", accepted_at: "2026-09-24T09:00:00Z", last_notice: { kind: "invite", status: "sent", requested_at: "2026-09-17T10:00:00Z", completed_at: "2026-09-17T10:00:03Z" } },
  { assignment_id: "a4", name: "Elena Ruiz", email: "elena@example.test", status: "signed", accepted_at: "2026-09-25T15:00:00Z" },
  { assignment_id: "a5", name: "Marcus Chen", email: "marcus@example.test", status: "not_signed", last_notice: { kind: "reminder", status: "requested", requested_at: "2026-09-20T10:00:00Z" } },
  { assignment_id: "a6", name: "Priya Shah", email: "priya@example.test", status: "overdue", last_notice: { kind: "reminder", status: "failed", requested_at: "2026-09-20T10:00:00Z", error: "Provider unavailable" } },
  { assignment_id: "a7", name: "Tomas Reed", email: "tomas@example.test", status: "not_signed", last_notice: { kind: "invite", status: "no_listener", requested_at: "2026-09-17T10:00:00Z", error: "No notification listener is configured on this instance." } },
  { assignment_id: "a8", name: "Javier Gomez", email: "javier@example.test", status: "waived" },
];
const recipients = {
  included: people.slice(0, 3).map(({ name, email }) => ({ name: name!, email: email! })),
  excluded: [{ name: "Service Account", email: "svc@example.test", reason: "Looks like a service account" }],
};

export default function PolicySignoffPreview() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") ?? "tracker";
  const step = Number(params.get("step") || 1) as 1 | 2 | 3;
  const noListener = view === "no-listener";
  const trackerPeople = noListener ? people.map((person) => person.assignment_id === "a7" ? person : { ...person, last_notice: { kind: "invite" as const, status: "sent" as const, requested_at: "2026-09-17T10:00:00Z" } }) : people;
  const preview: SignoffPreview = view === "empty" ? { recipients } : {
    campaign: { campaign_id: "preview-campaign", policies: [{ id: policy.id, name: policy.name, version: policy.version }], sent_date: "2026-09-17T10:00:00Z", due_date: "2026-09-29T23:59:00Z", link_url: "/apps/policies", has_no_listener: noListener },
    people: trackerPeople,
    recipients,
    ...(view === "send" ? { step } : {}),
  };
  return <main className="cv-signoff-preview-page"><p className="cv-small">POLICIES / AI ACCEPTABLE USE POLICY</p><h1 className="cv-h1">AI Acceptable Use Policy</h1><div className="cv-signoff-preview-tabs"><span>Preview</span><strong>Sign-Off</strong></div><PolicySignoffTab policy={policy} organizationId="preview-org" canEdit preview={view === "live" ? undefined : preview} /></main>;
}
