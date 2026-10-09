import { useState } from "react";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { useWorkflowMutation, useWorkflowQuery } from "bifrost";
import { toast } from "sonner";

import { BfDialog } from "@/components/bifrost/BfDialog";
import {
  WF_LIST_BASE_POLICY_ORGANIZATIONS,
  WF_REISSUE_FOR_BASE_POLICY,
} from "@/lib/grc-tables";
import {
  basePolicyOrganizationRows,
  type BasePolicyOrganizationResult,
} from "@/lib/base-policy-organizations";

interface OrganizationListResult {
  organizations?: BasePolicyOrganizationResult[];
}

interface ReissueOrganization {
  organization_id?: string;
  organization_name?: string;
  open_campaigns?: number | Array<unknown>;
  open_campaign_count?: number;
  assignee_count?: number;
}

interface ReissueResult {
  affected_organizations?: ReissueOrganization[];
  organizations?: ReissueOrganization[];
  open_campaigns?: Array<unknown>;
}

export interface BasePolicyOrganizationsPreview {
  organizations: BasePolicyOrganizationResult[];
  dryRun: ReissueResult;
  dialogOpen?: boolean;
}

function dateLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}


export default function BasePolicyOrganizationsTab({ basePolicyId, canReissue, preview }: { basePolicyId: string; canReissue: boolean; preview?: BasePolicyOrganizationsPreview }) {
  const organizationsQuery = useWorkflowQuery<OrganizationListResult>(
    WF_LIST_BASE_POLICY_ORGANIZATIONS,
    { base_policy_id: basePolicyId },
  );
  const reissue = useWorkflowMutation<ReissueResult>(WF_REISSUE_FOR_BASE_POLICY);
  const [dialogOpen, setDialogOpen] = useState(Boolean(preview?.dialogOpen));
  const [dryRun, setDryRun] = useState<ReissueResult | null>(preview?.dialogOpen ? preview.dryRun : null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [loadingDryRun, setLoadingDryRun] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const rows = basePolicyOrganizationRows(preview?.organizations ?? organizationsQuery.data?.organizations ?? []);
  const affected = dryRun?.affected_organizations ?? dryRun?.organizations ?? [];

  async function openReissueDialog() {
    setDialogOpen(true);
    if (preview) {
      setDryRun(preview.dryRun);
      return;
    }
    setDryRun(null);
    setDryRunError(null);
    setLoadingDryRun(true);
    try {
      setDryRun(await reissue.mutate({ base_policy_id: basePolicyId, confirm: false }));
    } catch (error) {
      setDryRunError(error instanceof Error ? error.message : "Could not prepare the re-issue dry run.");
    } finally {
      setLoadingDryRun(false);
    }
  }

  async function confirmReissue() {
    setConfirming(true);
    try {
      await reissue.mutate({ base_policy_id: basePolicyId, confirm: true });
      toast.success("Policy sign-off campaigns re-issued.");
      setDialogOpen(false);
      void organizationsQuery.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not re-issue policy sign-off campaigns.");
    } finally {
      setConfirming(false);
    }
  }

  if (!preview && organizationsQuery.loading) {
    return <div className="cv-signoff-loading"><Loader2 className="animate-spin" size={18} /> Loading organizations…</div>;
  }
  if (!preview && organizationsQuery.error) {
    return <div className="cv-callout cv-callout--danger"><div className="cv-callout__body">Couldn’t load organization addenda. <button type="button" className="cv-inline-button" onClick={() => organizationsQuery.refresh()}>Try again</button></div></div>;
  }

  return <div className="cv-base-policy-organizations">
    <div className="cv-base-policy-organizations__header">
      <div>
        <h2>Organizations</h2>
        <p>Each organization signs the parent policy with its own addendum.</p>
      </div>
      {canReissue ? <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={openReissueDialog}><RotateCcw size={14} /> Re-Issue to All Organizations…</button> : null}
    </div>

    {rows.length ? <div className="cv-signoff-table cv-base-policy-organizations__table">
      <table>
        <thead><tr><th>Organization</th><th>Addendum Version</th><th>Sign-Off</th><th>Last Sent</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.organizationId}>
          <td data-label="Organization"><strong>{row.organizationName}</strong></td>
          <td data-label="Addendum Version">v{row.addendumVersion}</td>
          <td data-label="Sign-Off">{row.signoff}</td>
          <td data-label="Last Sent">{dateLabel(row.lastSent)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <div className="cv-base-policy-organizations__empty"><AlertCircle size={18} /><span>No organization addenda have been prepared for this policy.</span></div>}

    <BfDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      title="Re-Issue to All Organizations"
      description="Review the affected organizations before sending new sign-off requests."
      footer={<>
        <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setDialogOpen(false)} disabled={confirming}>Cancel</button>
        <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={confirmReissue} disabled={loadingDryRun || Boolean(dryRunError) || affected.length === 0 || confirming}>
          {confirming ? <Loader2 className="animate-spin" size={14} /> : <RotateCcw size={14} />} Confirm and Re-Issue
        </button>
      </>}
    >
      <div className="cv-base-policy-reissue">
        {loadingDryRun ? <div className="cv-signoff-loading"><Loader2 className="animate-spin" size={18} /> Preparing dry run…</div> : null}
        {dryRunError ? <div className="cv-callout cv-callout--danger"><div className="cv-callout__body">{dryRunError}</div></div> : null}
        {dryRun && !affected.length ? <p className="cv-small">No organizations have an open campaign to re-issue.</p> : null}
        {affected.length ? <>
          <p className="cv-small">{peopleSummary(affected)}</p>
          <div className="cv-signoff-table cv-base-policy-reissue__table"><table><thead><tr><th>Organization</th><th>People</th></tr></thead>
            <tbody>{affected.map((organization, index) => <tr key={organization.organization_id ?? index}>
              <td data-label="Organization"><strong>{organization.organization_name || organization.organization_id || "Unknown Organization"}</strong></td>
              <td data-label="People">{organization.assignee_count ?? "—"}</td>
            </tr>)}</tbody>
          </table></div>
        </> : null}
      </div>
    </BfDialog>
  </div>;
}

// The decision before re-issuing is how many people get asked again, so lead with that.
function peopleSummary(affected: Array<{ assignee_count?: number }>): string {
  const people = affected.reduce((total, organization) => total + (organization.assignee_count ?? 0), 0);
  const orgs = `${affected.length} organization${affected.length === 1 ? "" : "s"}`;
  return people ? `This will ask ${people} ${people === 1 ? "person" : "people"} at ${orgs} to review and sign again.` : `This will re-issue sign-off requests for ${orgs}.`;
}
