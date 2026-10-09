import { scopeLabel, scopeOrgIds, type ScopedRow } from "../../lib/scope";
import { useOrgNamesMap } from "../../lib/directory";
import { Building2, CircleSlash2, Globe2, Users } from "lucide-react";

interface ScopeBadgeProps {
  row?: ScopedRow | null;
  // explicit override for cases where caller already knows
  global?: boolean;
}

export default function ScopeBadge({ row, global: explicitGlobal }: ScopeBadgeProps) {
  const orgNameById = useOrgNamesMap();
  const orgIds = explicitGlobal == null ? scopeOrgIds(row) : explicitGlobal ? null : [];
  const label = explicitGlobal != null ? (explicitGlobal ? "All organizations" : "Organization") : scopeLabel(row, orgNameById);
  const Icon = explicitGlobal === false
    ? Building2
    : orgIds === null
      ? Globe2
      : orgIds.length === 0
        ? CircleSlash2
        : orgIds.length === 1
          ? Building2
          : Users;

  return (
    <span className="inline-flex max-w-48 min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={label} aria-label={`Scope: ${label}`}>
      <Icon className="shrink-0" size={14} aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
