import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfChip } from "@/components/bifrost/BfChip";
import { BfDataTable, type BfDataColumn } from "@/components/bifrost/BfDataTable";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";

import { Search, Plus, ChevronRight } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ScopeBadge from "../../components/shared/ScopeBadge";
import ThemedSelect from "../../components/shared/ThemedSelect";
import UserPicker from "../../components/shared/UserPicker";
import StateSegmented from "../../components/shared/StateSegmented";
import {
  TABLE_APPLIED_CONTROLS,
  TABLE_CONTROL_MAPPINGS,
  TABLE_EVIDENCE_LINKS,
  TABLE_POLICY_LINKS,
  TABLE_EXCEPTION_LINKS,
} from "../../lib/grc-tables";
import { appliesToOrg, rowOrganizationIdForScope } from "../../lib/scope";
import { useOrganizationView } from "../../lib/organization-view";
import { useUserNameLookup } from "../../lib/directory";
import {
  APPLIED_CONTROL_STATE_OPTIONS,
  appliedControlState,
  appliedControlStatePatch,
  normalizeControlType,
  type AppliedControlState,
} from "../../lib/applied-control-state";
import type {
  AppliedControl,
  ControlMapping,
  EvidenceLink,
  ExceptionLink,
  PolicyLink,
} from "../../lib/types";

type StateFilter = "all" | AppliedControlState;
const TYPE_OPTIONS = [
  { label: "Technical", value: "technical" },
  { label: "Administrative / policy", value: "administrative" },
  { label: "Process", value: "process" },
  { label: "Physical", value: "physical" },
  { label: "Compensating", value: "compensating" },
];

function labelize(value?: string | null): string {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusTone(status: AppliedControlState): "success" | "warning" | "info" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "needs_review") return "warning";
  if (status === "partial") return "info";
  if (status === "retired" || status === "rejected") return "danger";
  return "neutral";
}

export default function AppliedControlsPage() {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const { canEdit } = useGrcPermissions();
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const { organizationId } = useOrganizationView();
  const userName = useUserNameLookup();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    organizationScope: null as string[] | null,
    name: "",
    description: "",
    control_type: "",
    owner: "",
    state: "draft" as AppliedControlState,
  });

  const { rows: appliedRows, loading, error } = useTable<AppliedControl>(TABLE_APPLIED_CONTROLS, {
    pageSize: 1000,
    order_by: "updated_at",
    order_dir: "desc",
  });
  const { rows: mappingRows } = useTable<ControlMapping>(TABLE_CONTROL_MAPPINGS, { pageSize: 1000 });
  const { rows: evidenceLinks } = useTable<EvidenceLink>(TABLE_EVIDENCE_LINKS, { pageSize: 1000 });
  const { rows: policyLinks } = useTable<PolicyLink>(TABLE_POLICY_LINKS, { pageSize: 1000 });
  const { rows: exceptionLinks } = useTable<ExceptionLink>(TABLE_EXCEPTION_LINKS, { pageSize: 1000 });

  const countByApplied = useMemo(() => {
    const map = new Map<string, { mappings: number; evidence: number; policies: number; exceptions: number }>();
    const ensure = (id: string) => {
      const current = map.get(id);
      if (current) return current;
      const next = { mappings: 0, evidence: 0, policies: 0, exceptions: 0 };
      map.set(id, next);
      return next;
    };
    (mappingRows ?? []).forEach((row) => {
      ensure(row.applied_control_id).mappings += 1;
    });
    (evidenceLinks ?? []).forEach((row) => {
      if (row.target_type === "applied_control") ensure(row.target_id).evidence += 1;
    });
    (policyLinks ?? []).forEach((row) => {
      if (row.target_type === "applied_control") ensure(row.target_id).policies += 1;
    });
    (exceptionLinks ?? []).forEach((row) => {
      if (row.target_type === "applied_control") ensure(row.target_id).exceptions += 1;
    });
    return map;
  }, [mappingRows, evidenceLinks, policyLinks, exceptionLinks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (appliedRows ?? []).filter((row) => {
      if (organizationId && !appliesToOrg(row, organizationId)) return false;
      if (stateFilter !== "all" && appliedControlState(row) !== stateFilter) return false;
      if (!q) return true;
      return (
        (row.name ?? "").toLowerCase().includes(q) ||
        (row.description ?? "").toLowerCase().includes(q) ||
        (row.control_type ?? "").toLowerCase().includes(q) ||
        (row.owner ?? "").toLowerCase().includes(q)
      );
    });
  }, [appliedRows, organizationId, search, stateFilter]);

  const columns = useMemo<BfDataColumn<AppliedControl>[]>(() => [
    {
      id: "scope",
      header: "Scope",
      width: "132px",
      cell: (row) => <ScopeBadge row={row} />,
    },
    {
      id: "control",
      header: "Applied control",
      sortValue: (row) => row.name,
      sortable: true,
      cell: (row) => (
        <div className="cv-table-stack">
          <Link className="cv-table-primary-link" to={`/applied-controls/${row.id}`}>{row.name}</Link>
          <div className="cv-data-table__secondary">
            {[row.control_type ? labelize(normalizeControlType(row.control_type)) : null, row.owner ? userName(row.owner) : null, row.description]
              .filter(Boolean)
              .join(" · ") || "No description"}
          </div>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      width: "142px",
      className: "cv-applied-controls-secondary-column",
      sortValue: (row) => appliedControlState(row),
      sortable: true,
      cell: (row) => {
        const state = appliedControlState(row);
        return <BfChip tone={statusTone(state)}>{labelize(state)}</BfChip>;
      },
    },
    {
      id: "coverage",
      header: "Coverage",
      width: "188px",
      className: "cv-applied-controls-secondary-column",
      cell: (row) => {
        const counts = countByApplied.get(row.id) ?? { mappings: 0, evidence: 0, policies: 0, exceptions: 0 };
        return (
          <div className="cv-table-coverage">
            <span><strong>{counts.mappings}</strong> mappings</span>
            <span><strong>{counts.evidence}</strong> evidence</span>
            <span><strong>{counts.policies}</strong> policies</span>
            <span><strong>{counts.exceptions}</strong> exceptions</span>
          </div>
        );
      },
    },
    {
      id: "open",
      header: <span className="sr-only">Open</span>,
      width: "32px",
      align: "end",
      className: "cv-applied-controls-secondary-column",
      cell: () => <ChevronRight size={15} className="text-[var(--bf-muted)]" aria-hidden="true" />,
    },
  ], [countByApplied, userName]);

  const createAppliedControl = async () => {
    if (draft.organizationScope?.length === 0) {
      toast.error("Choose at least one organization or select All");
      return;
    }
    if (!draft.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setCreating(true);
    try {
      const statePatch = appliedControlStatePatch(draft.state);
      const row = await tables.insert(TABLE_APPLIED_CONTROLS, {
        organization_id: rowOrganizationIdForScope(draft.organizationScope, currentUser.organizationId),
        applied_organizations: draft.organizationScope,
        excluded_organizations: [],
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        control_type: draft.control_type.trim() || null,
        owner: draft.owner.trim() || null,
        ...statePatch,
      });
      setCreateOpen(false);
      setDraft({
        organizationScope: draft.organizationScope,
        name: "",
        description: "",
        control_type: "",
        owner: "",
        state: "draft",
      });
      navigate(`/applied-controls/${row.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create applied control");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <PageHeader
        title="Applied Controls"
        subtitle="Provider-managed controls and safeguards applied consistently to one, some, or all customers."
        actions={canEdit ? (
          <BfButton icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
            New applied control
          </BfButton>
        ) : undefined}
      />

      {canEdit ? <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New applied control</DialogTitle>
            <DialogDescription>
              Record a customer safeguard once, then map it to every framework control it supports.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-1">
            <OrgScopeField
              id="new-applied-control-scope"
              value={draft.organizationScope}
              onChange={(organizationScope) => setDraft((current) => ({ ...current, organizationScope }))}
            />
            <div className="cv-form-grid">
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-applied-control-name">Name *</label>
              <Input id="new-applied-control-name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-applied-control-type">Type</label>
              <ThemedSelect
                id="new-applied-control-type"
                value={draft.control_type}
                onChange={(control_type) => setDraft((d) => ({ ...d, control_type }))}
                options={[{ label: "Select type", value: "" }, ...TYPE_OPTIONS]}
                ariaLabel="Control type"
              />
            </div>
            <UserPicker
              id="new-applied-control-owner"
              label="Owner"
              value={draft.owner || null}
              orgId={currentUser.organizationId}
              onChange={(owner) => setDraft((d) => ({ ...d, owner: owner ?? "" }))}
            />
          </div>
          <div className="cv-field-group" style={{ marginTop: 12 }}>
            <label className="cv-field-label">State</label>
            <StateSegmented
              value={draft.state}
              options={APPLIED_CONTROL_STATE_OPTIONS}
              onChange={(state) => setDraft((current) => ({ ...current, state }))}
              ariaLabel="Applied control state"
            />
          </div>
          <div className="cv-field-group" style={{ marginTop: 12 }}>
            <label className="cv-field-label" htmlFor="new-applied-control-description">Description</label>
            <Textarea
              id="new-applied-control-description"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              rows={3}
            />
          </div>
          </div>
          <DialogFooter>
            <BfButton variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </BfButton>
            <BfButton onClick={createAppliedControl} disabled={creating} aria-busy={creating}>
              {creating ? "Creating..." : "Create applied control"}
            </BfButton>
          </DialogFooter>
        </DialogContent>
      </Dialog> : null}

      <div className="cv-applied-controls-filters" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div className="cv-applied-controls-search" style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--cv-fg-3)" }} />
          <Input
            aria-label="Search applied controls"
            placeholder="Search applied controls..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 30 }}
          />
        </div>
        <div style={{ minWidth: 180 }}>
          <ThemedSelect
            value={stateFilter}
            onChange={(value) => setStateFilter(value as StateFilter)}
            options={[
              { label: "All states", value: "all" },
              ...APPLIED_CONTROL_STATE_OPTIONS.map(({ label, value }) => ({ label, value })),
            ]}
            ariaLabel="Filter by state"
          />
        </div>
      </div>

      <BfDataTable
        className="cv-applied-controls-bf-table"
        rows={filtered}
        columns={columns}
        getRowId={(row) => row.id}
        ariaLabel="Applied controls"
        loading={loading}
        error={error ? { title: "Couldn't load applied controls", description: String(error) } : undefined}
        emptyState={{
          title: "No applied controls match",
          description: "Create applied controls directly, or import them from CISO Assistant.",
          action: canEdit ? <BfButton icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>New applied control</BfButton> : undefined,
        }}
        onRowActivate={(row) => navigate(`/applied-controls/${row.id}`)}
        getRowHref={(row) => `/applied-controls/${row.id}`}
        maxHeight="none"
      />
    </div>
  );
}
