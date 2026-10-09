import { useGovernedTables } from "../../lib/governed-tables";
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTable, useWorkflowMutation } from "bifrost";
import { Loader2, ArrowLeft, Trash2, ChevronDown, ChevronRight, CheckCircle2, Clock, Pencil, Layers, Maximize2, Delete, Expand, Paperclip } from "lucide-react";
import { useParams } from "react-router-dom";
import { useGrcPermissions } from "../../lib/current-user";
import PdfExportButton from "../../components/shared/PdfExportButton";
import { useOrganizationView } from "../../lib/organization-view";
import PageHeader from "../../components/shared/PageHeader";
import EmptyState from "../../components/shared/EmptyState";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import StatusBadge from "../../components/shared/StatusBadge";
import ProgressRing from "../../components/shared/ProgressRing";
import SectionHeader from "../../components/shared/SectionHeader";
import ThemedSelect, {
  type ThemedSelectOption } from "../../components/shared/ThemedSelect";
import UserPicker from "../../components/shared/UserPicker";
import { confirm } from "../../components/shared/ConfirmDialog";
import BifrostDialogFrame from "../../components/shared/BifrostDialogFrame";
import ControlRow from "../../components/assessment-filler/ControlRow";
import type {
  LinkedAppliedControl,
  LinkedEvidenceRecord,
  LinkedExceptionRecord,
  LinkedPolicyRecord,
} from "../../components/assessment-filler/ControlRow";
import FlashcardView from "../../components/assessment-filler/FlashcardView";
import EvidencePickerDialog from "../../components/assessment-filler/EvidencePickerDialog";
import type { UploadedFile } from "../../components/shared/FileUpload";
import {
  TABLE_ASSESSMENTS,
  TABLE_FRAMEWORKS,
  TABLE_DOMAINS,
  TABLE_CONTROLS,
  TABLE_ASSESSMENT_CONTROLS,
  TABLE_ASSESSMENT_CONTROL_OVERRIDES,
  TABLE_EVIDENCE,
  TABLE_EVIDENCE_LINKS,
  TABLE_POLICIES,
  TABLE_POLICY_LINKS,
  TABLE_EXCEPTIONS,
  TABLE_EXCEPTION_LINKS,
  TABLE_APPLIED_CONTROLS,
  TABLE_CONTROL_MAPPINGS,
  WF_UPDATE_ASSESSMENT_CONTROL,
  WF_SET_ASSESSMENT_CONTROL_OVERRIDE,
  WF_CLEAR_ASSESSMENT_CONTROL_OVERRIDE,
  WF_EXPORT_ASSESSMENT_PDF } from "../../lib/grc-tables";
import { useUsersList, useOrgNamesMap, type UserEntry } from "../../lib/directory";
import OrgScopeField from "../../components/shared/OrgScopeField";
import { appliesToOrg, inheritedScope, scopeOrgIds } from "../../lib/scope";
import type {
  Assessment,
  AssessmentControl,
  AssessmentControlOverride,
  AssessmentStatus,
  AppliedControl,
  Control,
  ControlMapping,
  ControlStatus,
  Domain,
  Evidence,
  EvidenceLink,
  Exception,
  ExceptionLink,
  Framework,
  Policy,
  PolicyLink } from "../../lib/types";

function unwrapRow<T>(raw: unknown): (T & { id: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ("data" in r && r.data && typeof r.data === "object") {
    return { id: String(r.id ?? ""), ...(r.data as Record<string, unknown>) } as T & {
      id: string;
    };
  }
  return r as T & { id: string };
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric" });
  } catch {
    return "—";
  }
}

type TabKey = "overview" | "controls" | "evidence";
const ASSESSMENT_STATUSES: AssessmentStatus[] = [
  "draft",
  "in_progress",
  "completed",
  "reviewed",
];

function fmtStatus(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function AssessmentDetailPage() {
  const tables = useGovernedTables();
  const { canEdit } = useGrcPermissions();
  const { organizationId: viewedOrganizationId } = useOrganizationView();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const assessmentId = params.id ?? "";

  // ---- Assessment (single row via tables.get) ----
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [assessmentLoading, setAssessmentLoading] = useState(true);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [assessmentRefreshKey, setAssessmentRefreshKey] = useState(0);

  useEffect(() => {
    if (!assessmentId) return;
    let cancelled = false;
    setAssessmentLoading(true);
    setAssessmentError(null);
    tables
      .get(TABLE_ASSESSMENTS, assessmentId)
      .then((raw: unknown) => {
        if (cancelled) return;
        const row = unwrapRow<Assessment>(raw);
        setAssessment(row);
        setAssessmentLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setAssessmentError(e instanceof Error ? e.message : String(e));
        setAssessmentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assessmentId, assessmentRefreshKey]);

  // Only used after status transitions or evidence create/delete — NOT per-control changes.
  const refetchAssessment = () => setAssessmentRefreshKey((k) => k + 1);

  const frameworkId = assessment?.framework_id ?? "";

  // ---- Framework (single row) ----
  const [framework, setFramework] = useState<Framework | null>(null);
  useEffect(() => {
    if (!frameworkId) {
      setFramework(null);
      return;
    }
    let cancelled = false;
    tables
      .get(TABLE_FRAMEWORKS, frameworkId)
      .then((raw: unknown) => {
        if (cancelled) return;
        setFramework(unwrapRow<Framework>(raw));
      })
      .catch(() => {
        if (cancelled) return;
        setFramework(null);
      });
    return () => {
      cancelled = true;
    };
  }, [frameworkId]);

  // ---- AC rows, domains, controls, evidence (live) ----
  const acTable = useTable<AssessmentControl>(TABLE_ASSESSMENT_CONTROLS, {
    where: { assessment_id: assessmentId },
    pageSize: 1000 });
  const acRows: AssessmentControl[] = acTable.rows ?? [];

  const domainsTable = useTable<Domain>(
    TABLE_DOMAINS,
    frameworkId
      ? { where: { framework_id: frameworkId }, pageSize: 500, order_by: "sort_order", order_dir: "asc" }
      : { pageSize: 1 },
  );

  const controlsTable = useTable<Control>(
    TABLE_CONTROLS,
    frameworkId
      ? { where: { framework_id: frameworkId }, pageSize: 1000, order_by: "sort_order", order_dir: "asc" }
      : { pageSize: 1 },
  );
  const controls: Control[] = frameworkId ? controlsTable.rows ?? [] : [];
  const domains: Domain[] = frameworkId ? domainsTable.rows ?? [] : [];

  const evidenceTable = useTable<Evidence>(TABLE_EVIDENCE, {
    where: { assessment_id: assessmentId },
    pageSize: 1000,
    order_by: "created_at",
    order_dir: "desc" });
  const evidence: Evidence[] = evidenceTable.rows ?? [];

  const appliedControlsTable = useTable<AppliedControl>(TABLE_APPLIED_CONTROLS, { pageSize: 1000 });
  const appliedControls: AppliedControl[] = appliedControlsTable.rows ?? [];
  const controlMappingsTable = useTable<ControlMapping>(TABLE_CONTROL_MAPPINGS, { pageSize: 1000 });
  const controlMappings: ControlMapping[] = controlMappingsTable.rows ?? [];
  const evidenceLinksTable = useTable<EvidenceLink>(TABLE_EVIDENCE_LINKS, { pageSize: 1000 });
  const evidenceLinks: EvidenceLink[] = evidenceLinksTable.rows ?? [];
  const policiesTable = useTable<Policy>(TABLE_POLICIES, { pageSize: 1000 });
  const policies: Policy[] = policiesTable.rows ?? [];
  const policyLinksTable = useTable<PolicyLink>(TABLE_POLICY_LINKS, { pageSize: 1000 });
  const policyLinks: PolicyLink[] = policyLinksTable.rows ?? [];
  const exceptionsTable = useTable<Exception>(TABLE_EXCEPTIONS, { pageSize: 1000 });
  const exceptions: Exception[] = exceptionsTable.rows ?? [];
  const exceptionLinksTable = useTable<ExceptionLink>(TABLE_EXCEPTION_LINKS, { pageSize: 1000 });
  const exceptionLinks: ExceptionLink[] = exceptionLinksTable.rows ?? [];

  // Per-org overrides — managed manually because the platform websocket
  // (useTable's live subscription) is intermittently broken; we don't want
  // exception edits to silently fail to render. Pattern: one-shot fetch on
  // mount + optimistic local state updates after each mutation.
  const [overrides, setOverrides] = useState<AssessmentControlOverride[]>([]);
  useEffect(() => {
    if (!assessmentId) return;
    let cancelled = false;
    tables
      .query(TABLE_ASSESSMENT_CONTROL_OVERRIDES, {
        where: { assessment_id: assessmentId },
        limit: 1000 })
      .then(async (resp: unknown) => {
        if (cancelled) return;
        const list: unknown[] = Array.isArray(resp)
          ? resp
          : (resp as { rows?: unknown[]; documents?: unknown[] })?.rows ??
            (resp as { documents?: unknown[] })?.documents ??
            [];
        const flat = list.map((r) => {
          const rr = r as Record<string, unknown>;
          if (
            "data" in rr &&
            rr.data &&
            typeof rr.data === "object" &&
            !("control_id" in rr)
          ) {
            return {
              id: String(rr.id ?? ""),
              created_at: rr.created_at as string | undefined,
              updated_at: rr.updated_at as string | undefined,
              ...(rr.data as Record<string, unknown>) } as AssessmentControlOverride;
          }
          return rr as unknown as AssessmentControlOverride;
        });

        // Dedupe by (control_id, customer_organization_id): keep the most recently
        // updated row, delete the rest. Cleans up duplicates from before we
        // switched to deterministic ids.
        const groups = new Map<string, AssessmentControlOverride[]>();
        for (const o of flat) {
          const k = `${o.control_id}|${o.customer_organization_id}`;
          const arr = groups.get(k) ?? [];
          arr.push(o);
          groups.set(k, arr);
        }
        const survivors: AssessmentControlOverride[] = [];
        const dupesToDelete: string[] = [];
        for (const arr of groups.values()) {
          if (arr.length === 1) {
            survivors.push(arr[0]);
            continue;
          }
          arr.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
          survivors.push(arr[0]);
          dupesToDelete.push(...arr.slice(1).map((o) => o.id));
        }
        if (cancelled) return;
        setOverrides(survivors);
        if (dupesToDelete.length > 0) {
          console.log(`[grc] cleaning ${dupesToDelete.length} duplicate override(s)`);
          await Promise.all(
            dupesToDelete.map((id) =>
              tables.delete(TABLE_ASSESSMENT_CONTROL_OVERRIDES, id).catch(() => {}),
            ),
          );
        }
      })
      .catch((e: unknown) => {
        console.error("[grc] load overrides failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [assessmentId]);

  const overridesByControl = useMemo(() => {
    const m = new Map<string, AssessmentControlOverride[]>();
    overrides.forEach((o) => {
      const arr = m.get(o.control_id) ?? [];
      arr.push(o);
      m.set(o.control_id, arr);
    });
    return m;
  }, [overrides]);

  // Users for assigned_to display, read from the platform-org mirror table.
  const { users } = useUsersList();
  const orgNameById = useOrgNamesMap();
  const userById = useMemo(() => {
    const m = new Map<string, UserEntry>();
    users.forEach((u) => u.id && m.set(u.id, u));
    return m;
  }, [users]);

  const userLabel = (uid: string | null | undefined): string => {
    if (!uid) return "unassigned";
    const u = userById.get(uid);
    if (!u) return uid;
    const name = u.name || u.email || uid;
    const email = u.email && u.email !== name ? u.email : "";
    return email ? `${name} (${email})` : name;
  };

  // ---- Lookup maps ----
  const controlById = useMemo(() => {
    const m = new Map<string, Control>();
    controls.forEach((c) => m.set(c.id, c));
    return m;
  }, [controls]);

  const domainById = useMemo(() => {
    const m = new Map<string, Domain>();
    domains.forEach((d) => m.set(d.id, d));
    return m;
  }, [domains]);

  const appliedControlById = useMemo(() => {
    const m = new Map<string, AppliedControl>();
    appliedControls.forEach((row) => m.set(row.id, row));
    return m;
  }, [appliedControls]);

  const evidenceById = useMemo(() => {
    const m = new Map<string, Evidence>();
    evidence.forEach((row) => m.set(row.id, row));
    return m;
  }, [evidence]);

  const policyById = useMemo(() => {
    const m = new Map<string, Policy>();
    policies.forEach((row) => m.set(row.id, row));
    return m;
  }, [policies]);

  const exceptionById = useMemo(() => {
    const m = new Map<string, Exception>();
    exceptions.forEach((row) => m.set(row.id, row));
    return m;
  }, [exceptions]);

  // Sort all AC rows by domain.sort_order then control.sort_order
  const orderedAcRows = useMemo(() => {
    const arr = [...acRows];
    arr.sort((a, b) => {
      const ca = controlById.get(a.control_id);
      const cb = controlById.get(b.control_id);
      const da = ca?.domain_id ? domainById.get(ca.domain_id) : undefined;
      const db = cb?.domain_id ? domainById.get(cb.domain_id) : undefined;
      const dso_a = da?.sort_order ?? 999999;
      const dso_b = db?.sort_order ?? 999999;
      if (dso_a !== dso_b) return dso_a - dso_b;
      const cso_a = ca?.sort_order ?? 999999;
      const cso_b = cb?.sort_order ?? 999999;
      if (cso_a !== cso_b) return cso_a - cso_b;
      return (ca?.control_id ?? "").localeCompare(cb?.control_id ?? "");
    });
    return arr;
  }, [acRows, controlById, domainById]);

  // Group AC rows by domain via control.domain_id.
  const grouped = useMemo(() => {
    const byDomain = new Map<string, AssessmentControl[]>();
    const orphans: AssessmentControl[] = [];
    acRows.forEach((ac) => {
      const ctrl = controlById.get(ac.control_id);
      const did = ctrl?.domain_id ?? "";
      if (!did) {
        orphans.push(ac);
      } else {
        const arr = byDomain.get(did) ?? [];
        arr.push(ac);
        byDomain.set(did, arr);
      }
    });
    const sortFn = (a: AssessmentControl, b: AssessmentControl) => {
      const ca = controlById.get(a.control_id);
      const cb = controlById.get(b.control_id);
      const oa = ca?.sort_order ?? 0;
      const ob = cb?.sort_order ?? 0;
      if (oa !== ob) return oa - ob;
      return (ca?.control_id ?? "").localeCompare(cb?.control_id ?? "");
    };
    byDomain.forEach((arr) => arr.sort(sortFn));
    orphans.sort(sortFn);
    return { byDomain, orphans };
  }, [acRows, controlById]);

  // ---- Optimistic AC overlay ----
  const [acOverlay, setAcOverlay] = useState<Record<string, Partial<AssessmentControl>>>({});

  const mergedAcRows = useMemo(() => {
    if (Object.keys(acOverlay).length === 0) return acRows;
    return acRows.map((ac) => {
      const overlay = acOverlay[ac.id];
      return overlay ? { ...ac, ...overlay } : ac;
    });
  }, [acRows, acOverlay]);

  // Stats from MERGED rows (so optimistic updates show in header immediately).
  const stats = useMemo(() => {
    const total = mergedAcRows.length;
    let compliant = 0;
    let partial = 0;
    let nonc = 0;
    let na = 0;
    mergedAcRows.forEach((ac) => {
      switch (ac.status) {
        case "compliant":
          compliant += 1;
          break;
        case "partially_compliant":
          partial += 1;
          break;
        case "non_compliant":
          nonc += 1;
          break;
        default:
          na += 1;
      }
    });
    const assessed = compliant + partial + nonc;
    return { total, compliant, partial, nonc, na, assessed };
  }, [mergedAcRows]);

  // LOCAL progress: compliant / total. Server-side progress_percentage is used
  // only as initial paint when assessment first loads; once we have AC rows we
  // trust the local computation (so user gets instant feedback on optimistic
  // status changes without refetching the assessment).
  const localPct = useMemo(() => {
    if (stats.total === 0) return Math.round(assessment?.progress_percentage ?? 0);
    return Math.round((stats.compliant / stats.total) * 100);
  }, [stats, assessment?.progress_percentage]);

  // Per-domain compliance breakdown for Overview tab (also uses merged rows).
  const mergedById = useMemo(() => {
    const m = new Map<string, AssessmentControl>();
    mergedAcRows.forEach((ac) => m.set(ac.id, ac));
    return m;
  }, [mergedAcRows]);

  const domainBreakdown = useMemo(() => {
    const rows: Array<{
      domainId: string;
      name: string;
      total: number;
      compliant: number;
      partial: number;
      nonc: number;
    }> = [];
    domains.forEach((d) => {
      const acs = grouped.byDomain.get(d.id) ?? [];
      let c = 0;
      let p = 0;
      let n = 0;
      acs.forEach((ac) => {
        const cur = mergedById.get(ac.id) ?? ac;
        if (cur.status === "compliant") c += 1;
        else if (cur.status === "partially_compliant") p += 1;
        else if (cur.status === "non_compliant") n += 1;
      });
      rows.push({
        domainId: d.id,
        name: d.name ?? "Domain",
        total: acs.length,
        compliant: c,
        partial: p,
        nonc: n });
    });
    return rows;
  }, [domains, grouped.byDomain, mergedById]);

  // ---- Tabs + expand state ----
  const [tab, setTab] = useState<TabKey>("controls");
  const [flashcardOpen, setFlashcardOpen] = useState(false);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(() => new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (domains.length > 0 && expandedDomains.size === 0) {
      setExpandedDomains(new Set(domains.map((d) => d.id)));
    }
  }, [domains, expandedDomains.size]);

  const toggleDomain = (id: string) => {
    setExpandedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const expandAll = () => {
    setExpandedDomains(new Set(domains.map((d) => d.id)));
    setExpandedRows(new Set(acRows.map((a) => a.id)));
  };
  const collapseAll = () => {
    setExpandedDomains(new Set());
    setExpandedRows(new Set());
  };

  // ---- Mutations: AC update via workflow (NO refetch) ----
  const updateAcWorkflow = useWorkflowMutation<{
    success: boolean;
    assessment_control: { id: string };
  }>(WF_UPDATE_ASSESSMENT_CONTROL);
  const setOverrideWorkflow = useWorkflowMutation<AssessmentControlOverride>(
    WF_SET_ASSESSMENT_CONTROL_OVERRIDE,
  );
  const clearOverrideWorkflow = useWorkflowMutation<{ id: string; deleted: boolean }>(
    WF_CLEAR_ASSESSMENT_CONTROL_OVERRIDE,
  );

  const callUpdateAc = async (
    ac: AssessmentControl,
    patch: { status?: ControlStatus; implementation_percentage?: number; notes?: string },
  ) => {
    // Optimistic — overlay stays until live useTable picks up the new row.
    setAcOverlay((prev) => ({ ...prev, [ac.id]: { ...prev[ac.id], ...patch } }));
    try {
      await updateAcWorkflow.mutate({
        assessment_control_id: ac.id,
        ...patch });
      // Intentionally NO refetchAssessment() — header progress comes from local stats.
    } catch (e) {
      toast.error(
        "Couldn't save control: " + (e instanceof Error ? e.message : String(e)),
      );
      setAcOverlay((prev) => {
        const next = { ...prev };
        delete next[ac.id];
        return next;
      });
    }
  };

  // ---- Evidence picker (per-AC) ----
  const [evPickerOpen, setEvPickerOpen] = useState(false);
  const [evPickerAc, setEvPickerAc] = useState<AssessmentControl | null>(null);
  const [evPickerFile, setEvPickerFile] = useState<File | null>(null);

  const openEvidencePicker = (ac: AssessmentControl, file?: File) => {
    setEvPickerAc(ac);
    setEvPickerFile(file ?? null);
    setEvPickerOpen(true);
  };

  const assessmentOwnerOrgId = () => assessment?.organization_id ?? null;
  const assessmentScopePatch = () => ({
    applied_organizations: assessment?.applied_organizations ?? null,
    excluded_organizations: assessment?.excluded_organizations ?? [],
  });

  const linkEvidenceToAssessmentControl = async (evidenceId: string, ac: AssessmentControl) => {
    try {
      await tables.insert(TABLE_EVIDENCE_LINKS, {
        organization_id: assessmentOwnerOrgId(),
        ...assessmentScopePatch(),
        evidence_id: evidenceId,
        target_type: "assessment_control",
        target_id: ac.id,
        relationship: "supports",
        source_system: "bifrost_grc",
        source_id: `${evidenceId}:assessment_control:${ac.id}`,
      });
      refetchAssessment();
    } catch (e) {
      toast.error("Couldn't attach evidence: " + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const assessmentLinkOrgId = () => assessmentOwnerOrgId();

  const linkPolicyToAssessmentControl = async (policyId: string, ac: AssessmentControl) => {
    try {
      await tables.insert(TABLE_POLICY_LINKS, {
        organization_id: assessmentLinkOrgId(),
        ...assessmentScopePatch(),
        policy_id: policyId,
        target_type: "assessment_control",
        target_id: ac.id,
        relationship: "supports",
        source_system: "bifrost_grc",
        source_id: `${policyId}:assessment_control:${ac.id}`,
      });
      toast.success("Policy attached");
      refetchAssessment();
    } catch (e) {
      toast.error("Couldn't attach policy: " + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const linkExceptionToAssessmentControl = async (exceptionId: string, ac: AssessmentControl) => {
    try {
      await tables.insert(TABLE_EXCEPTION_LINKS, {
        organization_id: assessmentLinkOrgId(),
        ...assessmentScopePatch(),
        exception_id: exceptionId,
        target_type: "assessment_control",
        target_id: ac.id,
        relationship: "documents_gap",
        source_system: "bifrost_grc",
        source_id: `${exceptionId}:assessment_control:${ac.id}`,
      });
      toast.success("Exception attached");
      refetchAssessment();
    } catch (e) {
      toast.error("Couldn't attach exception: " + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const detachAssessmentControlLink = async (
    tableName: string,
    linkId: string,
    label: string,
  ) => {
    try {
      await tables.delete(tableName, linkId);
      toast.success(`${label} detached`);
      refetchAssessment();
    } catch (e) {
      toast.error(`Couldn't detach ${label.toLowerCase()}`);
      console.error(`Failed to detach ${label.toLowerCase()} from assessment control`, e);
      throw e;
    }
  };

  const mapAppliedControl = async (controlId: string, appliedControlId: string) => {
    const appliedControl = appliedControlById.get(appliedControlId);
    if (!appliedControl) throw new Error("Applied control not found");
    try {
      await tables.insert(TABLE_CONTROL_MAPPINGS, {
        organization_id: appliedControl.organization_id ?? assessmentOwnerOrgId(),
        ...inheritedScope(appliedControl),
        applied_control_id: appliedControlId,
        control_id: controlId,
        relationship: "satisfies",
        confidence: 1,
        status: "accepted",
        source_system: "bifrost_grc",
        source_id: `${appliedControlId}:control:${controlId}`,
      });
      toast.success("Applied control mapped");
    } catch (e) {
      toast.error("Couldn't map applied control: " + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const unmapAppliedControl = async (mappingId: string) => {
    try {
      await tables.delete(TABLE_CONTROL_MAPPINGS, mappingId);
      toast.success("Applied control unmapped");
    } catch (e) {
      toast.error("Couldn't remove mapping: " + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  // ---- Per-org override mutations ----
  // Helper — extract a flat row from whatever shape the API hands back.
  const flattenRow = (raw: unknown): AssessmentControlOverride => {
    const r = raw as Record<string, unknown>;
    if ("data" in r && r.data && typeof r.data === "object" && !("control_id" in r)) {
      return {
        id: String(r.id ?? ""),
        ...(r.data as Record<string, unknown>) } as AssessmentControlOverride;
    }
    return r as unknown as AssessmentControlOverride;
  };

  const onSetOverride = async (
    controlId: string,
    orgId: string,
    status: ControlStatus,
    notes?: string,
    implementationPercentage?: number,
  ) => {
    const existing = overrides.find(
      (o) => o.control_id === controlId && o.customer_organization_id === orgId,
    );
    try {
      const result = await setOverrideWorkflow.mutate({
        assessment_id: assessmentId,
        control_id: controlId,
        customer_organization_id: orgId,
        status,
        notes: notes ?? existing?.notes ?? null,
        implementation_percentage: implementationPercentage ??
          (status === "compliant" ? 100 : status === "partially_compliant" ? 50 : 0),
      });
      const row = flattenRow(result);
      setOverrides((prev) => {
        const without = prev.filter((o) => o.id !== row.id);
        return [...without, row];
      });
    } catch (e) {
      toast.error("Couldn't set exception: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const onClearOverride = async (overrideId: string) => {
    try {
      await clearOverrideWorkflow.mutate({ override_id: overrideId });
      setOverrides((prev) => prev.filter((o) => o.id !== overrideId));
    } catch (e) {
      toast.error("Couldn't remove exception: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const onUpdateOverrideNotes = async (overrideId: string, notes: string) => {
    try {
      await tables.update(TABLE_ASSESSMENT_CONTROL_OVERRIDES, overrideId, { notes });
      setOverrides((prev) =>
        prev.map((o) => (o.id === overrideId ? { ...o, notes } : o)),
      );
    } catch (e) {
      toast.error("Couldn't update notes: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const unlinkEvidence = async (evidenceId: string) => {
    try {
      await tables.update(TABLE_EVIDENCE, evidenceId, { control_id: null });
      refetchAssessment();
    } catch (e) {
      toast.error("Couldn't detach evidence: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const createEvidence = async (input: {
    name: string;
    url?: string;
    notes?: string;
    attachment?: UploadedFile;
    tags?: string[];
    controlId?: string;
  }): Promise<Evidence | null> => {
    try {
      const created = await tables.insert(TABLE_EVIDENCE, {
        name: input.name,
        notes_markdown: input.notes ?? null,
        urls_json: JSON.stringify(input.url ? [{ url: input.url }] : []),
        attachments_json: JSON.stringify(
          input.attachment
            ? [{
                path: input.attachment.path,
                name: input.attachment.name,
                size_bytes: input.attachment.sizeBytes,
                content_type: input.attachment.contentType,
              }]
            : [],
        ),
        provenance_json: JSON.stringify({ source: "assessment", assessment_id: assessmentId }),
        review_status: "approved",
        organization_id: assessmentOwnerOrgId(),
        ...assessmentScopePatch(),
        assessment_id: assessmentId,
        tags: input.tags ?? [],
        control_id: null });
      refetchAssessment();
      return unwrapRow<Evidence>(created);
    } catch (e) {
      toast.error("Couldn't add evidence: " + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  // ---- Inline edit: name ----
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const startEditName = () => {
    setNameDraft(assessment?.name ?? "");
    setEditingName(true);
  };
  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === assessment?.name) {
      setEditingName(false);
      return;
    }
    // Optimistic
    setAssessment((prev) => (prev ? { ...prev, name: trimmed } : prev));
    setEditingName(false);
    try {
      await tables.update(TABLE_ASSESSMENTS, assessmentId, { name: trimmed });
    } catch (e) {
      toast.error("Couldn't update name: " + (e instanceof Error ? e.message : String(e)));
      refetchAssessment();
    }
  };

  // ---- Assigned_to picker (inline) ----
  const setAssignedTo = async (userId: string | null) => {
    const prev = assessment?.assigned_to ?? null;
    if ((prev ?? null) === (userId ?? null)) return;
    setAssessment((p) => (p ? { ...p, assigned_to: userId } : p));
    try {
      await tables.update(TABLE_ASSESSMENTS, assessmentId, { assigned_to: userId });
    } catch (e) {
      toast.error("Couldn't update assignee: " + (e instanceof Error ? e.message : String(e)));
      setAssessment((p) => (p ? { ...p, assigned_to: prev } : p));
    }
  };

  // ---- Status transitions ----
  // Optimistic, no full refetch — local state is the source of truth for the header.
  const setAssessmentStatus = async (next: AssessmentStatus) => {
    if (!assessment) return;
    const prevStatus = assessment.status ?? "draft";
    if (prevStatus === next) return;
    const patch: Partial<Assessment> = { status: next };
    if (next === "in_progress" && !assessment.started_at) {
      patch.started_at = new Date().toISOString();
    }
    if (next === "completed" && !assessment.completed_at) {
      patch.completed_at = new Date().toISOString();
    }
    // Optimistic
    setAssessment((p) => (p ? { ...p, ...patch } : p));
    try {
      await tables.update(TABLE_ASSESSMENTS, assessmentId, patch);
    } catch (e) {
      toast.error("Couldn't change status: " + (e instanceof Error ? e.message : String(e)));
      // Roll back
      setAssessment((p) =>
        p
          ? {
              ...p,
              status: prevStatus,
              started_at: assessment.started_at,
              completed_at: assessment.completed_at }
          : p,
      );
    }
  };

  // ---- Cascade delete ----
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    const ok = await confirm({
      title: "Delete this assessment?",
      body:
        "Evidence rows linked to this assessment and all its per-control assessments will be permanently removed. The framework itself stays.",
      confirmLabel: "Delete assessment",
      destructive: true });
    if (!ok) return;
    setDeleting(true);
    try {
      for (const ev of evidence) {
        await tables.delete(TABLE_EVIDENCE, ev.id);
      }
      for (const ac of acRows) {
        await tables.delete(TABLE_ASSESSMENT_CONTROLS, ac.id);
      }
      await tables.delete(TABLE_ASSESSMENTS, assessmentId);
      navigate("/assessments");
    } catch (e) {
      toast.error("Couldn't delete: " + (e instanceof Error ? e.message : String(e)));
      setDeleting(false);
    }
  };

  // ---- Loading / error / missing ----
  if (!assessmentId) {
    return (
      <div>
        <PageHeader title="Assessment" />
        <EmptyState title="Missing assessment id" body="Open this page from the assessments list." />
      </div>
    );
  }

  const essentialDataLoading = assessmentLoading || Boolean(assessment && (
    acTable.loading || domainsTable.loading || controlsTable.loading
  ));

  if (essentialDataLoading) {
    return (
      <div className="cv-assessment-detail-loading">
        <LoadingSkeleton variant="page" rows={5} label="Loading assessment" />
      </div>
    );
  }

  if (assessmentError) {
    return (
      <div>
        <PageHeader title="Assessment" />
        <div className="cv-callout cv-callout--danger">
          <div className="cv-callout__label">Couldn't load assessment</div>
          <div className="cv-callout__body">{assessmentError}</div>
        </div>
      </div>
    );
  }

  if (!assessment) {
    return (
      <div>
        <PageHeader
          title="Assessment"
          actions={
            <Link to="/assessments" className="cv-btn cv-btn--secondary cv-btn--sm">
              <ArrowLeft size={13} /> Back
            </Link>
          }
        />
        <EmptyState title="Assessment not found" body="It may have been deleted." />
      </div>
    );
  }

  const evidenceByControl = new Map<string, Evidence[]>();
  evidence.forEach((ev) => {
    if (!ev.control_id) return;
    const arr = evidenceByControl.get(ev.control_id) ?? [];
    arr.push(ev);
    evidenceByControl.set(ev.control_id, arr);
  });

  const scopedToAssessment = (row: { organization_id?: string | null; applied_organizations?: string[] | null; excluded_organizations?: string[] | null }) => {
    const orgs = assessment.applied_organizations;
    if (orgs == null) return true;
    if (orgs.length === 0) return false;
    return orgs.some((orgId) => appliesToOrg(row, orgId));
  };

  const mappedAppliedByControl = new Map<string, LinkedAppliedControl[]>();
  controlMappings.forEach((mapping) => {
    const appliedControl = appliedControlById.get(mapping.applied_control_id);
    if (!appliedControl || !scopedToAssessment(appliedControl) || !scopedToAssessment(mapping)) return;
    const arr = mappedAppliedByControl.get(mapping.control_id) ?? [];
    arr.push({ appliedControl, mapping });
    mappedAppliedByControl.set(mapping.control_id, arr);
  });

  const linkedEvidenceByAssessmentControl = new Map<string, LinkedEvidenceRecord[]>();
  const linkedPoliciesByAssessmentControl = new Map<string, LinkedPolicyRecord[]>();
  const linkedExceptionsByAssessmentControl = new Map<string, LinkedExceptionRecord[]>();

  const addEvidenceRecord = (acId: string, row: LinkedEvidenceRecord) => {
    const arr = linkedEvidenceByAssessmentControl.get(acId) ?? [];
    if (!arr.some((existing) => existing.evidence.id === row.evidence.id && existing.link?.id === row.link?.id)) {
      arr.push(row);
    }
    linkedEvidenceByAssessmentControl.set(acId, arr);
  };
  const addPolicyRecord = (acId: string, row: LinkedPolicyRecord) => {
    const arr = linkedPoliciesByAssessmentControl.get(acId) ?? [];
    if (!arr.some((existing) => existing.policy.id === row.policy.id && existing.link.id === row.link.id)) {
      arr.push(row);
    }
    linkedPoliciesByAssessmentControl.set(acId, arr);
  };
  const addExceptionRecord = (acId: string, row: LinkedExceptionRecord) => {
    const arr = linkedExceptionsByAssessmentControl.get(acId) ?? [];
    if (!arr.some((existing) => existing.exception.id === row.exception.id && existing.link?.id === row.link?.id)) {
      arr.push(row);
    }
    linkedExceptionsByAssessmentControl.set(acId, arr);
  };

  acRows.forEach((ac) => {
    const mapped = mappedAppliedByControl.get(ac.control_id) ?? [];
    const mappedAppliedIds = new Set(mapped.map((row) => row.appliedControl.id));

    evidenceLinks.forEach((link) => {
      const ev = evidenceById.get(link.evidence_id);
      if (!ev || !scopedToAssessment(ev) || !scopedToAssessment(link)) return;
      if (link.target_type === "assessment_control" && link.target_id === ac.id) {
        addEvidenceRecord(ac.id, { evidence: ev, link });
      }
      if (link.target_type === "applied_control" && mappedAppliedIds.has(link.target_id)) {
        addEvidenceRecord(ac.id, {
          evidence: ev,
          link,
          inheritedFrom: appliedControlById.get(link.target_id),
        });
      }
    });

    policyLinks.forEach((link) => {
      const policy = policyById.get(link.policy_id);
      if (!policy || !scopedToAssessment(policy) || !scopedToAssessment(link)) return;
      if (link.target_type === "assessment_control" && link.target_id === ac.id) {
        addPolicyRecord(ac.id, { policy, link });
      }
      if (link.target_type === "applied_control" && mappedAppliedIds.has(link.target_id)) {
        addPolicyRecord(ac.id, {
          policy,
          link,
          inheritedFrom: appliedControlById.get(link.target_id),
        });
      }
    });

    exceptionLinks.forEach((link) => {
      const exception = exceptionById.get(link.exception_id);
      if (!exception || !scopedToAssessment(exception) || !scopedToAssessment(link)) return;
      if (link.target_type === "assessment_control" && link.target_id === ac.id) {
        addExceptionRecord(ac.id, { exception, link });
      }
      if (link.target_type === "applied_control" && mappedAppliedIds.has(link.target_id)) {
        addExceptionRecord(ac.id, {
          exception,
          link,
          inheritedFrom: appliedControlById.get(link.target_id),
        });
      }
      if (link.target_type === "control" && link.target_id === ac.control_id) {
        addExceptionRecord(ac.id, { exception, link });
      }
    });

    exceptions.forEach((exception) => {
      if (!scopedToAssessment(exception)) return;
      if (exception.control_id !== ac.control_id) return;
      addExceptionRecord(ac.id, { exception, legacy: true });
    });
  });

  const tabs: Array<{ value: TabKey; label: string }> = [
    { value: "overview", label: "Overview" },
    { value: "controls", label: `Controls (${stats.total})` },
    { value: "evidence", label: `Evidence (${evidence.length})` },
  ];

  const statusOptions: ThemedSelectOption[] = ASSESSMENT_STATUSES.map((s) => ({
    label: fmtStatus(s),
    value: s }));

  return (
    <div className="cv-assessment-detail">
      {/* Back nav */}
      <div>
        <Link
          to="/assessments"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          style={{ paddingLeft: 4 }}
        >
          <ArrowLeft size={13} /> Assessments
        </Link>
      </div>

      {/* Header strip */}
      <div className="cv-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap" }}
        >
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <div className="cv-page-header__crumb">{framework?.name ?? "Framework"}</div>
            {editingName ? (
              <input
                type="text"
                className="cv-field"
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}
              />
            ) : (
              <h1
                className="cv-page-header__title"
                onClick={canEdit ? startEditName : undefined}
                style={{ cursor: canEdit ? "text" : "inherit", display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                {assessment.name ?? "Untitled assessment"}
                {canEdit ? <Pencil size={14} style={{ color: "var(--cv-fg-3)" }} /> : null}
              </h1>
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 10,
                flexWrap: "wrap" }}
            >
              <StatusBadge kind="assessment" value={assessment.status} />
              <ScopeChip assessment={assessment} orgNameById={orgNameById} />
              <span className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
                Assigned: <span style={{ color: "var(--cv-fg-1)" }}>{userLabel(assessment.assigned_to)}</span>
              </span>
              {assessment.started_at ? (
                <span className="cv-small">Started {fmtDate(assessment.started_at)}</span>
              ) : null}
              {assessment.completed_at ? (
                <span className="cv-small">Completed {fmtDate(assessment.completed_at)}</span>
              ) : null}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <PdfExportButton workflow={WF_EXPORT_ASSESSMENT_PDF} params={{ assessment_id: assessment.id, organization_id: viewedOrganizationId || (scopeOrgIds(assessment)?.length === 1 ? scopeOrgIds(assessment)?.[0] : undefined) }} />
            {canEdit ? <>
            {assessment.status === "draft" || !assessment.status ? (
              <button
                className="cv-btn cv-btn--primary cv-btn--sm"
                onClick={() => setAssessmentStatus("in_progress")}
              >
                <Clock size={13} /> Start
              </button>
            ) : null}
            {assessment.status === "in_progress" ? (
              <button
                className="cv-btn cv-btn--primary cv-btn--sm"
                onClick={() => setAssessmentStatus("completed")}
              >
                <CheckCircle2 size={13} /> Mark complete
              </button>
            ) : null}
            {assessment.status === "completed" ? (
              <button
                className="cv-btn cv-btn--secondary cv-btn--sm"
                onClick={() => setAssessmentStatus("reviewed")}
              >
                <CheckCircle2 size={13} /> Mark reviewed
              </button>
            ) : null}
            <button
              className="cv-btn cv-btn--destructive cv-btn--sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="animate-spin" size={13} /> : <Trash2 size={13} />}
              Delete
            </button>
          </> : null}
          </div>
        </div>

        {/* Progress + side meta */}
        <div
          className="cv-assessment-summary-grid"
          style={{
            paddingTop: 16,
            borderTop: "1px solid var(--cv-border)" }}
        >
          <div className="cv-assessment-progress-summary">
            <ProgressRing
              value={localPct}
              size={96}
              strokeWidth={6}
              label={`${localPct}%`}
              sublabel="Progress"
              tone="auto"
            />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--cv-fg-2)",
                  marginBottom: 8 }}
              >
                {stats.compliant} of {stats.total} controls compliant
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className="cv-chip cv-chip--green">{stats.compliant} compliant</span>
                <span className="cv-chip cv-chip--gold">{stats.partial} partial</span>
                <span className="cv-chip cv-chip--red">{stats.nonc} non-compliant</span>
                <span className="cv-chip cv-chip--neutral">{stats.na} not assessed</span>
              </div>
            </div>
          </div>

          {/* Side meta: status + assigned_to pickers */}
          <div className="cv-assessment-summary-meta">
            <div>
              <div className="cv-section-label" style={{ marginBottom: 6 }}>
                Status
              </div>
              <ThemedSelect
                value={assessment.status ?? "draft"}
                onChange={(v) => setAssessmentStatus(v as AssessmentStatus)}
                options={statusOptions}
                ariaLabel="Assessment status"
                disabled={!canEdit}
              />
            </div>
            <div>
              <div className="cv-section-label" style={{ marginBottom: 6 }}>
                Assigned to
              </div>
              <UserPicker
                value={assessment.assigned_to ?? null}
                onChange={setAssignedTo}
                allowClear
                disabled={!canEdit}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--cv-border)" }}>
        {tabs.map((t) => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              style={{
                background: "transparent",
                border: 0,
                cursor: "pointer",
                padding: "10px 14px",
                fontSize: 13,
                fontWeight: 500,
                color: active ? "var(--cv-fg-1)" : "var(--cv-fg-3)",
                borderBottom: active ? "2px solid var(--cv-cb)" : "2px solid transparent",
                marginBottom: -1 }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab body */}
      {tab === "overview" ? (
        <OverviewTab
          stats={stats}
          domainBreakdown={domainBreakdown}
          recentControls={mergedAcRows
            .filter((ac) => !!ac.assessed_at)
            .slice()
            .sort((a, b) => {
              const ta = a.assessed_at ? new Date(a.assessed_at).getTime() : 0;
              const tb = b.assessed_at ? new Date(b.assessed_at).getTime() : 0;
              return tb - ta;
            })
            .slice(0, 5)}
          controlById={controlById}
        />
      ) : null}

      {tab === "controls" ? (
        <ControlsTab
          assessmentId={assessmentId}
          onOpenFlashcards={() => setFlashcardOpen(true)}
          domains={domains}
          orphans={grouped.orphans}
          byDomain={grouped.byDomain}
          mergedAcRows={mergedAcRows}
          orderedAcRows={orderedAcRows.map((ac) => mergedById.get(ac.id) ?? ac)}
          controlById={controlById}
          domainById={domainById}
          evidenceByControl={evidenceByControl}
          mappedAppliedByControl={mappedAppliedByControl}
          linkedEvidenceByAssessmentControl={linkedEvidenceByAssessmentControl}
          linkedPoliciesByAssessmentControl={linkedPoliciesByAssessmentControl}
          linkedExceptionsByAssessmentControl={linkedExceptionsByAssessmentControl}
          expandedDomains={expandedDomains}
          expandedRows={expandedRows}
          toggleDomain={toggleDomain}
          toggleRow={toggleRow}
          expandAll={expandAll}
          collapseAll={collapseAll}
          onStatusChange={(ac, status) => callUpdateAc(ac, { status })}
          onImplementationChange={(ac, pct) =>
            callUpdateAc(ac, { implementation_percentage: pct })
          }
          onNotesChange={(ac, notes) => callUpdateAc(ac, { notes })}
          onCreateEvidence={(ac, file) => openEvidencePicker(ac, file)}
          onAttachEvidence={(ac, evidenceId) => linkEvidenceToAssessmentControl(evidenceId, ac)}
          onDetachEvidence={(_ac, linkId) => detachAssessmentControlLink(TABLE_EVIDENCE_LINKS, linkId, "Evidence")}
          onAttachPolicy={(ac, policyId) => linkPolicyToAssessmentControl(policyId, ac)}
          onAttachException={(ac, exceptionId) => linkExceptionToAssessmentControl(exceptionId, ac)}
          onDetachPolicy={(_ac, linkId) => detachAssessmentControlLink(TABLE_POLICY_LINKS, linkId, "Policy")}
          onDetachException={(_ac, linkId) => detachAssessmentControlLink(TABLE_EXCEPTION_LINKS, linkId, "Exception")}
          onAttachAppliedControl={(ac, appliedControlId) => mapAppliedControl(ac.control_id, appliedControlId)}
          onDetachAppliedControl={(_ac, mappingId) => unmapAppliedControl(mappingId)}
          onUnlinkEvidence={(evId) => unlinkEvidence(evId)}
          availableAppliedControls={appliedControls.filter(scopedToAssessment)}
          availableEvidence={evidence.filter(scopedToAssessment)}
          availablePolicies={policies.filter(scopedToAssessment)}
          availableExceptions={exceptions.filter(scopedToAssessment)}
          overallPct={localPct}
          assessedCount={stats.assessed}
          totalCount={stats.total}
          appliedOrganizations={assessment.applied_organizations}
          excludedOrganizations={assessment.excluded_organizations ?? []}
          orgNameById={orgNameById}
          overridesByControl={overridesByControl}
          onSetOverride={onSetOverride}
          onClearOverride={onClearOverride}
          onUpdateOverrideNotes={onUpdateOverrideNotes}
        />
      ) : null}

      {tab === "evidence" ? (
        <EvidenceTab
          evidence={evidence}
          controlById={controlById}
          loading={evidenceTable.loading}
          organizationId={assessmentOwnerOrgId()}
          onAdd={async (input) => {
            await createEvidence(input);
          }}
          onDelete={async (id) => {
            const ok = await confirm({
              title: "Delete this evidence?",
              destructive: true,
              confirmLabel: "Delete" });
            if (!ok) return;
            try {
              await tables.delete(TABLE_EVIDENCE, id);
              refetchAssessment();
            } catch (e) {
              toast.error(
                "Couldn't delete: " + (e instanceof Error ? e.message : String(e)),
              );
            }
          }}
        />
      ) : null}

      {flashcardOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "var(--cv-bg-1)",
            display: "flex",
            flexDirection: "column" }}
        >
          <FlashcardView
            assessmentId={assessmentId}
            assessmentName={assessment.name ?? "Assessment"}
            acRows={orderedAcRows.map((ac) => mergedById.get(ac.id) ?? ac)}
            controlById={controlById}
            domainById={domainById}
            evidenceByControl={evidenceByControl}
            onStatusChange={(ac, status) => callUpdateAc(ac, { status })}
            onImplementationChange={(ac, pct) =>
              callUpdateAc(ac, { implementation_percentage: pct })
            }
            onNotesChange={(ac, notes) => callUpdateAc(ac, { notes })}
            onAttachEvidence={(ac) => openEvidencePicker(ac)}
            onUnlinkEvidence={(evId) => unlinkEvidence(evId)}
            onClose={() => setFlashcardOpen(false)}
          />
        </div>
      ) : null}

      {/* Evidence picker dialog */}
      <EvidencePickerDialog
        open={evPickerOpen}
        onClose={() => {
          setEvPickerOpen(false);
          setEvPickerAc(null);
          setEvPickerFile(null);
        }}
        organizationId={assessmentOwnerOrgId()}
        initialFile={evPickerFile}
        tagSuggestions={Array.from(new Set(evidence.flatMap((row) => row.tags ?? [])))}
        onCreateNew={async (input) => {
          if (!evPickerAc) return;
          const created = await createEvidence(input);
          if (created?.id) {
            await linkEvidenceToAssessmentControl(created.id, evPickerAc);
          }
        }}
      />
    </div>
  );
}

// ----- Overview tab -----
interface OverviewTabProps {
  stats: { total: number; compliant: number; partial: number; nonc: number; na: number; assessed: number };
  domainBreakdown: Array<{
    domainId: string;
    name: string;
    total: number;
    compliant: number;
    partial: number;
    nonc: number;
  }>;
  recentControls: AssessmentControl[];
  controlById: Map<string, Control>;
}

function OverviewTab({ stats, domainBreakdown, recentControls, controlById }: OverviewTabProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <SectionHeader label="Per-domain compliance" />
        <div className="cv-card cv-card--pad-sm">
          {domainBreakdown.length === 0 ? (
            <EmptyState title="No domains yet" body="Add domains to this framework to see a breakdown." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 8 }}>
              {domainBreakdown.map((d) => {
                const pct = d.total > 0 ? Math.round((d.compliant / d.total) * 100) : 0;
                return (
                  <div key={d.domainId}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 4 }}
                    >
                      <span style={{ fontSize: 13, color: "var(--cv-fg-1)", fontWeight: 500 }}>
                        {d.name}
                      </span>
                      <span className="cv-small">
                        {d.compliant}/{d.total} compliant · {pct}%
                      </span>
                    </div>
                    <div className="cv-meter">
                      <div
                        className={
                          "cv-meter__fill " +
                          (pct >= 80
                            ? "cv-meter__fill--good"
                            : pct >= 40
                            ? "cv-meter__fill--teal"
                            : "cv-meter__fill--warn")
                        }
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div>
        <SectionHeader label="Recent activity" />
        <div className="cv-card cv-card--pad-sm">
          {recentControls.length === 0 ? (
            <EmptyState
              title="No controls assessed yet"
              body="Open the Controls tab and mark your first control."
            />
          ) : (
            <table className="cv-data-table" style={{ borderRadius: 0, border: 0 }}>
              <thead>
                <tr>
                  <th>Control</th>
                  <th style={{ width: 140 }}>Status</th>
                  <th style={{ width: 120 }}>Assessed</th>
                </tr>
              </thead>
              <tbody>
                {recentControls.map((ac) => {
                  const c = controlById.get(ac.control_id);
                  return (
                    <tr key={ac.id}>
                      <td>
                        <span className="cv-mono" style={{ color: "var(--cv-fg-3)", marginRight: 8 }}>
                          {c?.control_id ?? "—"}
                        </span>
                        {c?.title ?? "Control"}
                      </td>
                      <td>
                        <StatusBadge kind="control" value={ac.status} />
                      </td>
                      <td className="cv-small">
                        {ac.assessed_at
                          ? new Date(ac.assessed_at).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="cv-callout cv-callout--note">
        <div className="cv-callout__label">Snapshot</div>
        <div className="cv-callout__body">
          {stats.assessed} of {stats.total} controls assessed. {stats.compliant} compliant,{" "}
          {stats.partial} partial, {stats.nonc} non-compliant.
        </div>
      </div>
    </div>
  );
}

// ----- Controls tab -----
interface ControlsTabProps {
  assessmentId: string;
  onOpenFlashcards: () => void;
  domains: Domain[];
  orphans: AssessmentControl[];
  byDomain: Map<string, AssessmentControl[]>;
  mergedAcRows: AssessmentControl[];
  orderedAcRows: AssessmentControl[];
  controlById: Map<string, Control>;
  domainById: Map<string, Domain>;
  evidenceByControl: Map<string, Evidence[]>;
  mappedAppliedByControl: Map<string, LinkedAppliedControl[]>;
  linkedEvidenceByAssessmentControl: Map<string, LinkedEvidenceRecord[]>;
  linkedPoliciesByAssessmentControl: Map<string, LinkedPolicyRecord[]>;
  linkedExceptionsByAssessmentControl: Map<string, LinkedExceptionRecord[]>;
  expandedDomains: Set<string>;
  expandedRows: Set<string>;
  toggleDomain: (id: string) => void;
  toggleRow: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  onStatusChange: (ac: AssessmentControl, status: ControlStatus) => void;
  onImplementationChange: (ac: AssessmentControl, pct: number) => void;
  onNotesChange: (ac: AssessmentControl, notes: string) => void;
  onCreateEvidence: (ac: AssessmentControl, file?: File) => void;
  onAttachEvidence: (ac: AssessmentControl, evidenceId: string) => Promise<void>;
  onDetachEvidence: (ac: AssessmentControl, linkId: string) => Promise<void>;
  onAttachPolicy: (ac: AssessmentControl, policyId: string) => Promise<void>;
  onAttachException: (ac: AssessmentControl, exceptionId: string) => Promise<void>;
  onDetachPolicy: (ac: AssessmentControl, linkId: string) => Promise<void>;
  onDetachException: (ac: AssessmentControl, linkId: string) => Promise<void>;
  onAttachAppliedControl: (ac: AssessmentControl, appliedControlId: string) => Promise<void>;
  onDetachAppliedControl: (ac: AssessmentControl, mappingId: string) => Promise<void>;
  onUnlinkEvidence: (evidenceId: string) => void;
  availableAppliedControls: AppliedControl[];
  availableEvidence: Evidence[];
  availablePolicies: Policy[];
  availableExceptions: Exception[];
  overallPct: number;
  assessedCount: number;
  totalCount: number;
  // Per-org override plumbing.
  appliedOrganizations: string[] | null | undefined;
  excludedOrganizations: string[];
  orgNameById: Map<string, string>;
  overridesByControl: Map<string, AssessmentControlOverride[]>;
  onSetOverride: (controlId: string, orgId: string, status: ControlStatus, notes?: string, implementationPercentage?: number) => Promise<void>;
  onClearOverride: (overrideId: string) => Promise<void>;
  onUpdateOverrideNotes: (overrideId: string, notes: string) => Promise<void>;
}

function ControlsTab(props: ControlsTabProps) {
  const {
    assessmentId,
    onOpenFlashcards,
    domains,
    orphans,
    byDomain,
    mergedAcRows,
    orderedAcRows,
    controlById,
    domainById,
    evidenceByControl,
    mappedAppliedByControl,
    linkedEvidenceByAssessmentControl,
    linkedPoliciesByAssessmentControl,
    linkedExceptionsByAssessmentControl,
    expandedDomains,
    expandedRows,
    toggleDomain,
    toggleRow,
    expandAll,
    collapseAll,
    onStatusChange,
    onImplementationChange,
    onNotesChange,
    onCreateEvidence,
    onAttachEvidence,
    onDetachEvidence,
    onAttachPolicy,
    onAttachException,
    onDetachPolicy,
    onDetachException,
    onAttachAppliedControl,
    onDetachAppliedControl,
    onUnlinkEvidence,
    availableAppliedControls,
    availableEvidence,
    availablePolicies,
    availableExceptions,
    overallPct,
    assessedCount,
    totalCount,
    appliedOrganizations,
    excludedOrganizations,
    orgNameById,
    overridesByControl,
    onSetOverride,
    onClearOverride,
    onUpdateOverrideNotes } = props;

  const mergedById = useMemo(() => {
    const m = new Map<string, AssessmentControl>();
    mergedAcRows.forEach((ac) => m.set(ac.id, ac));
    return m;
  }, [mergedAcRows]);

  const [customerLens, setCustomerLens] = useState("");
  const customerOptions = useMemo(() => {
    const eligible = (appliedOrganizations == null
      ? Array.from(orgNameById.keys())
      : appliedOrganizations).filter((id) => !excludedOrganizations.includes(id));
    return [
      { value: "", label: "All customers · provider baseline" },
      ...eligible
        .map((id) => ({ value: id, label: orgNameById.get(id) ?? id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [appliedOrganizations, excludedOrganizations, orgNameById]);

  const lensRows = useMemo(() => mergedAcRows.map((row) => {
    if (!customerLens) return row;
    const override = (overridesByControl.get(row.control_id) ?? [])
      .find((candidate) => candidate.customer_organization_id === customerLens);
    return override ? { ...row, ...override, id: row.id } : row;
  }), [customerLens, mergedAcRows, overridesByControl]);
  const lensStats = useMemo(() => {
    const assessed = lensRows.filter((row) => row.status && row.status !== "not_assessed").length;
    const compliant = lensRows.filter((row) => row.status === "compliant").length;
    return {
      assessed,
      percentage: lensRows.length ? Math.round((compliant / lensRows.length) * 100) : 0,
    };
  }, [lensRows]);

  const renderRow = (ac: AssessmentControl) => {
    const current = mergedById.get(ac.id) ?? ac;
    const override = customerLens
      ? (overridesByControl.get(current.control_id) ?? [])
          .find((candidate) => candidate.customer_organization_id === customerLens)
      : undefined;
    const effective = override ? { ...current, ...override, id: current.id } : current;
    const ctrl = controlById.get(current.control_id);
    const evList = evidenceByControl.get(current.control_id) ?? [];
    const ovList = overridesByControl.get(current.control_id) ?? [];
    return (
      <ControlRow
        key={current.id}
        ac={effective}
        control={ctrl}
        evidence={evList}
        mappedAppliedControls={mappedAppliedByControl.get(current.control_id) ?? []}
        linkedEvidence={linkedEvidenceByAssessmentControl.get(current.id) ?? []}
        linkedPolicies={linkedPoliciesByAssessmentControl.get(current.id) ?? []}
        linkedExceptions={linkedExceptionsByAssessmentControl.get(current.id) ?? []}
        availableEvidence={availableEvidence}
        availablePolicies={availablePolicies}
        availableExceptions={availableExceptions}
        expanded={expandedRows.has(current.id)}
        onToggle={() => toggleRow(current.id)}
        onStatusChange={(s) => customerLens
          ? onSetOverride(current.control_id, customerLens, s, override?.notes ?? undefined)
          : onStatusChange(current, s)}
        onImplementationChange={(pct) => customerLens
          ? onSetOverride(current.control_id, customerLens, effective.status ?? "not_assessed", effective.notes ?? undefined, pct)
          : onImplementationChange(current, pct)}
        onNotesChange={(n) => customerLens
          ? (override
              ? onUpdateOverrideNotes(override.id, n)
              : onSetOverride(current.control_id, customerLens, current.status ?? "not_assessed", n))
          : onNotesChange(current, n)}
        onCreateEvidence={(file) => onCreateEvidence(current, file)}
        onAttachExistingEvidence={(evidenceId) => onAttachEvidence(current, evidenceId)}
        onDetachEvidence={(linkId) => onDetachEvidence(current, linkId)}
        onAttachPolicy={(policyId) => onAttachPolicy(current, policyId)}
        onAttachException={(exceptionId) => onAttachException(current, exceptionId)}
        onDetachPolicy={(linkId) => onDetachPolicy(current, linkId)}
        onDetachException={(linkId) => onDetachException(current, linkId)}
        onAttachAppliedControl={(appliedControlId) => onAttachAppliedControl(current, appliedControlId)}
        onDetachAppliedControl={(mappingId) => onDetachAppliedControl(current, mappingId)}
        onUnlinkEvidence={(id) => onUnlinkEvidence(id)}
        availableAppliedControls={availableAppliedControls}
        appliedOrganizations={customerLens ? [] : appliedOrganizations}
        orgNameById={orgNameById}
        overrides={ovList}
        onSetOverride={(orgId, status, notes) =>
          onSetOverride(current.control_id, orgId, status, notes)
        }
        onClearOverride={onClearOverride}
        onUpdateOverrideNotes={onUpdateOverrideNotes}
        effectiveSourceLabel={customerLens ? (override ? "Customer override" : "Inherited default") : undefined}
      />
    );
  };

  if (totalCount === 0) {
    return (
      <EmptyState
        title="No controls in this framework yet"
        body="Add controls in the framework builder, then come back to assess them."
      />
    );
  }

  return (
    <div className="cv-assessment-controls">
      <div className="cv-assessment-controls__toolbar">
        <div className="cv-assessment-controls__lens">
          <label className="cv-section-label" htmlFor="assessment-customer-lens">
            View controls for
          </label>
          <ThemedSelect
            id="assessment-customer-lens"
            value={customerLens}
            options={customerOptions}
            onChange={setCustomerLens}
            ariaLabel="Assessment customer lens"
          />
          <span className="cv-small">
            {customerLens ? "Showing this customer's effective overrides." : "Showing the baseline inherited by customers without exceptions."}
          </span>
        </div>
        <div className="cv-assessment-controls__progress" aria-live="polite">
          <strong>{customerLens ? lensStats.assessed : assessedCount} of {totalCount}</strong>
          <span>assessed</span>
          <span aria-hidden="true">·</span>
          <strong>{customerLens ? lensStats.percentage : overallPct}%</strong>
          <span>compliant</span>
        </div>
        <div className="cv-assessment-controls__actions">
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            onClick={onOpenFlashcards}
          >
            <Maximize2 size={13} /> Flashcards
          </button>
          <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm" onClick={expandAll}>
            Expand all
          </button>
          <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm" onClick={collapseAll}>
            Collapse all
          </button>
        </div>
      </div>

      <div className="cv-assessment-controls__domains">
          {domains.map((d) => {
            const rows = byDomain.get(d.id) ?? [];
            if (rows.length === 0) return null;
            const open = expandedDomains.has(d.id);
            const compliant = rows.filter((r) => {
              const cur = mergedById.get(r.id) ?? r;
              return cur.status === "compliant";
            }).length;
            return (
              <div key={d.id} className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
                <button
                  type="button"
                  onClick={() => toggleDomain(d.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "14px 18px",
                    background: "var(--cv-bg-3)",
                    border: 0,
                    borderBottom: open ? "1px solid var(--cv-border)" : "0",
                    width: "100%",
                    textAlign: "left",
                    cursor: "pointer",
                    color: "var(--cv-fg-1)" }}
                >
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{d.name ?? "Domain"}</div>
                    {d.description ? (
                      <div className="cv-small" style={{ marginTop: 2 }}>
                        {d.description}
                      </div>
                    ) : null}
                  </div>
                  <span className="cv-small">
                    {compliant}/{rows.length} compliant
                  </span>
                </button>
                {open ? <div>{rows.map(renderRow)}</div> : null}
              </div>
            );
          })}

          {orphans.length > 0 ? (
            <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
              <div
                style={{
                  padding: "14px 18px",
                  background: "var(--cv-bg-3)",
                  borderBottom: "1px solid var(--cv-border)",
                  fontSize: 14,
                  fontWeight: 600 }}
              >
                Ungrouped controls ({orphans.length})
              </div>
              <div>{orphans.map(renderRow)}</div>
            </div>
          ) : null}
      </div>
    </div>
  );
}

// ----- Evidence tab -----
interface EvidenceTabProps {
  evidence: Evidence[];
  controlById: Map<string, Control>;
  loading: boolean;
  organizationId: string | null;
  onAdd: (input: {
    name: string;
    url?: string;
    notes?: string;
    attachment?: UploadedFile;
    tags?: string[];
  }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function firstEvidenceUrl(row: Evidence): string | null {
  if (row.url) return row.url;
  try {
    const parsed = JSON.parse(row.urls_json ?? "[]");
    return Array.isArray(parsed) && typeof parsed[0]?.url === "string" ? parsed[0].url : null;
  } catch {
    return null;
  }
}

function hasAttachment(row: Evidence): boolean {
  if (row.file_path) return true;
  try {
    const parsed = JSON.parse(row.attachments_json ?? "[]");
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function EvidenceTab({
  evidence,
  controlById,
  loading,
  organizationId,
  onAdd,
  onDelete,
}: EvidenceTabProps) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center" }}
      >
        <SectionHeader label={`Evidence (${evidence.length})`} />
        <button
          type="button"
          className="cv-btn cv-btn--primary cv-btn--sm"
          onClick={() => setOpen(true)}
        >
          <Paperclip size={14} aria-hidden="true" />
          New evidence
        </button>
      </div>

      {loading ? (
        <div className="cv-card" style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <Loader2 className="animate-spin" />
        </div>
      ) : evidence.length === 0 ? (
        <EmptyState
          title="No evidence yet"
          body="Attach evidence to controls in the Controls tab, or add it directly here."
        />
      ) : (
        <table className="cv-data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Control</th>
              <th>Content</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((ev) => {
              const ctrl = ev.control_id ? controlById.get(ev.control_id) : null;
              const url = firstEvidenceUrl(ev);
              return (
                <tr key={ev.id}>
                  <td style={{ fontWeight: 500 }}>
                    <Link to={`/evidence/${ev.id}`} className="cv-link">{ev.name}</Link>
                  </td>
                  <td className="cv-small">
                    {ctrl ? `${ctrl.control_id} — ${ctrl.title}` : "Unlinked"}
                  </td>
                  <td className="cv-small" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="cv-link">
                        {url}
                      </a>
                    ) : ev.notes_markdown || ev.notes ? (
                      ev.notes_markdown || ev.notes
                    ) : hasAttachment(ev) ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Paperclip size={12} aria-hidden="true" /> Attachment
                      </span>
                    ) : "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="cv-btn cv-btn--ghost cv-btn--sm"
                      onClick={() => onDelete(ev.id)}
                      aria-label="Delete evidence"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <EvidencePickerDialog
        open={open}
        onClose={() => setOpen(false)}
        organizationId={organizationId}
        tagSuggestions={Array.from(new Set(evidence.flatMap((row) => row.tags ?? [])))}
        onCreateNew={onAdd}
      />
    </div>
  );
}

// ============================================================================
// ScopeChip — shows "All orgs (perpetual)" / single-org name / "N orgs"
// and opens an inline editor to change applied_organizations.
// ============================================================================
function ScopeChip({
  assessment,
  orgNameById }: {
  assessment: Assessment;
  orgNameById: Map<string, string>;
}) {
  const { canEdit } = useGrcPermissions();
  const [editing, setEditing] = useState(false);
  const applied = assessment.applied_organizations;

  let label: React.ReactNode;
  if (applied == null) {
    label = "All orgs (perpetual)";
  } else if (applied.length === 0) {
    label = <span style={{ color: "var(--cv-fg-3)" }}>No orgs assigned</span>;
  } else if (applied.length === 1) {
    label = orgNameById.get(applied[0]) ?? "Unknown org";
  } else {
    label = `${applied.length} organizations`;
  }

  return (
    <>
      {canEdit ? <button
        type="button"
        className="cv-chip cv-chip--neutral"
        onClick={() => setEditing(true)}
        style={{
          background: "transparent",
          border: "1px dashed var(--cv-border)",
          cursor: "pointer",
          gap: 6,
          display: "inline-flex",
          alignItems: "center" }}
        title="Edit applied organizations"
      >
        Applied to: <strong>{label}</strong>
        <Pencil size={11} style={{ color: "var(--cv-fg-3)" }} />
      </button> : <span className="cv-chip cv-chip--neutral">Applied to: <strong>{label}</strong></span>}
      {editing ? (
        <ScopeEditor
          assessment={assessment}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function ScopeEditor({
  assessment,
  onClose }: {
  assessment: Assessment;
  onClose: () => void;
}) {
  const tables = useGovernedTables();
  const [organizationScope, setOrganizationScope] = useState<string[] | null>(
    assessment.applied_organizations ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (organizationScope?.length === 0) {
      setErr("Pick at least one organization, or switch to All.");
      return;
    }
    setSaving(true);
    try {
      await tables.update(TABLE_ASSESSMENTS, assessment.id, {
        applied_organizations: organizationScope,
        excluded_organizations: [],
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <BifrostDialogFrame
      onDismiss={onClose}
      dismissDisabled={saving}
      labelledBy="assessment-organizations-title"
      style={{ width: "min(620px, calc(100vw - 32px))" }}
    >
        <div className="cv-dialog__header">
          <h2 id="assessment-organizations-title" className="cv-dialog__title">Applied organizations</h2>
          <div className="cv-small" style={{ marginTop: 4, color: "var(--cv-fg-3)" }}>
            Controls in this assessment apply to every organization listed below.
            Per-org exceptions still happen inside individual controls.
          </div>
        </div>
        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <OrgScopeField
            id="assessment-organization-scope"
            value={organizationScope}
            onChange={setOrganizationScope}
            disabled={saving}
          />
          {err ? (
            <div className="cv-callout cv-callout--danger">
              <div className="cv-callout__body">{err}</div>
            </div>
          ) : null}
        </div>
        <div className="cv-dialog__footer">
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            disabled={saving}
            onClick={submit}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}
