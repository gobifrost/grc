import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";

import { AlertTriangle, Plus, Search, Loader2, X } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";
import EmptyState from "../../components/shared/EmptyState";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import BifrostDialogFrame from "../../components/shared/BifrostDialogFrame";
import ScopeBadge from "../../components/shared/ScopeBadge";
import RiskBadge from "../../components/shared/RiskBadge";
import RiskStatusChip from "../../components/risks/RiskStatusChip";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ThemedSelect from "../../components/shared/ThemedSelect";
import UserPicker from "../../components/shared/UserPicker";
import StateSegmented, { type StateOption } from "../../components/shared/StateSegmented";
import {
  TABLE_RISKS,
  TABLE_RISK_LINKS } from "../../lib/grc-tables";
import { useUserNameLookup } from "../../lib/directory";
import { appliesToOrg, rowOrganizationIdForScope, scopeOrgIds } from "../../lib/scope";
import { useOrganizationView } from "../../lib/organization-view";
import type { Risk, RiskLink, RiskLevel, RiskStatus } from "../../lib/types";

const LEVEL_FILTERS: Array<{ value: "all" | RiskLevel; label: string }> = [
  { value: "all", label: "All" },
  { value: "very_high", label: "Very high" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];
const RISK_STATE_OPTIONS: Array<StateOption<RiskStatus>> = [
  { value: "open", label: "Open", tone: "red" },
  { value: "mitigated", label: "Mitigated", tone: "teal" },
  { value: "accepted", label: "Accepted", tone: "gold" },
  { value: "closed", label: "Closed", tone: "green" },
];

export default function RisksPage() {
  const { canEdit } = useGrcPermissions();
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<"all" | RiskLevel>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<"all" | "global" | "org">("all");
  const { organizationId } = useOrganizationView();
  const [createOpen, setCreateOpen] = useState(false);

  const userName = useUserNameLookup();

  const { rows: riskRows, loading, error } = useTable<Risk>(TABLE_RISKS, {
    pageSize: 500,
    order_by: "updated_at",
    order_dir: "desc" });
  const { rows: riskLinkRows } = useTable<RiskLink>(TABLE_RISK_LINKS, {
    pageSize: 1000 });

  const risks: Risk[] = Array.isArray(riskRows) ? riskRows : [];
  const riskLinks: RiskLink[] = Array.isArray(riskLinkRows) ? riskLinkRows : [];

  const linksByRisk = useMemo(() => {
    const m = new Map<string, number>();
    riskLinks.forEach((l) => m.set(l.risk_id, (m.get(l.risk_id) ?? 0) + 1));
    return m;
  }, [riskLinks]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    risks.forEach((r) => {
      if (r.category) set.add(r.category);
    });
    return Array.from(set).sort();
  }, [risks]);

  const filtered = useMemo(() => {
    let list = risks;
    if (levelFilter !== "all") list = list.filter((r) => r.risk_level === levelFilter);
    if (categoryFilter !== "all") list = list.filter((r) => r.category === categoryFilter);
    if (scopeFilter === "global") list = list.filter((r) => scopeOrgIds(r) === null);
    if (scopeFilter === "org") list = list.filter((r) => scopeOrgIds(r) !== null);
    if (organizationId) list = list.filter((r) => appliesToOrg(r, organizationId));
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.name?.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q) ||
          r.category?.toLowerCase().includes(q) ||
          r.owner?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [risks, levelFilter, categoryFilter, scopeFilter, organizationId, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, minHeight: 0, flex: 1 }}>
      <PageHeader
        title="Risk Register"
        subtitle="Identify, score, and mitigate organizational risks."
        actions={canEdit ? (
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New risk
          </button>
        ) : undefined}
      />

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 380 }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--cv-fg-3)",
              pointerEvents: "none" }}
          />
          <input
            aria-label="Search risks"
            className="cv-field"
            style={{ paddingLeft: 30 }}
            placeholder="Search risks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {LEVEL_FILTERS.map((f) => (
            <button
              key={f.value}
              className={
                "cv-chip " +
                (levelFilter === f.value ? "cv-chip--teal" : "cv-chip--neutral")
              }
              onClick={() => setLevelFilter(f.value)}
              style={{ cursor: "pointer", border: "none" }}
            >
              {f.label}
            </button>
          ))}
        </div>
        {categories.length > 0 ? (
          <div style={{ minWidth: 180 }}>
            <ThemedSelect
              value={categoryFilter}
              onChange={setCategoryFilter}
              options={[
                { label: "All categories", value: "all" },
                ...categories.map((c) => ({ label: c, value: c })),
              ]}
              ariaLabel="Filter by category"
            />
          </div>
        ) : null}
        <div style={{ minWidth: 140 }}>
          <ThemedSelect
            value={scopeFilter}
            onChange={(v) => setScopeFilter(v as "all" | "global" | "org")}
            options={[
              { label: "All scopes", value: "all" },
              { label: "Org", value: "org" },
              { label: "Global", value: "global" },
            ]}
            ariaLabel="Filter by scope"
          />
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <LoadingSkeleton rows={6} label="Loading risks" />
      ) : error ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load risks"
          body={String(error)}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title={risks.length === 0 ? "No risks yet" : "No matching risks"}
          body={
            risks.length === 0
              ? "Start your register by adding the first risk."
              : "Adjust the filters or search to widen the results."
          }
          cta={
            canEdit && risks.length === 0 ? (
              <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
                <Plus size={14} /> New risk
              </button>
            ) : null
          }
        />
      ) : (
        <div
          className="cv-card"
          style={{ padding: 0, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
        >
          <div style={{ overflow: "auto", flex: 1 }}>
            <table className="cv-data-table">
              <thead>
                <tr style={{ position: "sticky", top: 0, zIndex: 1 }}>
                  <Th>Scope</Th>
                  <Th>Risk</Th>
                  <Th>Score</Th>
                  <Th>State</Th>
                  <Th>Coverage</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.id}
                    style={{
                      borderTop: "1px solid var(--cv-border)" }}
                  >
                    <Td>
                      <ScopeBadge row={r} />
                    </Td>
                    <Td>
                      <Link
                        to={`/risks/${r.id}`}
                        style={{
                          color: "var(--cv-fg-1)",
                          textDecoration: "none",
                          fontWeight: 500,
                          display: "block" }}
                      >
                        {r.name}
                        <div className="cv-data-table__secondary">
                          {[r.category, r.owner ? userName(r.owner) : null, r.description]
                            .filter(Boolean)
                            .join(" · ") || "No description"}
                        </div>
                      </Link>
                    </Td>
                    <Td>
                      <div className="cv-table-stack">
                        <RiskBadge level={r.risk_level} />
                        <span className="cv-small">
                          Likelihood {fmtLevel(r.likelihood ?? "unknown")} · Impact {fmtLevel(r.impact ?? "unknown")}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <div className="cv-table-stack">
                        <RiskStatusChip status={r.status} />
                        <span className="cv-small">{r.owner ? userName(r.owner) : "Unassigned"}</span>
                      </div>
                    </Td>
                    <Td>
                      <span className="cv-table-coverage">
                        <span><strong>{linksByRisk.get(r.id) ?? 0}</strong> linked records</span>
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canEdit ? <RiskCreateDialog open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}

const RISK_LEVELS: RiskLevel[] = ["very_high", "high", "medium", "low"];
const LEVEL_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, very_high: 4 };
const RANK_LEVEL: Record<number, RiskLevel> = { 1: "low", 2: "medium", 3: "high", 4: "very_high" };

function fmtLevel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveLevel(likelihood: RiskLevel | "", impact: RiskLevel | ""): RiskLevel | "" {
  if (!likelihood && !impact) return "";
  if (!likelihood) return impact as RiskLevel;
  if (!impact) return likelihood as RiskLevel;
  const rank = Math.max(LEVEL_RANK[likelihood as RiskLevel], LEVEL_RANK[impact as RiskLevel]);
  return RANK_LEVEL[rank];
}

interface RiskCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RiskCreateDialog({ open, onOpenChange }: RiskCreateDialogProps) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const userOrgId = user?.organizationId && user.organizationId.length > 0 ? user.organizationId : null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [likelihood, setLikelihood] = useState<RiskLevel | "">("");
  const [impact, setImpact] = useState<RiskLevel | "">("");
  const [riskLevelOverride, setRiskLevelOverride] = useState<RiskLevel | "">("");
  const [status, setStatus] = useState<RiskStatus>("open");
  const [owner, setOwner] = useState("");
  const [organizationScope, setOrganizationScope] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const derived = deriveLevel(likelihood, impact);
  const finalLevel = riskLevelOverride || derived;

  const reset = () => {
    setName("");
    setDescription("");
    setCategory("");
    setLikelihood("");
    setImpact("");
    setRiskLevelOverride("");
    setStatus("open");
    setOwner("");
    setOrganizationScope(null);
    setBusy(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onOpenChange(false);
  };

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (organizationScope?.length === 0) {
      toast.error("Choose at least one organization or select All");
      return;
    }
    setBusy(true);
    try {
      const row = await tables.insert(TABLE_RISKS, {
        organization_id: rowOrganizationIdForScope(organizationScope, userOrgId),
        applied_organizations: organizationScope,
        excluded_organizations: [],
        name: name.trim(),
        description: description.trim() || null,
        category: category.trim() || null,
        likelihood: likelihood || null,
        impact: impact || null,
        risk_level: finalLevel || null,
        status,
        owner: owner.trim() || null });
      onOpenChange(false);
      reset();
      const id = (row as { id?: string })?.id;
      if (id) navigate(`/risks/${id}`);
    } catch (err) {
      toast.error("Failed to create risk: " + ((err as Error)?.message ?? "unknown"));
      setBusy(false);
    }
  };

  const levelOptions = [
    { label: "—", value: "" },
    ...RISK_LEVELS.map((l) => ({ label: fmtLevel(l), value: l })),
  ];

  return (
    <BifrostDialogFrame
      onDismiss={close}
      dismissDisabled={busy}
      labelledBy="new-risk-title"
      style={{ width: "min(560px, calc(100vw - 32px))" }}
    >
        <div className="cv-dialog__header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 id="new-risk-title" className="cv-dialog__title">New risk</h2>
            <p id="new-risk-description" className="cv-small" style={{ margin: "4px 0 0" }}>
              Capture a customer risk, score it, and assign accountability.
            </p>
          </div>
          <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={close} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <OrgScopeField
            id="new-risk-organization-scope"
            value={organizationScope}
            onChange={setOrganizationScope}
            disabled={busy}
          />
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-risk-name">Name</label>
            <input
              id="new-risk-name"
              className="cv-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Unauthorized data exfiltration"
            />
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-risk-description-field">Description</label>
            <textarea
              id="new-risk-description-field"
              className="cv-field"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What is the risk and how could it materialize?"
            />
          </div>
          <div className="cv-form-grid">
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-risk-category">Category</label>
              <input
                id="new-risk-category"
                className="cv-field"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Security"
              />
            </div>
            <UserPicker
              id="new-risk-owner"
              label="Owner"
              value={owner || null}
              orgId={userOrgId}
              onChange={(value) => setOwner(value ?? "")}
            />
          </div>
          <div className="cv-form-grid">
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-risk-likelihood">Likelihood</label>
              <ThemedSelect
                id="new-risk-likelihood"
                value={likelihood}
                onChange={(v) => setLikelihood(v as RiskLevel | "")}
                options={levelOptions}
                ariaLabel="Risk likelihood"
              />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-risk-impact">Impact</label>
              <ThemedSelect
                id="new-risk-impact"
                value={impact}
                onChange={(v) => setImpact(v as RiskLevel | "")}
                options={levelOptions}
                ariaLabel="Risk impact"
              />
            </div>
          </div>
          <div className="cv-form-grid">
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-risk-level">
                Risk level <span style={{ color: "var(--cv-fg-3)", fontWeight: 400 }}>(override)</span>
              </label>
              <ThemedSelect
                id="new-risk-level"
                value={riskLevelOverride}
                onChange={(v) => setRiskLevelOverride(v as RiskLevel | "")}
                options={[
                  { label: derived ? `Auto · ${fmtLevel(derived)}` : "Auto", value: "" },
                  ...RISK_LEVELS.map((l) => ({ label: fmtLevel(l), value: l })),
                ]}
                ariaLabel="Risk level override"
              />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-risk-status">Status</label>
              <StateSegmented
                value={status}
                onChange={setStatus}
                options={RISK_STATE_OPTIONS}
                ariaLabel="Risk status"
                compact
              />
            </div>
          </div>
        </div>
        <div className="cv-dialog__footer">
          <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create risk"}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "10px 14px",
        fontSize: 11,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: "var(--cv-fg-3)",
        fontWeight: 600,
        borderBottom: "1px solid var(--cv-border)" }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>{children}</td>;
}
