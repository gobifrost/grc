import { useMemo } from "react";
import ThemedSelect from "./ThemedSelect";
import { useOrgsList } from "../../lib/directory";
import { useOrganizationView } from "../../lib/organization-view";

/**
 * Standard organization filter for list pages. Encapsulates the orgs fetch and
 * always offers "All orgs" + "Global (no org)" so every list filters orgs the
 * same way. Value semantics match the shared `grc-org-filter` app state:
 *   null          → all orgs
 *   "__global__"  → global (organization_id is null)
 *   <org id>      → that org
 */
export const GLOBAL_FILTER = "__global__";

interface OrgFilterSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  includeGlobal?: boolean;
  minWidth?: number;
}

export default function OrgFilterSelect({
  value,
  onChange,
  includeGlobal = false,
  minWidth = 220,
}: OrgFilterSelectProps) {
  const { orgs } = useOrgsList();
  const { organizationId, canSwitchOrganizations } = useOrganizationView();

  if (!canSwitchOrganizations) {
    const label = orgs.find((org) => org.id === organizationId)?.name ?? "Your organization";
    return <div className="cv-field" style={{ minWidth, opacity: 0.75 }}>{label}</div>;
  }

  const options = useMemo(
    () => [
      { label: "All orgs", value: "__all__" },
      ...(includeGlobal ? [{ label: "Global (no org)", value: GLOBAL_FILTER }] : []),
      ...orgs.map((o) => ({ label: o.name, value: o.id })),
    ],
    [orgs, includeGlobal],
  );

  return (
    <div style={{ minWidth }}>
      <ThemedSelect
        value={value ?? "__all__"}
        onChange={(v) => onChange(v === "__all__" ? null : v)}
        options={options}
        searchable
        ariaLabel="Filter by organization"
      />
    </div>
  );
}
