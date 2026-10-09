import BasePolicyOrganizationsTab, { type BasePolicyOrganizationsPreview } from "./BasePolicyOrganizationsTab";

const preview: BasePolicyOrganizationsPreview = {
  organizations: [
    { organization_id: "org-arcadia", organization_name: "Arcadia Inc.", addendum_policy_id: "addendum-arcadia", addendum_version: "1.0", accepted: 18, required: 21, last_sent: "2026-09-17T10:00:00Z" },
    { organization_id: "org-beacon", organization_name: "Beacon LLC", addendum_policy_id: "addendum-beacon", addendum_version: "1.2", accepted: 7, required: 9, last_sent: "2026-09-20T14:30:00Z" },
    { organization_id: "org-cascade", organization_name: "Cascade Group", addendum_policy_id: "addendum-cascade", addendum_version: "1.0", accepted: 4, required: 4, last_sent: "2026-09-21T09:15:00Z" },
  ],
  dryRun: {
    affected_organizations: [
      { organization_id: "org-arcadia", organization_name: "Arcadia Inc.", open_campaign_count: 1, assignee_count: 21 },
      { organization_id: "org-beacon", organization_name: "Beacon LLC", open_campaign_count: 1, assignee_count: 9 },
      { organization_id: "org-cascade", organization_name: "Cascade Group", open_campaign_count: 1, assignee_count: 4 },
    ],
  },
};

export default function BasePolicyOrganizationsFixture() {
  const dialogOpen = new URLSearchParams(window.location.search).get("dialog") === "open";
  return <main className="cv-signoff-preview-page">
    <p className="cv-small">POLICIES / AI ACCEPTABLE USE POLICY</p>
    <h1 className="cv-h1">AI Acceptable Use Policy</h1>
    <div className="cv-signoff-preview-tabs"><span>Preview</span><strong>Organizations</strong></div>
    <BasePolicyOrganizationsTab basePolicyId="preview-base-policy" canReissue preview={{ ...preview, dialogOpen }} />
  </main>;
}
