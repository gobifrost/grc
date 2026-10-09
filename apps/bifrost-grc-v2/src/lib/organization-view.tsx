import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useAppState } from "./app-state";
import { useCurrentUser } from "./current-user";
import { appliesToOrg, type ScopedRow } from "./scope";

const STORAGE_KEY = "grc-org-filter";

interface OrganizationViewContextValue {
  organizationId: string | null;
  canSwitchOrganizations: boolean;
  setOrganizationId: (organizationId: string | null) => void;
}

const OrganizationViewContext = createContext<OrganizationViewContextValue | null>(null);

/**
 * One organization lens for the whole GRC application.
 *
 * Provider users may switch between the portfolio and a customer. Tenant users
 * are always bound to their own organization; local browser state can never
 * broaden their view. Authorization still belongs to table/workflow policies.
 */
export function OrganizationViewProvider({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const canSwitchOrganizations = user.isProviderOrg || user.isPlatformAdmin;
  const [storedOrganizationId, setStoredOrganizationId] = useAppState<string | null>(STORAGE_KEY, null);

  const organizationId = canSwitchOrganizations
    ? storedOrganizationId === "__global__" ? null : storedOrganizationId
    : user.organizationId;

  useEffect(() => {
    if (canSwitchOrganizations) {
      if (storedOrganizationId === "__global__") setStoredOrganizationId(null);
      return;
    }
    if (user.organizationId && storedOrganizationId !== user.organizationId) {
      setStoredOrganizationId(user.organizationId);
    }
  }, [canSwitchOrganizations, setStoredOrganizationId, storedOrganizationId, user.organizationId]);

  const value = useMemo<OrganizationViewContextValue>(() => ({
    organizationId,
    canSwitchOrganizations,
    setOrganizationId: (next) => {
      if (canSwitchOrganizations) setStoredOrganizationId(next);
    },
  }), [canSwitchOrganizations, organizationId, setStoredOrganizationId]);

  return (
    <OrganizationViewContext.Provider value={value}>
      {children}
    </OrganizationViewContext.Provider>
  );
}

export function useOrganizationView(): OrganizationViewContextValue {
  const context = useContext(OrganizationViewContext);
  if (!context) throw new Error("useOrganizationView must be used inside OrganizationViewProvider");
  return context;
}

export function rowMatchesOrganizationView(row: ScopedRow, organizationId: string | null): boolean {
  return organizationId ? appliesToOrg(row, organizationId) : true;
}

export function tenantRowMatchesOrganizationView(
  row: { organization_id?: string | null },
  organizationId: string | null,
): boolean {
  return organizationId ? row.organization_id === organizationId : true;
}
