import { useMemo } from "react";
import { useUser } from "bifrost";
import { useOrgsList } from "./directory";

export interface CurrentUser {
  id: string | null;
  email: string | null;
  organizationId: string | null;
  roleNames: string[];
  isProviderOrg: boolean;
  isPlatformAdmin: boolean;
  hasOrganizationDirectory: boolean;
}

const GRC_EDITOR_ROLES = new Set(["GRC Contributor", "GRC Administrator"]);

/**
 * UI capability only. Bifrost table, file, and workflow policies remain the
 * authorization boundary; this prevents read-only users from being offered
 * actions that those policies will reject.
 */
export function canEditGrc(user: Pick<CurrentUser, "isPlatformAdmin" | "roleNames">): boolean {
  return user.isPlatformAdmin || user.roleNames.some((role) => GRC_EDITOR_ROLES.has(role));
}

export function useCurrentUser(): CurrentUser {
  const { id, email, organizationId, roles, isPlatformAdmin } = useUser();
  const { orgs, isLoading, isError } = useOrgsList(true);
  return {
    id: id || null,
    email: email || null,
    organizationId: organizationId || null,
    roleNames: roles,
    isProviderOrg: orgs.some((org) => org.id === organizationId && org.is_provider === true),
    isPlatformAdmin,
    hasOrganizationDirectory: !isLoading && !isError,
  };
}

export function useGrcPermissions() {
  const { roles, isPlatformAdmin } = useUser();
  return useMemo(() => ({ canEdit: canEditGrc({ roleNames: roles, isPlatformAdmin }) }), [roles, isPlatformAdmin]);
}
