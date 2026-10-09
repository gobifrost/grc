import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useParams } from "react-router-dom";
import { ArrowLeft, Save, Trash2, Plus, Link2, FileText, Paperclip, AlertTriangle, Pencil } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import SectionHeader from "../../components/shared/SectionHeader";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ThemedSelect from "../../components/shared/ThemedSelect";
import StateSegmented from "../../components/shared/StateSegmented";
import UserPicker from "../../components/shared/UserPicker";
import TagInput from "../../components/shared/TagInput";
import MultiSelectDropdown from "../../components/shared/MultiSelectDropdown";
import { confirm } from "../../components/shared/ConfirmDialog";
import {
  TABLE_APPLIED_CONTROLS,
  TABLE_CONTROLS,
  TABLE_CONTROL_MAPPINGS,
  TABLE_EVIDENCE,
  TABLE_EVIDENCE_LINKS,
  TABLE_POLICIES,
  TABLE_POLICY_LINKS,
  TABLE_EXCEPTIONS,
  TABLE_EXCEPTION_LINKS,
  TABLE_FRAMEWORKS,
  TABLE_DOMAINS,
} from "../../lib/grc-tables";
import { useOrgNamesMap } from "../../lib/directory";
import { useGrcPermissions } from "../../lib/current-user";
import { inheritedScope, scopeOrgIds, scopesOverlap } from "../../lib/scope";
import {
  APPLIED_CONTROL_STATE_OPTIONS,
  appliedControlState,
  appliedControlStatePatch,
  normalizeControlType,
  type AppliedControlState,
} from "../../lib/applied-control-state";
import type {
  AppliedControl,
  Control,
  ControlMapping,
  ControlMappingRelationship,
  Domain,
  Evidence,
  EvidenceLink,
  Exception,
  ExceptionLink,
  Framework,
  Policy,
  PolicyLink,
} from "../../lib/types";

const RELATIONSHIP_OPTIONS: Array<{ label: string; value: ControlMappingRelationship }> = [
  { label: "Satisfies", value: "satisfies" },
  { label: "Partially satisfies", value: "partially_satisfies" },
  { label: "Supports", value: "supports" },
  { label: "Conflicts", value: "conflicts" },
  { label: "Informational", value: "informational" },
];
const TYPE_OPTIONS = [
  { label: "Technical", value: "technical" },
  { label: "Administrative / policy", value: "administrative" },
  { label: "Process", value: "process" },
  { label: "Physical", value: "physical" },
  { label: "Compensating", value: "compensating" },
];

function unwrapRow<T>(raw: unknown): (T & { id: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ("data" in r && r.data && typeof r.data === "object") {
    return { id: String(r.id ?? ""), ...(r.data as Record<string, unknown>) } as T & { id: string };
  }
  return r as T & { id: string };
}

function labelize(value?: string | null): string {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

export default function AppliedControlDetailPage() {
  const { canEdit } = useGrcPermissions();
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const orgNameById = useOrgNamesMap();

  const [item, setItem] = useState<AppliedControl | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mappingControlId, setMappingControlId] = useState("");
  const [mappingRelationship, setMappingRelationship] = useState<ControlMappingRelationship>("satisfies");
  const [mappingRationale, setMappingRationale] = useState("");
  const [addingMapping, setAddingMapping] = useState(false);
  const [editingMappingId, setEditingMappingId] = useState<string | null>(null);
  const [editingRelationship, setEditingRelationship] = useState<ControlMappingRelationship>("satisfies");
  const [editingRationale, setEditingRationale] = useState("");
  const [savingMapping, setSavingMapping] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  const [draft, setDraft] = useState({
    organizationScope: null as string[] | null,
    name: "",
    description: "",
    control_type: "",
    owner: "",
    state: "active" as AppliedControlState,
    maturity: "unknown",
    tags_json: null as string | null,
  });

  const load = async (showSpinner = true) => {
    if (!id) return;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const row = unwrapRow<AppliedControl>(await tables.get(TABLE_APPLIED_CONTROLS, id));
      if (!row) {
        setError("Applied control not found.");
        setItem(null);
      } else {
        setItem(row);
        setDraft({
          organizationScope: scopeOrgIds(row),
          name: row.name ?? "",
          description: row.description ?? "",
          control_type: normalizeControlType(row.control_type),
          owner: row.owner ?? "",
          state: appliedControlState(row),
          maturity: row.maturity ?? "unknown",
          tags_json: row.tags_json ?? null,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load applied control");
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const { rows: mappings } = useTable<ControlMapping>(TABLE_CONTROL_MAPPINGS, {
    where: { applied_control_id: id },
    pageSize: 500,
  });
  const { rows: controls } = useTable<Control>(TABLE_CONTROLS, { pageSize: 1000, order_by: "control_id", order_dir: "asc" });
  const { rows: frameworks } = useTable<Framework>(TABLE_FRAMEWORKS, { pageSize: 500 });
  const { rows: domains } = useTable<Domain>(TABLE_DOMAINS, { pageSize: 1000 });
  const { rows: evidenceLinks } = useTable<EvidenceLink>(TABLE_EVIDENCE_LINKS, {
    where: { target_type: "applied_control", target_id: id },
    pageSize: 500,
  });
  const { rows: policyLinks } = useTable<PolicyLink>(TABLE_POLICY_LINKS, {
    where: { target_type: "applied_control", target_id: id },
    pageSize: 500,
  });
  const { rows: exceptionLinks } = useTable<ExceptionLink>(TABLE_EXCEPTION_LINKS, {
    where: { target_type: "applied_control", target_id: id },
    pageSize: 500,
  });
  const { rows: evidenceRows } = useTable<Evidence>(TABLE_EVIDENCE, { pageSize: 1000 });
  const { rows: policyRows } = useTable<Policy>(TABLE_POLICIES, { pageSize: 1000 });
  const { rows: exceptionRows } = useTable<Exception>(TABLE_EXCEPTIONS, { pageSize: 1000 });

  const controlById = useMemo(() => {
    const m = new Map<string, Control>();
    (controls ?? []).forEach((row) => m.set(row.id, row));
    return m;
  }, [controls]);
  const frameworkById = useMemo(() => {
    const m = new Map<string, Framework>();
    (frameworks ?? []).forEach((row) => m.set(row.id, row));
    return m;
  }, [frameworks]);
  const domainById = useMemo(() => {
    const m = new Map<string, Domain>();
    (domains ?? []).forEach((row) => m.set(row.id, row));
    return m;
  }, [domains]);
  const evidenceById = useMemo(() => {
    const m = new Map<string, Evidence>();
    (evidenceRows ?? []).forEach((row) => m.set(row.id, row));
    return m;
  }, [evidenceRows]);
  const policyById = useMemo(() => {
    const m = new Map<string, Policy>();
    (policyRows ?? []).forEach((row) => m.set(row.id, row));
    return m;
  }, [policyRows]);
  const exceptionById = useMemo(() => {
    const m = new Map<string, Exception>();
    (exceptionRows ?? []).forEach((row) => m.set(row.id, row));
    return m;
  }, [exceptionRows]);

  const controlOptions = useMemo(() => {
    const mapped = new Set((mappings ?? []).map((row) => row.control_id));
    return (controls ?? [])
      .filter((row) => !mapped.has(row.id))
      .map((row) => ({
        value: row.id,
        label: `${row.control_id} - ${row.title}`,
        hint: frameworkById.get(row.framework_id)?.name,
      }));
  }, [controls, frameworkById, mappings]);
  const evidenceOptions = useMemo(() => {
    return (evidenceRows ?? [])
      .filter((row) => item ? scopesOverlap(row, item) : false)
      .map((row) => ({ value: row.id, label: row.name, hint: labelize(row.type) }));
  }, [evidenceRows, item]);
  const policyOptions = useMemo(() => {
    return (policyRows ?? [])
      .filter((row) => item ? scopesOverlap(row, item) : false)
      .map((row) => ({ value: row.id, label: row.name, hint: labelize(row.status) }));
  }, [item, policyRows]);
  const exceptionOptions = useMemo(() => {
    return (exceptionRows ?? [])
      .filter((row) => item ? scopesOverlap(row, item) : false)
      .map((row) => ({ value: row.id, label: row.name || row.reason, hint: labelize(row.status) }));
  }, [exceptionRows, item]);

  const save = async () => {
    if (!item || !id) return;
    if (draft.organizationScope?.length === 0) {
      toast.error("Choose at least one organization or select All");
      return;
    }
    if (!draft.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const statePatch = appliedControlStatePatch(draft.state);
      await tables.update(TABLE_APPLIED_CONTROLS, id, {
        applied_organizations: draft.organizationScope,
        excluded_organizations: [],
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        control_type: draft.control_type.trim() || null,
        owner: draft.owner.trim() || null,
        ...statePatch,
        maturity: draft.maturity || null,
        tags_json: draft.tags_json,
      });
      toast.success("Applied control saved");
      await load(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!item || !id) return;
    const ok = await confirm({
      title: "Delete applied control?",
      body: `"${item.name}" will be removed. Existing link rows are not automatically deleted yet.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await tables.delete(TABLE_APPLIED_CONTROLS, id);
      navigate("/applied-controls");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  };

  const addMapping = async () => {
    if (!item || !mappingControlId) {
      toast.error("Choose a framework control");
      return;
    }
    setAddingMapping(true);
    try {
      await tables.insert(TABLE_CONTROL_MAPPINGS, {
        organization_id: item.organization_id,
        ...inheritedScope(item),
        applied_control_id: item.id,
        control_id: mappingControlId,
        relationship: mappingRelationship,
        confidence: 1,
        status: "accepted",
        rationale: mappingRationale.trim() || null,
      });
      setMappingControlId("");
      setMappingRationale("");
      toast.success("Mapping added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add mapping");
    } finally {
      setAddingMapping(false);
    }
  };

  const removeMapping = async (mappingId: string) => {
    try {
      await tables.delete(TABLE_CONTROL_MAPPINGS, mappingId);
      toast.success("Mapping removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove mapping");
    }
  };

  const startEditingMapping = (mapping: ControlMapping) => {
    setEditingMappingId(mapping.id);
    setEditingRelationship(mapping.relationship);
    setEditingRationale(mapping.rationale ?? "");
  };

  const saveMapping = async () => {
    if (!editingMappingId) return;
    setSavingMapping(true);
    try {
      await tables.update(TABLE_CONTROL_MAPPINGS, editingMappingId, {
        relationship: editingRelationship,
        rationale: editingRationale.trim() || null,
      });
      setEditingMappingId(null);
      toast.success("Mapping updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update mapping");
    } finally {
      setSavingMapping(false);
    }
  };

  const attachEvidence = async (selectedEvidenceId: string) => {
    if (!item || !selectedEvidenceId) {
      toast.error("Choose evidence");
      return;
    }
    setLinking("evidence");
    try {
      await tables.insert(TABLE_EVIDENCE_LINKS, {
        organization_id: item.organization_id,
        ...inheritedScope(item),
        evidence_id: selectedEvidenceId,
        target_type: "applied_control",
        target_id: item.id,
        relationship: "supports",
      });
      toast.success("Evidence attached");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to attach evidence");
    } finally {
      setLinking(null);
    }
  };

  const attachPolicy = async (selectedPolicyId: string) => {
    if (!item || !selectedPolicyId) {
      toast.error("Choose a policy");
      return;
    }
    setLinking("policy");
    try {
      await tables.insert(TABLE_POLICY_LINKS, {
        organization_id: item.organization_id,
        ...inheritedScope(item),
        policy_id: selectedPolicyId,
        target_type: "applied_control",
        target_id: item.id,
        relationship: "supports",
      });
      toast.success("Policy attached");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to attach policy");
    } finally {
      setLinking(null);
    }
  };

  const attachException = async (selectedExceptionId: string) => {
    if (!item || !selectedExceptionId) {
      toast.error("Choose an exception");
      return;
    }
    setLinking("exception");
    try {
      await tables.insert(TABLE_EXCEPTION_LINKS, {
        organization_id: item.organization_id,
        ...inheritedScope(item),
        exception_id: selectedExceptionId,
        target_type: "applied_control",
        target_id: item.id,
        relationship: "documents_gap",
      });
      toast.success("Exception attached");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to attach exception");
    } finally {
      setLinking(null);
    }
  };

  const detachLink = async (table: string, linkId: string, label: string) => {
    const ok = await confirm({
      title: `Detach ${label}?`,
      body: "The linked record will stay in the catalog; only this relationship will be removed.",
      confirmLabel: "Detach",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    setLinking(linkId);
    try {
      await tables.delete(table, linkId);
      toast.success(`${label} detached`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to detach ${label.toLowerCase()}`);
    } finally {
      setLinking(null);
    }
  };

  const toggleLink = async (
    selected: boolean,
    value: string,
    table: string,
    existingLinkId: string | undefined,
    attach: (value: string) => Promise<void>,
    label: string,
  ) => {
    if (selected) {
      await attach(value);
      return;
    }
    if (!existingLinkId) return;
    setLinking(existingLinkId);
    try {
      await tables.delete(table, existingLinkId);
      toast.success(`${label} detached`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to detach ${label.toLowerCase()}`);
      throw err;
    } finally {
      setLinking(null);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--cv-fg-3)" }}>Loading applied control...</div>;
  }
  if (error || !item) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Link className="cv-link" to="/applied-controls" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ArrowLeft size={14} />
          Back to applied controls
        </Link>
        <div className="cv-callout cv-callout--danger">
          <div className="cv-callout__label">Error</div>
          <div className="cv-callout__body">{error ?? "Not found"}</div>
        </div>
      </div>
    );
  }
  const itemScope = scopeOrgIds(item);
  const scopeLabel = itemScope === null
    ? "All organizations"
    : itemScope.length === 1
    ? orgNameById.get(itemScope[0]) ?? "Unknown organization"
    : `${itemScope.length} organizations`;
  const typeOptions = draft.control_type && !TYPE_OPTIONS.some((option) => option.value === draft.control_type)
    ? [{ label: `Imported · ${labelize(draft.control_type)}`, value: draft.control_type }, ...TYPE_OPTIONS]
    : TYPE_OPTIONS;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Link className="cv-link" to="/applied-controls" style={{ display: "inline-flex", gap: 6, alignItems: "center", alignSelf: "flex-start" }}>
        <ArrowLeft size={14} />
        Back to applied controls
      </Link>

      <PageHeader
        title={item.name}
        subtitle={`${scopeLabel} · Updated ${fmtDate(item.updated_at)}`}
        actions={canEdit ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={save} disabled={saving}>
              <Save size={14} />
              {saving ? "Saving..." : "Save"}
            </button>
            <button className="cv-btn cv-btn--destructive cv-btn--sm" onClick={remove} disabled={deleting}>
              <Trash2 size={14} />
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        ) : undefined}
      />

      <fieldset disabled={!canEdit} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
      <div className="cv-record-layout">
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="cv-card" style={{ display: "grid", gap: 14 }}>
            <SectionHeader label="Control Profile" />
            <OrgScopeField
              id="applied-control-scope"
              value={draft.organizationScope}
              onChange={(organizationScope) => setDraft((current) => ({ ...current, organizationScope }))}
            />
            <div className="cv-form-grid">
              <div className="cv-field-group">
                <label className="cv-field-label" htmlFor="applied-control-name">Name *</label>
                <Input id="applied-control-name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="cv-field-group">
                <label className="cv-field-label" htmlFor="applied-control-type">Type</label>
                <ThemedSelect
                  id="applied-control-type"
                  value={draft.control_type}
                  onChange={(control_type) => setDraft((d) => ({ ...d, control_type }))}
                  options={[{ label: "Select type", value: "" }, ...typeOptions]}
                  ariaLabel="Control type"
                />
              </div>
              <UserPicker
                id="applied-control-owner"
                label="Owner"
                value={draft.owner || null}
                orgId={draft.organizationScope?.[0] ?? null}
                onChange={(owner) => setDraft((d) => ({ ...d, owner: owner ?? "" }))}
              />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label">State</label>
              <StateSegmented
                value={draft.state}
                options={APPLIED_CONTROL_STATE_OPTIONS}
                onChange={(state) => setDraft((current) => ({ ...current, state }))}
                ariaLabel="Applied control state"
              />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="applied-control-description">Description</label>
              <Textarea id="applied-control-description" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} rows={5} />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="applied-control-tags">Tags</label>
              <TagInput
                id="applied-control-tags"
                value={draft.tags_json}
                onChange={(tags_json) => setDraft((d) => ({ ...d, tags_json }))}
                suggestions={Array.from(
                  new Set(
                    (evidenceRows ?? [])
                      .flatMap((row) => row.tags ?? [])
                      .filter((tag): tag is string => typeof tag === "string"),
                  ),
                )}
              />
            </div>
          </div>

          <div className="cv-card" style={{ display: "grid", gap: 14 }}>
            <SectionHeader label="Mapped Framework Controls" />
            <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 1fr) 180px", gap: 10 }}>
              <ThemedSelect
                value={mappingControlId}
                onChange={setMappingControlId}
                options={[{ label: "Choose framework control", value: "" }, ...controlOptions]}
                searchable
                ariaLabel="Mapped framework control"
              />
              <ThemedSelect value={mappingRelationship} onChange={(v) => setMappingRelationship(v as ControlMappingRelationship)} options={RELATIONSHIP_OPTIONS} ariaLabel="Relationship" />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="mapping-rationale">Rationale</label>
              <Input id="mapping-rationale" value={mappingRationale} onChange={(e) => setMappingRationale(e.target.value)} placeholder="Why this applied control satisfies the framework control" />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={addMapping} disabled={addingMapping}>
                <Plus size={14} />
                {addingMapping ? "Adding..." : "Add mapping"}
              </button>
            </div>
            {(mappings ?? []).length === 0 ? (
              <div className="cv-callout cv-callout--note">
                <div className="cv-callout__label">No mappings</div>
                <div className="cv-callout__body">Mappings let assessments prefill from real customer controls.</div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {(mappings ?? []).map((mapping) => {
                  const control = controlById.get(mapping.control_id);
                  const framework = control ? frameworkById.get(control.framework_id) : undefined;
                  const domain = control?.domain_id ? domainById.get(control.domain_id) : undefined;
                  const editing = editingMappingId === mapping.id;
                  return (
                    <div key={mapping.id} className="cv-card cv-card--pad-sm" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "start" }}>
                      <div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="cv-chip cv-chip--neutral cv-chip--mono">{control?.control_id ?? "Unknown"}</span>
                          <span style={{ fontWeight: 500 }}>{control?.title ?? mapping.control_id}</span>
                          {!editing ? <span className="cv-chip cv-chip--teal">{labelize(mapping.relationship)}</span> : null}
                        </div>
                        <div style={{ color: "var(--cv-fg-3)", fontSize: 12, marginTop: 4 }}>
                          {framework?.name ?? "Unknown framework"}{domain ? ` / ${domain.name}` : ""}
                        </div>
                        {editing ? (
                          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                            <ThemedSelect
                              value={editingRelationship}
                              onChange={(value) => setEditingRelationship(value as ControlMappingRelationship)}
                              options={RELATIONSHIP_OPTIONS}
                              ariaLabel="Mapping relationship"
                            />
                            <Input
                              aria-label="Mapping rationale"
                              value={editingRationale}
                              onChange={(event) => setEditingRationale(event.target.value)}
                              placeholder="Why this control supports the mapped requirement"
                            />
                          </div>
                        ) : mapping.rationale ? (
                          <div style={{ color: "var(--cv-fg-2)", fontSize: 13, marginTop: 8 }}>{mapping.rationale}</div>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {editing ? (
                          <>
                            <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={saveMapping} disabled={savingMapping}>
                              {savingMapping ? "Saving…" : "Save"}
                            </button>
                            <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setEditingMappingId(null)} disabled={savingMapping}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => startEditingMapping(mapping)}>
                            <Pencil size={13} aria-hidden="true" /> Edit
                          </button>
                        )}
                        {!editing ? (
                          <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => removeMapping(mapping.id)}>
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="cv-card" style={{ display: "grid", gap: 12 }}>
            <SectionHeader label="Linked Records" />
            <LinkList
              icon={Paperclip}
              title="Evidence"
              rows={(evidenceLinks ?? []).map((link) => ({ id: link.id, href: `/evidence/${link.evidence_id}`, label: evidenceById.get(link.evidence_id)?.name ?? link.evidence_id, meta: link.relationship, onDetach: () => detachLink(TABLE_EVIDENCE_LINKS, link.id, "Evidence") }))}
            />
            <MultiSelectDropdown
              label="Evidence"
              options={evidenceOptions}
              selectedValues={(evidenceLinks ?? []).map((link) => link.evidence_id)}
              disabled={linking !== null}
              placeholder="Select evidence to attach…"
              onToggle={(value, selected) =>
                toggleLink(
                  selected,
                  value,
                  TABLE_EVIDENCE_LINKS,
                  evidenceLinks?.find((link) => link.evidence_id === value)?.id,
                  attachEvidence,
                  "Evidence",
                )
              }
            />
            <LinkList
              icon={FileText}
              title="Policies"
              rows={(policyLinks ?? []).map((link) => ({ id: link.id, href: `/policies/${link.policy_id}`, label: policyById.get(link.policy_id)?.name ?? link.policy_id, meta: link.relationship, onDetach: () => detachLink(TABLE_POLICY_LINKS, link.id, "Policy") }))}
            />
            <MultiSelectDropdown
              label="Policies"
              options={policyOptions}
              selectedValues={(policyLinks ?? []).map((link) => link.policy_id)}
              disabled={linking !== null}
              placeholder="Select policies to attach…"
              onToggle={(value, selected) =>
                toggleLink(
                  selected,
                  value,
                  TABLE_POLICY_LINKS,
                  policyLinks?.find((link) => link.policy_id === value)?.id,
                  attachPolicy,
                  "Policy",
                )
              }
            />
            <LinkList
              icon={AlertTriangle}
              title="Exceptions"
              rows={(exceptionLinks ?? []).map((link) => ({ id: link.id, href: `/exceptions/${link.exception_id}`, label: exceptionById.get(link.exception_id)?.name || exceptionById.get(link.exception_id)?.reason || "Unresolved exception", meta: link.relationship, onDetach: () => detachLink(TABLE_EXCEPTION_LINKS, link.id, "Exception") }))}
            />
            <MultiSelectDropdown
              label="Exceptions"
              options={exceptionOptions}
              selectedValues={(exceptionLinks ?? []).map((link) => link.exception_id)}
              disabled={linking !== null}
              placeholder="Select exceptions to attach…"
              onToggle={(value, selected) =>
                toggleLink(
                  selected,
                  value,
                  TABLE_EXCEPTION_LINKS,
                  exceptionLinks?.find((link) => link.exception_id === value)?.id,
                  attachException,
                  "Exception",
                )
              }
            />
          </div>

          <div className="cv-card" style={{ display: "grid", gap: 10 }}>
            <SectionHeader label="Source Metadata" />
            <MetaRow label="Source system" value={item.source_system} />
            <MetaRow label="Source ID" value={item.source_id} mono />
            <MetaRow label="Source URL" value={item.source_url} />
            <MetaRow label="Created" value={fmtDate(item.created_at)} />
            <MetaRow label="Updated" value={fmtDate(item.updated_at)} />
          </div>
        </div>
      </div>
      </fieldset>
    </div>
  );
}

function MetaRow({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "105px 1fr", gap: 10, fontSize: 13 }}>
      <div style={{ color: "var(--cv-fg-3)" }}>{label}</div>
      <div className={mono ? "cv-mono" : undefined} style={{ color: "var(--cv-fg-2)", overflowWrap: "anywhere" }}>{value || "—"}</div>
    </div>
  );
}

function LinkList({
  icon: Icon,
  title,
  rows,
}: {
  icon: LucideIcon;
  title: string;
  rows: Array<{ id: string; href: string; label: string; meta?: string | null; onDetach?: () => void }>;
}) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--cv-fg-2)", fontSize: 13, fontWeight: 500 }}>
        <Icon size={14} />
        {title}
        <span className="cv-chip cv-chip--neutral cv-chip--mono">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ color: "var(--cv-fg-3)", fontSize: 13 }}>None linked</div>
      ) : (
        rows.map((row) => (
          <div key={row.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "center" }}>
            <Link to={row.href} className="cv-link" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, minWidth: 0 }}>
              <Link2 size={12} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
              {row.meta ? <span style={{ color: "var(--cv-fg-3)", whiteSpace: "nowrap" }}>({row.meta})</span> : null}
            </Link>
            {row.onDetach ? (
              <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={row.onDetach} aria-label={`Detach ${row.label}`}>
                <Trash2 size={13} />
              </button>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
