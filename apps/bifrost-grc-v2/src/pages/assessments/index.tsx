import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";
import { BfDataTable, type BfDataColumn } from "@/components/bifrost/BfDataTable";

import { Loader2, Plus, Search, Globe, Users } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import StatusBadge from "../../components/shared/StatusBadge";
import ProgressRing from "../../components/shared/ProgressRing";
import CreateAssessmentDialog from "../../components/assessment-filler/CreateAssessmentDialog";
import {
  TABLE_ASSESSMENTS,
  TABLE_ASSESSMENT_CONTROLS,
  TABLE_CONTROLS,
  TABLE_FRAMEWORKS } from "../../lib/grc-tables";
import { useUsersList, useOrgNamesMap, type UserEntry } from "../../lib/directory";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";
import { useOrganizationView } from "../../lib/organization-view";
import { appliesToOrg, rowOrganizationIdForScope } from "../../lib/scope";
import type { Assessment, AssessmentStatus, Control, ControlStatus, Framework } from "../../lib/types";

type FilterValue = "all" | AssessmentStatus;

const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "reviewed", label: "Reviewed" },
];

function fmtRelative(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso).getTime();
    if (Number.isNaN(d)) return "—";
    const diffMs = Date.now() - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

export default function AssessmentsListPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterValue>("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const orgNameById = useOrgNamesMap();
  const currentUser = useCurrentUser();
  const { canEdit } = useGrcPermissions();
  const { organizationId } = useOrganizationView();

  // useTable always returns { rows, total, loading, error }.
  const assessmentsTable = useTable<Assessment>(TABLE_ASSESSMENTS, {
    pageSize: 1000,
    order_by: "updated_at",
    order_dir: "desc" });
  const assessments: Assessment[] = useMemo(
    () => (assessmentsTable.rows ?? []).filter((row) => organizationId ? appliesToOrg(row, organizationId) : true),
    [assessmentsTable.rows, organizationId],
  );

  const frameworksTable = useTable<Framework>(TABLE_FRAMEWORKS, {
    pageSize: 200,
    order_by: "name",
    order_dir: "asc" });
  const frameworks: Framework[] = frameworksTable.rows ?? [];
  const activeFrameworks = useMemo(
    () => frameworks.filter((f) => f.is_active !== false),
    [frameworks],
  );

  const frameworkNameById = useMemo(() => {
    const m = new Map<string, string>();
    frameworks.forEach((f) => m.set(f.id, f.name ?? "Framework"));
    return m;
  }, [frameworks]);

  // Resolve assigned_to user IDs from the platform-org mirror table.
  const { users } = useUsersList();
  const userById = useMemo(() => {
    const m = new Map<string, UserEntry>();
    users.forEach((u) => u.id && m.set(u.id, u));
    return m;
  }, [users]);

  const userLabel = (uid: string | null | undefined): string => {
    if (!uid) return "";
    const u = userById.get(uid);
    if (!u) return "Unknown user";
    const name = u.name || u.email || "Unknown user";
    const email = u.email && u.email !== name ? u.email : "";
    return email ? `${name} (${email})` : name;
  };

  const [creating, setCreating] = useState(false);

  const counts = useMemo(() => {
    const c: Record<FilterValue, number> = {
      all: assessments.length,
      draft: 0,
      in_progress: 0,
      completed: 0,
      reviewed: 0 };
    assessments.forEach((a) => {
      const s = (a.status ?? "draft") as AssessmentStatus;
      if (s in c) c[s] += 1;
    });
    return c;
  }, [assessments]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assessments.filter((a) => {
      if (filter !== "all" && (a.status ?? "draft") !== filter) return false;
      if (!q) return true;
      const name = (a.name ?? "").toLowerCase();
      const fw = (frameworkNameById.get(a.framework_id) ?? "").toLowerCase();
      const assignee = userLabel(a.assigned_to).toLowerCase();
      return name.includes(q) || fw.includes(q) || assignee.includes(q);
    });
  }, [assessments, filter, search, frameworkNameById, userById]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async (input: {
    framework_id: string;
    name: string;
    applied_organizations: string[] | null;
    assigned_to?: string;
  }) => {
    setCreating(true);
    try {
      if (!currentUser.organizationId) throw new Error("Your provider organization could not be resolved");
      if (input.applied_organizations && input.applied_organizations.length !== 1) {
        throw new Error("Assessments must be global or scoped to exactly one organization");
      }
      const rowOrganizationId = rowOrganizationIdForScope(input.applied_organizations, currentUser.organizationId);
      // organization_id is the provider owner. Applicability is independent.
      const assessment = await tables.insert(TABLE_ASSESSMENTS, {
        organization_id: rowOrganizationId,
        framework_id: input.framework_id,
        name: input.name,
        status: "draft",
        progress_percentage: 0,
        applied_organizations: input.applied_organizations,
        excluded_organizations: [],
        assigned_to: input.assigned_to ?? null });
      const newId = (assessment as { id: string })?.id;
      if (!newId) throw new Error("Assessment created but no id returned");

      // 2) Seed assessment-controls — one per active control in the framework.
      //    All seed at not_assessed; users fill in defaults and per-org
      //    exceptions inside the assessment.
      const controlsResp = (await tables.query(TABLE_CONTROLS, {
        where: { framework_id: input.framework_id, is_active: true },
        order_by: "sort_order",
        order_dir: "asc",
        limit: 1000 })) as Control[] | { rows?: Control[]; documents?: Control[] };
      const controls: Control[] = Array.isArray(controlsResp)
        ? controlsResp
        : controlsResp.rows ?? controlsResp.documents ?? [];

      if (controls.length > 0) {
        // JS SDK batch insert wants [{data: {...}}, ...] (not raw rows).
        const seedDocs = controls.map((c) => ({
          data: {
            organization_id: rowOrganizationId,
            assessment_id: newId,
            control_id: c.id,
            status: "not_assessed" as ControlStatus,
            implementation_percentage: 0,
            notes: null,
            assessed_by: null,
            assessed_at: null } }));
        await tables.insert(TABLE_ASSESSMENT_CONTROLS, seedDocs);
      }
      setCreateOpen(false);
      navigate(`/assessments/${newId}`);
    } catch (e) {
      toast.error("Create failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  };

  const isLoading = assessmentsTable.loading;
  const error = assessmentsTable.error;
  const columns = useMemo<BfDataColumn<Assessment>[]>(() => [
    {
      id: "progress",
      header: "Progress",
      width: "76px",
      align: "center",
      sortValue: (row) => row.progress_percentage ?? 0,
      sortable: true,
      cell: (row) => {
        const pct = Math.round(row.progress_percentage ?? 0);
        return (
          <ProgressRing
            value={pct}
            size={44}
            strokeWidth={6}
            label={`${pct}%`}
            tone="auto"
            ariaLabel={`${row.name ?? "Assessment"} progress`}
          />
        );
      },
    },
    {
      id: "assessment",
      header: "Assessment",
      sortValue: (row) => row.name,
      sortable: true,
      cell: (row) => (
        <Link className="cv-table-primary-link" to={`/assessments/${row.id}`}>
          {row.name ?? "Untitled assessment"}
        </Link>
      ),
    },
    {
      id: "framework",
      header: "Framework",
      width: "160px",
      className: "cv-assessments-secondary-column",
      sortValue: (row) => frameworkNameById.get(row.framework_id) ?? "",
      sortable: true,
      cell: (row) => frameworkNameById.get(row.framework_id) ?? "Framework",
    },
    {
      id: "organization",
      header: "Organization",
      width: "190px",
      cell: (row) => <ScopeChip applied={row.applied_organizations} orgNameById={orgNameById} />,
    },
    {
      id: "owner",
      header: "Owner",
      width: "160px",
      className: "cv-assessments-secondary-column",
      sortValue: (row) => userLabel(row.assigned_to),
      sortable: true,
      cell: (row) => userLabel(row.assigned_to) || "Unassigned",
    },
    {
      id: "updated",
      header: "Updated",
      width: "104px",
      className: "cv-assessments-updated-column",
      sortValue: (row) => row.updated_at ?? "",
      sortable: true,
      cell: (row) => fmtRelative(row.updated_at),
    },
    {
      id: "status",
      header: "Status",
      width: "126px",
      sortValue: (row) => row.status ?? "draft",
      sortable: true,
      cell: (row) => <StatusBadge kind="assessment" value={row.status} />,
    },
  ], [frameworkNameById, orgNameById, userById]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, minHeight: 0 }}>
      <PageHeader
        title="Assessments"
        subtitle="Walk a framework end to end — mark control compliance, capture notes, attach evidence."
        actions={canEdit ? (
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--md"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            New assessment
          </button>
        ) : undefined}
      />

      {/* Filter chips + search */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap" }}
      >
        <div className="cv-segmented cv-assessment-filter-tabs">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                className={
                  "cv-segmented__btn " + (active ? "cv-segmented__btn--active" : "")
                }
                onClick={() => setFilter(f.value)}
              >
                {f.label}
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 11,
                    opacity: 0.7 }}
                >
                  {counts[f.value]}
                </span>
              </button>
            );
          })}
        </div>
        <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 360 }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--cv-fg-3)" }}
          />
          <input
            aria-label="Search assessments"
            type="text"
            className="cv-field"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, framework, assignee…"
            style={{ paddingLeft: 32 }}
          />
        </div>
      </div>

      <BfDataTable
        className="cv-assessments-bf-table"
        rows={filtered}
        columns={columns}
        getRowId={(row) => row.id}
        ariaLabel="Assessments"
        loading={isLoading}
        loadingRowCount={6}
        error={error ? { title: "Couldn't load assessments", description: String(error) } : undefined}
        emptyState={{
          title: assessments.length === 0 ? "No assessments yet" : "Nothing matches",
          description: assessments.length === 0
            ? "Start an assessment against one of your frameworks to track compliance."
            : "Try a different filter or search term.",
          action: canEdit && assessments.length === 0 ? (
            <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
              <Plus size={13} /> New assessment
            </button>
          ) : undefined,
        }}
        defaultSort={{ columnId: "updated", direction: "descending" }}
        onRowActivate={(row) => navigate(`/assessments/${row.id}`)}
        getRowHref={(row) => `/assessments/${row.id}`}
        maxHeight="none"
        minWidth="min(100%, 980px)"
      />

      {canEdit ? <CreateAssessmentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        frameworks={activeFrameworks}
        onCreate={handleCreate}
      /> : null}
    </div>
  );
}

function ScopeChip({
  applied,
  orgNameById }: {
  applied: string[] | null | undefined;
  orgNameById: Map<string, string>;
}) {
  // null = all-orgs perpetual; [] = no orgs assigned yet; [a] = single; [...] = many
  if (applied == null) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Globe size={11} /> All organizations
      </span>
    );
  }
  if (applied.length === 0) {
    return <span style={{ color: "var(--cv-fg-3)" }}>No organizations</span>;
  }
  if (applied.length === 1) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {orgNameById.get(applied[0]) ?? "Unknown organization"}
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <Users size={11} /> {applied.length} organizations
    </span>
  );
}
