import { useMemo } from "react";
import { useBifrostContext } from "bifrost";

export interface CurrentUser {
  id: string | null;
  email: string | null;
  organizationId: string | null;
  roleNames: string[];
  isProviderOrg: boolean;
  isPlatformAdmin: boolean;
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

function decodePayload(token: string): Record<string, unknown> {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return {};
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
  } catch {
    return {};
  }
}

/**
 * Identity helper for display/default values only. Authorization remains in
 * app/workflow/table/file policies; decoded JWT claims are never trusted for it.
 */
export function useCurrentUser(): CurrentUser {
  const { token, orgScope } = useBifrostContext();
  return useMemo(() => {
    const payload = decodePayload(token);
    const roles = payload.role_names ?? payload.roles;
    return {
      id: String(payload.user_id ?? payload.sub ?? "") || null,
      email: String(payload.email ?? "") || null,
      organizationId: String(payload.organization_id ?? payload.org_id ?? orgScope ?? "") || null,
      roleNames: Array.isArray(roles) ? roles.map(String) : [],
      isProviderOrg: Boolean(payload.is_provider_org),
      isPlatformAdmin: Boolean(payload.is_platform_admin || payload.is_superuser),
    };
  }, [orgScope, token]);
}

export function useGrcPermissions() {
  const user = useCurrentUser();
  return useMemo(() => ({ canEdit: canEditGrc(user) }), [user]);
}
