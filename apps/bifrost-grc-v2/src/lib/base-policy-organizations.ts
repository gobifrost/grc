export interface BasePolicyOrganizationResult {
  organization_id?: string;
  organization_name?: string;
  addendum_policy_id?: string | null;
  addendum_version?: string | null;
  accepted?: number;
  required?: number;
  last_sent?: string | null;
}

export interface BasePolicyOrganizationRow {
  organizationId: string;
  organizationName: string;
  addendumPolicyId: string | null;
  addendumVersion: string;
  signoff: string;
  lastSent: string | null;
}

/** Normalizes the provider workflow response for the base policy's Organizations tab. */
export function basePolicyOrganizationRows(rows: BasePolicyOrganizationResult[]): BasePolicyOrganizationRow[] {
  return rows
    .filter((row) => Boolean(row.organization_id))
    .map((row) => {
      const accepted = Number.isFinite(row.accepted) ? row.accepted! : 0;
      const required = Number.isFinite(row.required) ? row.required! : 0;
      return {
        organizationId: String(row.organization_id),
        organizationName: String(row.organization_name || "Unknown Organization"),
        addendumPolicyId: row.addendum_policy_id ? String(row.addendum_policy_id) : null,
        addendumVersion: String(row.addendum_version || "—"),
        signoff: required > 0 ? `${accepted} of ${required}` : "Not sent",
        lastSent: row.last_sent || null,
      };
    })
    .sort((left, right) => left.organizationName.localeCompare(right.organizationName));
}
