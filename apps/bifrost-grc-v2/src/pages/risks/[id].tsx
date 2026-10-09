import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";
import { AlertTriangle, Trash2, Plus, Loader2, X, ArrowLeft, Delete } from "lucide-react";
import { useParams } from "react-router-dom";
import PageHeader from "../../components/shared/PageHeader";
import SectionHeader from "../../components/shared/SectionHeader";
import ScopeBadge from "../../components/shared/ScopeBadge";
import RiskBadge from "../../components/shared/RiskBadge";
import EmptyState from "../../components/shared/EmptyState";
import LinkedControlsPicker from "../../components/risks/LinkedControlsPicker";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ThemedSelect from "../../components/shared/ThemedSelect";
import StateSegmented, { type StateOption } from "../../components/shared/StateSegmented";
import UserPicker from "../../components/shared/UserPicker";
import { confirm } from "../../components/shared/ConfirmDialog";
import {
  TABLE_RISKS,
  TABLE_RISK_LINKS,
  TABLE_CONTROLS,
  TABLE_FRAMEWORKS,
  TABLE_APPLIED_CONTROLS,
  TABLE_EXCEPTIONS } from "../../lib/grc-tables";
import { getRow } from "../../lib/table-helpers";
import { scopeOrgIds } from "../../lib/scope";
import { useUserNameLookup } from "../../lib/directory";
import { useGrcPermissions } from "../../lib/current-user";
import type {
  Risk,
  RiskLink,
  RiskLevel,
  RiskStatus,
  AppliedControl,
  Exception as ExceptionRow,
  Control,
  Framework } from "../../lib/types";

const LEVELS: RiskLevel[] = ["very_high", "high", "medium", "low"];
const STATUS_OPTIONS: Array<StateOption<RiskStatus>> = [
  { value: "open", label: "Open", tone: "red" },
  { value: "mitigated", label: "Mitigated", tone: "teal" },
  { value: "accepted", label: "Accepted", tone: "gold" },
  { value: "closed", label: "Closed", tone: "green" },
];

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function RiskDetailPage() {
  const { canEdit } = useGrcPermissions();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [risk, setRisk] = useState<Risk | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const userName = useUserNameLookup();

  const { rows: riskLinkRows, loading: riskLinksLoading } = useTable<RiskLink>(
    TABLE_RISK_LINKS,
    { pageSize: 1000, where: id ? { risk_id: id } : undefined },
  );
  const { rows: controlRows } = useTable<Control>(TABLE_CONTROLS, {
    pageSize: 1000,
    order_by: "control_id",
    order_dir: "asc" });
  const { rows: frameworkRows } = useTable<Framework>(TABLE_FRAMEWORKS, {
    pageSize: 200 });
  const { rows: appliedControlRows } = useTable<AppliedControl>(TABLE_APPLIED_CONTROLS, {
    pageSize: 1000 });
  const { rows: exceptionRows } = useTable<ExceptionRow>(TABLE_EXCEPTIONS, {
    pageSize: 1000 });

  const riskLinks: RiskLink[] = Array.isArray(riskLinkRows) ? riskLinkRows : [];
  const controlLinks = riskLinks.filter((link) => link.target_type === "control");
  const relatedLinks = riskLinks.filter((link) => link.target_type !== "control");
  const controls: Control[] = Array.isArray(controlRows) ? controlRows : [];
  const frameworks: Framework[] = Array.isArray(frameworkRows) ? frameworkRows : [];
  const appliedControls: AppliedControl[] = Array.isArray(appliedControlRows) ? appliedControlRows : [];
  const exceptions: ExceptionRow[] = Array.isArray(exceptionRows) ? exceptionRows : [];

  const controlById = useMemo(() => {
    const m = new Map<string, Control>();
    controls.forEach((c) => m.set(c.id, c));
    return m;
  }, [controls]);

  const frameworkName = (fid?: string | null) =>
    frameworks.find((f) => f.id === fid)?.name ?? "Framework";

  const appliedControlById = useMemo(() => {
    const m = new Map<string, AppliedControl>();
    appliedControls.forEach((c) => m.set(c.id, c));
    return m;
  }, [appliedControls]);

  const exceptionById = useMemo(() => {
    const m = new Map<string, ExceptionRow>();
    exceptions.forEach((e) => m.set(e.id, e));
    return m;
  }, [exceptions]);

  const reloadRisk = async () => {
    if (!id) return;
    try {
      const row = await getRow<Risk>(TABLE_RISKS, id);
      if (!row) {
        setLoadError("Risk not found");
        setRisk(null);
      } else {
        setRisk(row as Risk);
        setLoadError(null);
      }
    } catch (err) {
      setLoadError((err as Error)?.message ?? "Failed to load risk");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    reloadRisk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const patch = async (patchData: Partial<Risk>) => {
    if (!id || !risk) return;
    // Optimistic update
    setRisk({ ...risk, ...patchData });
    try {
      await tables.update(TABLE_RISKS, id, patchData);
    } catch (err) {
      toast.error("Save failed: " + ((err as Error)?.message ?? "unknown"));
      // Reload to recover
      reloadRisk();
    }
  };

  const unlink = async (rcId: string) => {
    try {
      await tables.delete(TABLE_RISK_LINKS, rcId);
    } catch (err) {
      toast.error("Failed to unlink: " + ((err as Error)?.message ?? "unknown"));
    }
  };

  const handleDelete = async () => {
    if (!id || !risk) return;
    const ok = await confirm({
      title: "Delete this risk?",
      body: "Linked control associations will be removed. This can't be undone.",
      confirmLabel: "Delete risk",
      destructive: true });
    if (!ok) return;
    setDeleting(true);
    try {
      const linksToDelete = riskLinks;
      for (const l of linksToDelete) {
        try {
          await tables.delete(TABLE_RISK_LINKS, l.id);
        } catch {
          /* keep going */
        }
      }
      await tables.delete(TABLE_RISKS, id);
      navigate("/risks");
    } catch (err) {
      toast.error("Delete failed: " + ((err as Error)?.message ?? "unknown"));
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80 }}>
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (loadError || !risk) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Link to="/risks" style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "var(--cv-fg-3)", textDecoration: "none", fontSize: 13 }}>
          <ArrowLeft size={14} /> Back to risks
        </Link>
        <EmptyState
          icon={AlertTriangle}
          title={loadError ?? "Risk not found"}
          body="This risk may have been deleted or you may not have access."
        />
      </div>
    );
  }

  const linkedControlIds = controlLinks.map((link) => link.target_id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Link to="/risks" style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "var(--cv-fg-3)", textDecoration: "none", fontSize: 13, width: "fit-content" }}>
        <ArrowLeft size={14} /> Risk register
      </Link>

      <PageHeader
        title={risk.name ?? "Untitled risk"}
        crumb="RISK"
        subtitle={undefined}
        actions={
          <>
            <RiskBadge level={risk.risk_level} />
            <ScopeBadge row={risk} />
            {canEdit ? <button
              className="cv-btn cv-btn--destructive cv-btn--sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
            </button> : null}
          </>
        }
      />

      <fieldset disabled={!canEdit} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
      <div className="cv-record-layout">
        {/* Main column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          {/* Name + description card */}
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="risk-name">Name</label>
              <input
                id="risk-name"
                className="cv-field"
                defaultValue={risk.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== risk.name) patch({ name: v });
                }}
                disabled={!canEdit}
              />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="risk-description">Description</label>
              <textarea
                id="risk-description"
                className="cv-field"
                defaultValue={risk.description ?? ""}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== (risk.description ?? "")) patch({ description: v || null });
                }}
                rows={4}
                disabled={!canEdit}
              />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="risk-mitigation">Mitigation plan</label>
              <textarea
                id="risk-mitigation"
                className="cv-field"
                defaultValue={risk.mitigation_plan ?? ""}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== (risk.mitigation_plan ?? "")) patch({ mitigation_plan: v || null });
                }}
                rows={3}
                placeholder="How is this being addressed?"
                disabled={!canEdit}
              />
            </div>
          </div>

          {/* Scoring card */}
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <SectionHeader label="Risk scoring" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <ScoreField
                label="Likelihood"
                value={risk.likelihood ?? ""}
                onChange={(v) => patch({ likelihood: (v || null) as RiskLevel | null })}
                disabled={!canEdit}
              />
              <ScoreField
                label="Impact"
                value={risk.impact ?? ""}
                onChange={(v) => patch({ impact: (v || null) as RiskLevel | null })}
                disabled={!canEdit}
              />
              <ScoreField
                label="Risk level"
                value={risk.risk_level ?? ""}
                onChange={(v) => patch({ risk_level: (v || null) as RiskLevel | null })}
                disabled={!canEdit}
              />
            </div>
          </div>

          {/* Linked controls */}
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionHeader
              label={`Linked controls (${controlLinks.length})`}
              action={canEdit ? (
                <button
                  className="cv-btn cv-btn--secondary cv-btn--sm"
                  onClick={() => setPickerOpen(true)}
                >
                  <Plus size={13} /> Link control
                </button>
              ) : undefined}
            />
            {riskLinksLoading ? (
              <div style={{ padding: 14, color: "var(--cv-fg-3)", fontSize: 13 }}>Loading…</div>
            ) : controlLinks.length === 0 ? (
              <div style={{ padding: 18, color: "var(--cv-fg-3)", fontSize: 13, textAlign: "center" }}>
                No mitigating controls linked yet.
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {controlLinks.map((l) => {
                  const c = controlById.get(l.target_id);
                  return (
                    <li
                      key={l.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "10px 0",
                        borderBottom: "1px solid var(--cv-border)" }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {c ? (
                          <>
                            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                              <code style={{ fontFamily: "var(--cv-font-mono)", fontSize: 12, color: "var(--cv-fg-2)" }}>
                                {c.control_id}
                              </code>
                              <span style={{ fontWeight: 500, color: "var(--cv-fg-1)", fontSize: 13 }}>{c.title}</span>
                              <span className="cv-chip cv-chip--neutral" style={{ fontSize: 10 }}>
                                {frameworkName(c.framework_id)}
                              </span>
                            </div>
                            {c.description ? (
                              <div style={{ fontSize: 12, color: "var(--cv-fg-3)", marginTop: 2 }}>
                                {c.description.slice(0, 140)}
                                {c.description.length > 140 ? "…" : ""}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span style={{ color: "var(--cv-fg-3)", fontSize: 13 }}>Control {l.target_id}</span>
                        )}
                      </div>
                      {canEdit ? <button
                        className="cv-btn cv-btn--ghost cv-btn--sm"
                        onClick={() => unlink(l.id)}
                        title="Unlink"
                      >
                        <X size={14} />
                      </button> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Related records */}
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionHeader label={`Related records (${relatedLinks.length})`} />
            {riskLinksLoading ? (
              <div style={{ padding: 14, color: "var(--cv-fg-3)", fontSize: 13 }}>Loading…</div>
            ) : relatedLinks.length === 0 ? (
              <div style={{ padding: 18, color: "var(--cv-fg-3)", fontSize: 13, textAlign: "center" }}>
                No applied-control, exception, evidence, or policy links yet.
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {relatedLinks.map((l) => {
                  const target = riskLinkTargetLabel(l, appliedControlById, exceptionById, controlById);
                  return (
                    <li
                      key={l.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "10px 0",
                        borderBottom: "1px solid var(--cv-border)" }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="cv-chip cv-chip--neutral" style={{ fontSize: 10 }}>
                            {fmt(l.target_type)}
                          </span>
                          {target.href ? (
                            <Link to={target.href} className="cv-link" style={{ fontSize: 13, fontWeight: 500 }}>
                              {target.label}
                            </Link>
                          ) : (
                            <span style={{ color: "var(--cv-fg-1)", fontSize: 13, fontWeight: 500 }}>{target.label}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--cv-fg-3)", marginTop: 3 }}>
                          {fmt(l.relationship || "related_to")}
                          {l.source_system ? ` · ${l.source_system}` : ""}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Side rail */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeader label="Scope" />
            <OrgScopeField
              id="risk-organization-scope"
              value={scopeOrgIds(risk)}
              onChange={(organizationScope) => patch({
                applied_organizations: organizationScope,
                excluded_organizations: [],
              })}
              disabled={!canEdit}
            />
          </div>

          <div className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionHeader label="Status" />
            <StateSegmented
              value={risk.status ?? "open"}
              onChange={(status) => patch({ status })}
              options={STATUS_OPTIONS}
              ariaLabel="Risk state"
              disabled={!canEdit}
            />
          </div>

          <div className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionHeader label="Ownership" />
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="risk-category">Category</label>
              <input
                id="risk-category"
                className="cv-field"
                defaultValue={risk.category ?? ""}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (risk.category ?? "")) patch({ category: v || null });
                }}
                placeholder="e.g. Security"
                disabled={!canEdit}
              />
            </div>
            <UserPicker
              id="risk-owner"
              label="Owner"
              value={risk.owner ?? null}
              orgId={scopeOrgIds(risk)?.[0] ?? null}
              onChange={(owner) => patch({ owner })}
              disabled={!canEdit}
            />
          </div>

          <div className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--cv-fg-3)" }}>
            <SectionHeader label="Audit" />
            <Row label="Created" value={fmtDate(risk.created_at)} />
            <Row label="Updated" value={fmtDate(risk.updated_at)} />
            {risk.created_by ? <Row label="By" value={userName(risk.created_by)} /> : null}
          </div>
        </div>
      </div>
      </fieldset>

      {canEdit ? <LinkedControlsPicker
        open={pickerOpen}
        riskId={id ?? ""}
        organizationId={risk.organization_id ?? null}
        appliedOrganizations={risk.applied_organizations ?? null}
        excludedOrganizations={risk.excluded_organizations ?? []}
        alreadyLinkedControlIds={linkedControlIds}
        onOpenChange={setPickerOpen}
        onLinked={() => {
          /* useTable subscribes live, no manual refetch needed */
        }}
      /> : null}
    </div>
  );
}

function ScoreField({
  label,
  value,
  onChange,
  disabled }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="cv-field-group">
      <label className="cv-field-label">{label}</label>
      <ThemedSelect
        ariaLabel={label}
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={[
          { label: "—", value: "" },
          ...LEVELS.map((l) => ({ label: fmt(l), value: l })),
        ]}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span>{label}</span>
      <span style={{ color: "var(--cv-fg-2)", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function riskLinkTargetLabel(
  link: RiskLink,
  appliedControlById: Map<string, AppliedControl>,
  exceptionById: Map<string, ExceptionRow>,
  controlById: Map<string, Control>,
): { label: string; href?: string } {
  if (link.target_type === "applied_control") {
    const row = appliedControlById.get(link.target_id);
    return {
      label: row?.name ?? `Applied control ${link.target_id}`,
      href: row ? `/applied-controls/${row.id}` : undefined,
    };
  }
  if (link.target_type === "exception") {
    const row = exceptionById.get(link.target_id);
    return {
      label: row?.reason ?? `Exception ${link.target_id}`,
      href: row ? `/exceptions/${row.id}` : undefined,
    };
  }
  if (link.target_type === "control") {
    const row = controlById.get(link.target_id);
    return {
      label: row ? `${row.control_id} ${row.title}` : `Control ${link.target_id}`,
      href: row ? `/frameworks/${row.framework_id}` : undefined,
    };
  }
  return { label: `${fmt(link.target_type)} ${link.target_id}` };
}
