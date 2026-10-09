import { appliesToOrg, scopeOrgIds } from "./scope";
import type { GrcFact } from "./types";

const GLOBAL_SCOPE_SIZE = Number.MAX_SAFE_INTEGER;

export interface EffectiveFactResolution {
  factsByKey: Map<string, GrcFact>;
  conflictsByKey: Map<string, GrcFact[]>;
}

export function factScopeSize(fact: GrcFact, organizationId: string): number | null {
  if (!appliesToOrg(fact, organizationId)) return null;
  if (fact.scope_kind === "all") return GLOBAL_SCOPE_SIZE;
  if (fact.organization_id == null && fact.applied_organizations === null) return GLOBAL_SCOPE_SIZE;
  if ((fact.scope_size ?? 0) > 0) return fact.scope_size!;
  return Math.max(1, scopeOrgIds(fact)?.length ?? 0);
}

/** One > narrowest Some > All. Equal-specificity logical scopes conflict. */
export function resolveEffectiveFacts(facts: GrcFact[], organizationId: string): EffectiveFactResolution {
  const candidates = new Map<string, Array<{ size: number; fact: GrcFact }>>();
  facts.forEach((fact) => {
    const size = factScopeSize(fact, organizationId);
    if (size == null || !fact.fact_key) return;
    const rows = candidates.get(fact.fact_key) ?? [];
    rows.push({ size, fact });
    candidates.set(fact.fact_key, rows);
  });

  const factsByKey = new Map<string, GrcFact>();
  const conflictsByKey = new Map<string, GrcFact[]>();
  candidates.forEach((rows, key) => {
    const bestSize = Math.min(...rows.map((row) => row.size));
    const best = rows.filter((row) => row.size === bestSize).map((row) => row.fact);
    const byScope = new Map<string, GrcFact[]>();
    best.forEach((fact) => {
      const scopeId = fact.scope_id || fact.id || "legacy";
      byScope.set(scopeId, [...(byScope.get(scopeId) ?? []), fact]);
    });
    if (byScope.size > 1) {
      conflictsByKey.set(key, Array.from(byScope.values()).map((scopeRows) => scopeRows[0]));
      return;
    }
    const selected = Array.from(byScope.values())[0]
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0) || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
    factsByKey.set(key, {
      ...selected,
      effective_scope_kind: selected.scope_kind ?? (bestSize === GLOBAL_SCOPE_SIZE ? "all" : "one"),
      effective_scope_size: bestSize === GLOBAL_SCOPE_SIZE ? null : bestSize,
    });
  });
  return { factsByKey, conflictsByKey };
}

export function logicalScopeOrganizations(facts: GrcFact[], fact: GrcFact | undefined, fallbackOrganizationId: string): string[] | null {
  if (!fact) return [fallbackOrganizationId];
  if (fact.scope_kind === "all" || (fact.organization_id == null && fact.applied_organizations === null)) return null;
  const scopeId = fact.scope_id;
  if (!scopeId) return [fact.organization_id || fallbackOrganizationId];
  const organizations = Array.from(new Set(facts.filter((item) => item.scope_id === scopeId).map((item) => item.organization_id).filter(Boolean) as string[]));
  return organizations.length ? organizations.sort() : [fallbackOrganizationId];
}
