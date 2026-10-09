import { useGovernedTables } from "../../lib/governed-tables";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTable } from "bifrost";
import { AlertOctagon, Trash2, Loader2, ArrowLeft } from "lucide-react";
import { useParams } from "react-router-dom";
import PageHeader from "../../components/shared/PageHeader";
import SectionHeader from "../../components/shared/SectionHeader";
import EmptyState from "../../components/shared/EmptyState";
import ExpiryChip from "../../components/risks/ExpiryChip";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ScopeBadge from "../../components/shared/ScopeBadge";
import ThemedSelect from "../../components/shared/ThemedSelect";
import StateSegmented, { type StateOption } from "../../components/shared/StateSegmented";
import MultiSelectDropdown from "../../components/shared/MultiSelectDropdown";
import { confirm } from "../../components/shared/ConfirmDialog";
import {
  TABLE_EXCEPTIONS,
  TABLE_EXCEPTION_LINKS,
  TABLE_APPLIED_CONTROLS,
  TABLE_ASSESSMENT_CONTROLS,
  TABLE_ASSESSMENTS,
  TABLE_CONTROLS,
  TABLE_RISKS } from "../../lib/grc-tables";
import { getRow } from "../../lib/table-helpers";
import { appliesToOrg, scopeOrgIds } from "../../lib/scope";
import { useUserNameLookup } from "../../lib/directory";
import { useGrcPermissions } from "../../lib/current-user";
import type {
  AppliedControl,
  Assessment,
  AssessmentControl,
  Exception as ExceptionRow,
  ExceptionLink,
  Control,
  Risk,
  ExceptionStatus } from "../../lib/types";

const STATUS_OPTIONS: Array<StateOption<ExceptionStatus>> = [
  { value: "pending", label: "Pending", tone: "gold" },
  { value: "approved", label: "Approved", tone: "green" },
  { value: "denied", label: "Denied", tone: "red" },
  { value: "expired", label: "Expired", tone: "purple" },
];

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDateTime(iso?: string | null): string {
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

function toDateInput(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export default function ExceptionDetailPage() {
  const tables = useGovernedTables();
  const { canEdit } = useGrcPermissions();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [exc, setExc] = useState<ExceptionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [targetType, setTargetType] = useState("applied_control");
  const [linking, setLinking] = useState<string | null>(null);
  const userName = useUserNameLookup();

  const { rows: controlRows } = useTable<Control>(TABLE_CONTROLS, { pageSize: 1000 });
  const { rows: exceptionLinkRows } = useTable<ExceptionLink>(
    TABLE_EXCEPTION_LINKS,
    id ? { where: { exception_id: id }, pageSize: 500 } : { pageSize: 1 },
  );
  const { rows: appliedControlRows } = useTable<AppliedControl>(TABLE_APPLIED_CONTROLS, { pageSize: 1000 });
  const { rows: assessmentControlRows } = useTable<AssessmentControl>(TABLE_ASSESSMENT_CONTROLS, { pageSize: 1000 });
  const { rows: assessmentRows } = useTable<Assessment>(TABLE_ASSESSMENTS, { pageSize: 1000 });
  const { rows: riskRows } = useTable<Risk>(TABLE_RISKS, { pageSize: 1000 });

  const controls: Control[] = Array.isArray(controlRows) ? controlRows : [];
  const exceptionLinks: ExceptionLink[] = Array.isArray(exceptionLinkRows) ? exceptionLinkRows : [];
  const appliedControls: AppliedControl[] = Array.isArray(appliedControlRows) ? appliedControlRows : [];
  const assessmentControls: AssessmentControl[] = Array.isArray(assessmentControlRows) ? assessmentControlRows : [];
  const assessments: Assessment[] = Array.isArray(assessmentRows) ? assessmentRows : [];
  const risks: Risk[] = Array.isArray(riskRows) ? riskRows : [];

  const control = useMemo(
    () => (exc?.control_id ? controls.find((c) => c.id === exc.control_id) ?? null : null),
    [controls, exc],
  );
  const controlById = useMemo(() => {
    const m = new Map<string, Control>();
    controls.forEach((row) => m.set(row.id, row));
    return m;
  }, [controls]);
  const targetOptions = useMemo(() => {
    const exceptionScope = exc ? scopeOrgIds(exc) : null;
    const inScope = (row: AppliedControl | Risk) =>
      exceptionScope === null || exceptionScope.some((organizationId) => appliesToOrg(row, organizationId));
    if (targetType === "applied_control") {
      return appliedControls
        .filter(inScope)
        .map((row) => ({ value: row.id, label: row.name, hint: fmt(row.status ?? "unknown") }));
    }
    if (targetType === "control") {
      return controls
        .map((row) => ({ value: row.id, label: `${row.control_id} - ${row.title}` }));
    }
    if (targetType === "assessment_control") {
      return assessmentControls
        .map((row) => {
          const c = controlById.get(row.control_id);
          return { value: row.id, label: c ? `${c.control_id} - ${c.title}` : "Assessment control", hint: fmt(row.status ?? "not_assessed") };
        });
    }
    if (targetType === "assessment") {
      return assessments
        .map((row) => ({ value: row.id, label: row.name, hint: fmt(row.status ?? "draft") }));
    }
    if (targetType === "risk") {
      return risks
        .filter(inScope)
        .map((row) => ({ value: row.id, label: row.name, hint: fmt(row.status ?? "open") }));
    }
    return [];
  }, [appliedControls, assessmentControls, assessments, controlById, controls, exc, risks, targetType]);

  const reload = async () => {
    if (!id) return;
    try {
      const row = await getRow<ExceptionRow>(TABLE_EXCEPTIONS, id);
      if (!row) {
        setLoadError("Exception not found");
        setExc(null);
      } else {
        setExc(row as ExceptionRow);
        setLoadError(null);
      }
    } catch (err) {
      setLoadError((err as Error)?.message ?? "Failed to load exception");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const patch = async (patchData: Partial<ExceptionRow>) => {
    if (!id || !exc) return;
    setExc({ ...exc, ...patchData });
    try {
      await tables.update(TABLE_EXCEPTIONS, id, patchData);
    } catch (err) {
      toast.error("Save failed: " + ((err as Error)?.message ?? "unknown"));
      reload();
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    const ok = await confirm({
      title: "Delete this exception?",
      body: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true });
    if (!ok) return;
    setDeleting(true);
    try {
      await tables.delete(TABLE_EXCEPTIONS, id);
      navigate("/exceptions");
    } catch (err) {
      toast.error("Delete failed: " + ((err as Error)?.message ?? "unknown"));
      setDeleting(false);
    }
  };

  const attachTarget = async (targetValue: string) => {
    if (!id || !exc || !targetValue) return;
    setLinking("attach");
    try {
      await tables.insert(TABLE_EXCEPTION_LINKS, {
        organization_id: exc.organization_id,
        applied_organizations: scopeOrgIds(exc),
        excluded_organizations: exc.excluded_organizations ?? [],
        exception_id: id,
        target_type: targetType,
        target_id: targetValue,
        relationship: targetType === "risk" ? "accepts_risk_for" : "documents_gap",
        source_system: "bifrost_grc",
        source_id: `${id}:${targetType}:${targetValue}`,
      });
      toast.success("Record attached");
    } catch (err) {
      toast.error("Attach failed: " + ((err as Error)?.message ?? "unknown"));
    } finally {
      setLinking(null);
    }
  };

  const toggleTarget = async (targetValue: string, selected: boolean) => {
    if (!exc) return;
    const existing = exceptionLinks.find(
      (link) => link.target_type === targetType && link.target_id === targetValue,
    );
    if (selected) {
      if (!existing) await attachTarget(targetValue);
      return;
    }
    if (targetType === "control" && exc.control_id === targetValue && !existing) {
      await patch({ control_id: null });
      toast.success("Reference control detached");
      return;
    }
    if (!existing) return;
    setLinking(existing.id);
    try {
      await tables.delete(TABLE_EXCEPTION_LINKS, existing.id);
      toast.success("Record detached");
    } catch (err) {
      toast.error("Detach failed: " + ((err as Error)?.message ?? "unknown"));
      throw err;
    } finally {
      setLinking(null);
    }
  };

  const detachLink = async (link: ExceptionLink) => {
    const ok = await confirm({
      title: "Detach target?",
      body: "The exception and target record will remain; only this relationship will be removed.",
      confirmLabel: "Detach",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    setLinking(link.id);
    try {
      await tables.delete(TABLE_EXCEPTION_LINKS, link.id);
      toast.success("Target detached");
    } catch (err) {
      toast.error("Detach failed: " + ((err as Error)?.message ?? "unknown"));
    } finally {
      setLinking(null);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80 }}>
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (loadError || !exc) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Link to="/exceptions" style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "var(--cv-fg-3)", textDecoration: "none", fontSize: 13 }}>
          <ArrowLeft size={14} /> Back to exceptions
        </Link>
        <EmptyState
          icon={AlertOctagon}
          title={loadError ?? "Exception not found"}
          body="This exception may have been deleted or you may not have access."
        />
      </div>
    );
  }

  const headerTitle =
    exc.name ||
    (control ? `Exception for ${control.control_id}` : "Untitled exception");
  const selectedTargetValues = exceptionLinks
    .filter((link) => link.target_type === targetType)
    .map((link) => link.target_id);
  if (targetType === "control" && exc.control_id && !selectedTargetValues.includes(exc.control_id)) {
    selectedTargetValues.push(exc.control_id);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Link to="/exceptions" style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "var(--cv-fg-3)", textDecoration: "none", fontSize: 13, width: "fit-content" }}>
        <ArrowLeft size={14} /> Exceptions
      </Link>

      <PageHeader
        title={headerTitle}
        crumb="EXCEPTION"
        actions={
          <>
            <ScopeBadge row={exc} />
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
        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cv-field-label" htmlFor="exception-summary">Summary</label>
            <input
              id="exception-summary"
              className="cv-field"
              defaultValue={exc.name ?? ""}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== (exc.name ?? "")) patch({ name: value || null });
              }}
              placeholder="Short title for lists and approvals"
              disabled={!canEdit}
            />
          </div>

          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionHeader label="Applies to" />
            <p className="cv-small" style={{ margin: 0 }}>
              Attach every control, assessment, applied control, or risk covered by this exception.
              Selections save immediately.
            </p>
            <div className="cv-form-grid">
              <div className="cv-field-group">
                <label className="cv-field-label" htmlFor="exception-target-type">Record type</label>
              <ThemedSelect
                id="exception-target-type"
                value={targetType}
                onChange={(value) => {
                  setTargetType(value);
                }}
                options={[
                  { label: "Applied control", value: "applied_control" },
                  { label: "Reference control", value: "control" },
                  { label: "Assessment control", value: "assessment_control" },
                  { label: "Assessment", value: "assessment" },
                  { label: "Risk", value: "risk" },
                ]}
                ariaLabel="Target type"
                disabled={!canEdit}
              />
              </div>
              <div className="cv-field-group">
                <div className="cv-field-label">Records</div>
                <MultiSelectDropdown
                  label={`Exception ${fmt(targetType)} records`}
                  options={targetOptions}
                  selectedValues={selectedTargetValues}
                  disabled={!canEdit || linking !== null}
                  placeholder={`Select ${fmt(targetType).toLocaleLowerCase()} records…`}
                  onToggle={toggleTarget}
                />
              </div>
            </div>
            {exceptionLinks.length === 0 ? (
              <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
                No records are attached yet.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {exceptionLinks.map((link) => {
                  const resolved = resolveExceptionLink(link, {
                    appliedControls,
                    controls,
                    assessmentControls,
                    assessments,
                    risks,
                    controlById,
                  });
                  return (
                    <div key={link.id} className="cv-card cv-card--recessed" style={{ padding: 10, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}>
                      <Link to={resolved.href} className="cv-link" style={{ minWidth: 0, textDecoration: "none" }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                          <span className="cv-chip cv-chip--neutral">{fmt(link.target_type)}</span>
                          <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{resolved.label}</span>
                        </div>
                        <div className="cv-small" style={{ marginTop: 3 }}>
                          {[fmt(link.relationship ?? "documents_gap"), resolved.meta].filter(Boolean).join(" · ")}
                        </div>
                      </Link>
                      {canEdit ? <button
                        className="cv-btn cv-btn--ghost cv-btn--sm"
                        onClick={() => detachLink(link)}
                        disabled={linking === link.id}
                        aria-label={`Detach ${resolved.label}`}
                      >
                        <Trash2 size={13} />
                      </button> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Justification */}
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeader label="Justification" />
            <label className="sr-only" htmlFor="exception-justification">Justification</label>
            <textarea
              id="exception-justification"
              className="cv-field"
              defaultValue={exc.reason ?? ""}
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== (exc.reason ?? "")) patch({ reason: v });
              }}
              rows={5}
              placeholder="Why does this exception need to exist?"
              disabled={!canEdit}
            />
          </div>

          {/* Compensating controls */}
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeader label="Compensating controls" />
            <label className="sr-only" htmlFor="exception-compensating">Compensating controls</label>
            <textarea
              id="exception-compensating"
              className="cv-field"
              defaultValue={exc.compensating_controls ?? ""}
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== (exc.compensating_controls ?? "")) patch({ compensating_controls: v || null });
              }}
              rows={4}
              placeholder="What offsets the exception in practice?"
              disabled={!canEdit}
            />
          </div>
        </div>

        {/* Side rail */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeader label="Scope" />
            <OrgScopeField
              id="exception-organization-scope"
              value={scopeOrgIds(exc)}
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
              value={exc.status ?? "pending"}
              onChange={(status) => patch({ status })}
              options={STATUS_OPTIONS}
              ariaLabel="Exception status"
              disabled={!canEdit}
            />
          </div>

          <div className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <SectionHeader label="Approval" />
            <Row label="Approved by" value={userName(exc.approved_by)} />
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="exception-expiry">Expiry date</label>
              <input
                id="exception-expiry"
                className="cv-field"
                type="date"
                defaultValue={toDateInput(exc.expires_at)}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== toDateInput(exc.expires_at)) patch({ expires_at: v || null });
                }}
                disabled={!canEdit}
              />
              <div style={{ marginTop: 6 }}>
                <ExpiryChip expiresAt={exc.expires_at} />
              </div>
            </div>
          </div>

          <div className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--cv-fg-3)" }}>
            <SectionHeader label="Audit" />
            <Row label="Created" value={fmtDateTime(exc.created_at)} />
            <Row label="Updated" value={fmtDateTime(exc.updated_at)} />
            {exc.created_by ? <Row label="By" value={userName(exc.created_by)} /> : null}
          </div>
        </div>
      </div>
      </fieldset>
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

function resolveExceptionLink(
  link: ExceptionLink,
  data: {
    appliedControls: AppliedControl[];
    controls: Control[];
    assessmentControls: AssessmentControl[];
    assessments: Assessment[];
    risks: Risk[];
    controlById: Map<string, Control>;
  },
): { label: string; meta?: string | null; href: string } {
  if (link.target_type === "applied_control") {
    const row = data.appliedControls.find((item) => item.id === link.target_id);
    return {
      label: row?.name ?? "Unresolved applied control",
      meta: row?.status ? fmt(row.status) : null,
      href: `/applied-controls/${link.target_id}`,
    };
  }
  if (link.target_type === "control") {
    const row = data.controls.find((item) => item.id === link.target_id);
    return {
      label: row ? `${row.control_id} ${row.title}`.trim() : "Unresolved reference control",
      meta: "Reference control",
      href: "/controls",
    };
  }
  if (link.target_type === "assessment_control") {
    const row = data.assessmentControls.find((item) => item.id === link.target_id);
    const control = row?.control_id ? data.controlById.get(row.control_id) : undefined;
    return {
      label: control ? `${control.control_id} ${control.title}`.trim() : "Unresolved assessment control",
      meta: row?.status ? fmt(row.status) : "Assessment control",
      href: row?.assessment_id ? `/assessments/${row.assessment_id}` : "/assessments",
    };
  }
  if (link.target_type === "assessment") {
    const row = data.assessments.find((item) => item.id === link.target_id);
    return {
      label: row?.name ?? "Unresolved assessment",
      meta: row?.status ? fmt(row.status) : null,
      href: `/assessments/${link.target_id}`,
    };
  }
  if (link.target_type === "risk") {
    const row = data.risks.find((item) => item.id === link.target_id);
    return {
      label: row?.name ?? "Unresolved risk",
      meta: row?.status ? fmt(row.status) : null,
      href: `/risks/${link.target_id}`,
    };
  }
  return { label: "Unresolved record", meta: link.target_type, href: "/exceptions" };
}
