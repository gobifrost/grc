export interface ScopedRow {
  organization_id?: string | null;
  applied_organizations?: string[] | null;
  excluded_organizations?: string[] | null;
}

export function isGlobal(row: ScopedRow | null | undefined): boolean {
  if (!row) return false;
  if ("applied_organizations" in row && row.applied_organizations === null) return true;
  if (Array.isArray(row.applied_organizations)) return false;
  return row.organization_id == null;
}

export function scopeOrgIds(row: ScopedRow | null | undefined): string[] | null {
  if (!row) return [];
  if (row.applied_organizations === null) return null;
  if (Array.isArray(row.applied_organizations)) return row.applied_organizations;
  if (row.organization_id) return [row.organization_id];
  return null;
}

export function excludedOrgIds(row: ScopedRow | null | undefined): string[] {
  return Array.isArray(row?.excluded_organizations) ? row.excluded_organizations : [];
}

export function appliesToOrg(row: ScopedRow | null | undefined, orgId: string): boolean {
  const applied = scopeOrgIds(row);
  if (applied === null) return !excludedOrgIds(row).includes(orgId);
  return applied.includes(orgId);
}

export function scopesOverlap(
  left: ScopedRow | null | undefined,
  right: ScopedRow | null | undefined,
): boolean {
  const leftApplied = scopeOrgIds(left);
  const rightApplied = scopeOrgIds(right);
  if (leftApplied === null && rightApplied === null) return true;
  if (leftApplied === null) return (rightApplied ?? []).some((id) => appliesToOrg(left, id));
  if (rightApplied === null) return leftApplied.some((id) => appliesToOrg(right, id));
  const rightSet = new Set(rightApplied);
  return leftApplied.some((id) => rightSet.has(id));
}

export function inheritedScope(
  row: ScopedRow,
): Pick<ScopedRow, "applied_organizations" | "excluded_organizations"> {
  return {
    applied_organizations: scopeOrgIds(row),
    excluded_organizations: excludedOrgIds(row),
  };
}

/** Row-level security can directly represent a global row or one tenant row. */
export function rowOrganizationIdForScope(
  appliedOrganizations: string[] | null,
  multiOrganizationFallback: string | null,
): string | null {
  if (appliedOrganizations === null) return null;
  if (appliedOrganizations.length === 1) return appliedOrganizations[0];
  return multiOrganizationFallback;
}

export function scopeLabel(
  row: ScopedRow | null | undefined,
  orgNameById?: Map<string, string>,
): string {
  const applied = scopeOrgIds(row);
  if (applied === null) {
    const excluded = excludedOrgIds(row);
    return excluded.length ? `All except ${excluded.length}` : "All";
  }
  if (applied.length === 0) return "None";
  if (applied.length === 1) return orgNameById?.get(applied[0]) ?? "1 organization";
  return `${applied.length} organizations`;
}
