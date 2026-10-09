import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTable } from "bifrost";

import { Search } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import EmptyState from "../../components/shared/EmptyState";
import ScopeBadge from "../../components/shared/ScopeBadge";
import ThemedSelect from "../../components/shared/ThemedSelect";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import {
  TABLE_CONTROLS,
  TABLE_DOMAINS,
  TABLE_FRAMEWORKS,
} from "../../lib/grc-tables";
import { isGlobal } from "../../lib/scope";
import { useOrganizationView } from "../../lib/organization-view";
import type { Control, Domain, Framework } from "../../lib/types";

type ScopeFilter = "all" | "global" | "org";

export default function ControlsBrowsePage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [frameworkId, setFrameworkId] = useState<string>("");
  const [domainId, setDomainId] = useState<string>("");
  const { organizationId } = useOrganizationView();

  const { rows: frameworks, loading: fwLoading } = useTable<Framework>(TABLE_FRAMEWORKS, {
    pageSize: 500,
    order_by: "name",
    order_dir: "asc" });
  const { rows: domains } = useTable<Domain>(TABLE_DOMAINS, {
    pageSize: 1000,
    order_by: "name",
    order_dir: "asc" });
  const { rows: controls, loading: cLoading, error } = useTable<Control>(TABLE_CONTROLS, {
    pageSize: 1000,
    order_by: "control_id",
    order_dir: "asc" });

  const frameworkById = useMemo(() => {
    const m = new Map<string, Framework>();
    (frameworks ?? []).forEach((f) => m.set(f.id, f));
    return m;
  }, [frameworks]);
  const domainById = useMemo(() => {
    const m = new Map<string, Domain>();
    (domains ?? []).forEach((d) => m.set(d.id, d));
    return m;
  }, [domains]);
  const domainsForFramework = useMemo(() => {
    if (!frameworkId) return [];
    return (domains ?? []).filter((d) => d.framework_id === frameworkId);
  }, [domains, frameworkId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (controls ?? []).filter((c) => {
      if (c.is_active === false) return false;
      if (frameworkId && c.framework_id !== frameworkId) return false;
      if (domainId && c.domain_id !== domainId) return false;
      if (scopeFilter === "global" && !isGlobal(c)) return false;
      if (scopeFilter === "org" && isGlobal(c)) return false;
      if (organizationId) {
        // Controls are framework-scoped; inherit org from their framework.
        const fw = frameworkById.get(c.framework_id ?? "");
        const ownOrg = c.organization_id ?? fw?.organization_id ?? null;
        if (ownOrg != null && ownOrg !== organizationId) return false;
      }
      if (!q) return true;
      return (
        (c.control_id ?? "").toLowerCase().includes(q) ||
        (c.title ?? "").toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [controls, search, frameworkId, domainId, scopeFilter, organizationId, frameworkById]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Controls"
        subtitle="Browse the shared standards control library. Customer implementations live under Applied Controls."
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--cv-fg-3)" }}
          />
          <input
            aria-label="Search controls"
            className="cv-field"
            placeholder="Search by ID, title, or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 32 }}
          />
        </div>
        <div style={{ minWidth: 220 }}>
          <ThemedSelect
            value={frameworkId}
            onChange={(v) => {
              setFrameworkId(v);
              setDomainId("");
            }}
            options={[
              { label: "All frameworks", value: "" },
              ...((frameworks ?? []).map((f) => ({
                label: f.name ?? "Untitled",
                value: f.id }))),
            ]}
            disabled={fwLoading}
            ariaLabel="Filter by framework"
            searchable
          />
        </div>
        <div style={{ minWidth: 220 }}>
          <ThemedSelect
            value={domainId}
            onChange={setDomainId}
            options={[
              { label: "All domains", value: "" },
              ...domainsForFramework.map((d) => ({
                label: d.name ?? "Untitled",
                value: d.id })),
            ]}
            disabled={!frameworkId}
            ariaLabel="Filter by domain"
          />
        </div>
        <div style={{ display: "inline-flex", gap: 4 }}>
          {(["all", "global", "org"] as ScopeFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              className={
                "cv-btn cv-btn--sm " +
                (scopeFilter === s ? "cv-btn--primary" : "cv-btn--secondary")
              }
              onClick={() => setScopeFilter(s)}
            >
              {s === "all" ? "All" : s === "global" ? "Global" : "Org"}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="cv-callout cv-callout--danger">
          <div className="cv-callout__label">Error</div>
          <div className="cv-callout__body">
            {String((error as Error)?.message ?? error)}
          </div>
        </div>
      ) : null}

      {cLoading && (controls?.length ?? 0) === 0 ? (
        <LoadingSkeleton rows={6} label="Loading controls" />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No controls match"
          body="Adjust filters or pick a different framework."
        />
      ) : (
        <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="cv-data-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 100 }}>Scope</th>
                <th style={{ width: 110 }}>ID</th>
                <th>Title</th>
                <th style={{ width: 200 }}>Framework</th>
                <th style={{ width: 180 }}>Domain</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const fw = frameworkById.get(c.framework_id ?? "");
                const dom = c.domain_id ? domainById.get(c.domain_id) : null;
                return (
                  <tr
                    key={c.id}
                    className="cv-data-table__row--clickable"
                    onClick={() => navigate(`/frameworks/${c.framework_id}`)}
                  >
                    <td>
                      <ScopeBadge row={c} />
                    </td>
                    <td>
                      <span className="cv-mono" style={{ fontSize: 12 }}>
                        {c.control_id || "—"}
                      </span>
                    </td>
                    <td>
                      <Link className="cv-table-primary-link" to={`/frameworks/${c.framework_id}`}>
                        {c.title || "Untitled"}
                      </Link>
                      {c.description ? (
                        <div
                          style={{
                            color: "var(--cv-fg-3)",
                            fontSize: 12,
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 480 }}
                        >
                          {c.description}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
                      {fw?.name ?? "—"}
                    </td>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
                      {dom?.name ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
