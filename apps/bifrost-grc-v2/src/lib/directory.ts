import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { useWorkflowQuery } from "bifrost";
import { useAnonymize } from "./anonymize-store";
import { PLATFORM_ORG_ID } from "./grc-tables";

const LIST_ORGANIZATIONS = "workflows/grc_v2/grc_directory.py::list_organizations";
const LIST_USERS = "workflows/grc_v2/grc_directory.py::grc_v2_list_users";

export interface OrgEntry {
  id: string;
  name: string;
  domain: string | null;
  is_provider?: boolean;
  is_active?: boolean;
}

export interface UserEntry {
  id: string;
  name: string | null;
  email: string | null;
  organization_id: string | null;
  roles: string[];
  is_active?: boolean;
}

export function isCustomerOrganization(organization: OrgEntry): boolean {
  return organization.id !== PLATFORM_ORG_ID && !organization.is_provider;
}

interface OrganizationsResult {
  organizations: OrgEntry[];
}

interface UsersResult {
  users: UserEntry[];
}

interface DirectoryContextValue {
  organizations: OrgEntry[];
  organizationsLoading: boolean;
  organizationsError: boolean;
  users: UserEntry[];
  usersLoading: boolean;
  usersError: boolean;
}

const DirectoryContext = createContext<DirectoryContextValue | null>(null);

/**
 * Fetch the visible platform directory once per app load. Without this cache,
 * every picker, badge, and lookup mounted its own identical workflow query.
 */
export function DirectoryProvider({ children }: { children: ReactNode }) {
  const orgParams = useMemo(() => ({ include_inactive: true }), []);
  const userParams = useMemo(() => ({ organization_id: null, include_inactive: true }), []);
  const orgQuery = useWorkflowQuery<OrganizationsResult>(LIST_ORGANIZATIONS, orgParams);
  const userQuery = useWorkflowQuery<UsersResult>(LIST_USERS, userParams);
  const value = useMemo<DirectoryContextValue>(() => ({
    organizations: orgQuery.data?.organizations ?? [],
    organizationsLoading: orgQuery.loading,
    organizationsError: Boolean(orgQuery.error),
    users: userQuery.data?.users ?? [],
    usersLoading: userQuery.loading,
    usersError: Boolean(userQuery.error),
  }), [orgQuery.data?.organizations, orgQuery.error, orgQuery.loading, userQuery.data?.users, userQuery.error, userQuery.loading]);

  return createElement(DirectoryContext.Provider, { value }, children);
}

function useDirectory(): DirectoryContextValue {
  const directory = useContext(DirectoryContext);
  if (!directory) throw new Error("Directory hooks must be used inside DirectoryProvider");
  return directory;
}

export function useOrgsList(includeInactive = false): {
  orgs: OrgEntry[];
  isLoading: boolean;
  isError: boolean;
} {
  const directory = useDirectory();
  const { enabled, anon } = useAnonymize();

  const orgs = useMemo(
    () =>
      directory.organizations
        .filter((org) => includeInactive || org.is_active !== false)
        .map((org) => ({
          ...org,
          name: anon.value(org.name, "org_name"),
          domain: org.domain ? anon.domain(org.domain) : null,
        })),
    [anon, directory.organizations, enabled, includeInactive],
  );

  return { orgs, isLoading: directory.organizationsLoading, isError: directory.organizationsError };
}

export function useUsersList(
  orgId?: string | null,
  includeInactive = false,
): {
  users: UserEntry[];
  isLoading: boolean;
  isError: boolean;
} {
  const directory = useDirectory();
  const { enabled, anon } = useAnonymize();

  const users = useMemo(
    () =>
      directory.users
        .filter((user) => !orgId || user.organization_id === orgId)
        .filter((user) => includeInactive || user.is_active !== false)
        .map((user) => ({
          ...user,
          name: user.name ? anon.value(user.name, "user_name") : null,
          email: user.email ? anon.email(user.email) : null,
        })),
    [anon, directory.users, enabled, includeInactive, orgId],
  );

  return { users, isLoading: directory.usersLoading, isError: directory.usersError };
}

export function useOrgsMap(): {
  byId: Map<string, OrgEntry>;
  isLoading: boolean;
  isError: boolean;
} {
  const { orgs, isLoading, isError } = useOrgsList(true);
  const byId = useMemo(() => new Map(orgs.map((org) => [org.id, org])), [orgs]);
  return { byId, isLoading, isError };
}

export function orgLabel(byId: Map<string, OrgEntry>, orgId: string | null | undefined): string {
  if (!orgId) return "Global";
  return byId.get(orgId)?.name ?? "Unknown org";
}

export function useOrgNamesMap(): Map<string, string> {
  const { byId } = useOrgsMap();
  return useMemo(() => {
    const names = new Map<string, string>();
    byId.forEach((org, id) => names.set(id, org.name));
    return names;
  }, [byId]);
}

export function useUserNameLookup(): (userId: string | null | undefined) => string {
  const { users } = useUsersList(undefined, true);
  const byId = useMemo(
    () => new Map(users.map((user) => [user.id, user.name || user.email || user.id])),
    [users],
  );
  return useMemo(
    () => (userId: string | null | undefined) => {
      if (!userId) return "—";
      return byId.get(userId) ?? userId;
    },
    [byId],
  );
}
