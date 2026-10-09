import { useEffect, useMemo } from "react";
import { Building2, LockKeyhole } from "lucide-react";
import ThemedSelect from "./ThemedSelect";
import { isCustomerOrganization, useOrgsList } from "../../lib/directory";
import { useOrganizationView } from "../../lib/organization-view";

export default function OrganizationViewBar() {
  const { orgs, isLoading, isError } = useOrgsList();
  const { organizationId, canSwitchOrganizations, setOrganizationId } = useOrganizationView();
  const selectedName = orgs.find((org) => org.id === organizationId)?.name;
  const customerOrgs = useMemo(() => orgs.filter(isCustomerOrganization), [orgs]);

  useEffect(() => {
    if (canSwitchOrganizations && !isLoading && !isError && organizationId && !customerOrgs.some((org) => org.id === organizationId)) {
      setOrganizationId(null);
    }
  }, [canSwitchOrganizations, customerOrgs, isError, isLoading, organizationId, setOrganizationId]);

  return (
    <div className="cv-organization-view-bar sticky top-0 z-30 flex min-h-16 items-center gap-3 border-b border-[var(--bf-line)] bg-[color-mix(in_srgb,var(--bf-paper)_94%,transparent)] px-4 backdrop-blur-sm sm:px-6 md:px-8">
      <Building2 size={19} className="shrink-0 text-[var(--bf-primary)]" aria-hidden="true" />
      {!canSwitchOrganizations ? (
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-[var(--bf-ink)]">
          <span className="truncate">{selectedName ?? "Your organization"}</span>
          <LockKeyhole size={13} className="shrink-0 text-[var(--bf-muted)]" aria-label="Locked to your organization" />
        </div>
      ) : null}
      {canSwitchOrganizations ? (
        <div className="w-full max-w-[520px]">
          <ThemedSelect
            className="cv-organization-view-select"
            value={organizationId ?? "__all__"}
            onChange={(value) => setOrganizationId(value === "__all__" ? null : value)}
            options={[
              { label: "All Customers", value: "__all__" },
              ...customerOrgs.map((org) => ({ label: org.name, value: org.id })),
            ]}
            searchable
            disabled={isLoading}
            ariaLabel="Filter all GRC pages by customer"
          />
        </div>
      ) : null}
    </div>
  );
}
