import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";

import { Plus, Search, BookOpen, ChevronRight } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";
import EmptyState from "../../components/shared/EmptyState";
import BifrostDialogFrame from "../../components/shared/BifrostDialogFrame";
import ScopeBadge from "../../components/shared/ScopeBadge";
import OrgPicker from "../../components/shared/OrgPicker";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import { TABLE_FRAMEWORKS, TABLE_CONTROLS } from "../../lib/grc-tables";
import { useOrgNamesMap } from "../../lib/directory";
import { isGlobal } from "../../lib/scope";
import { useOrganizationView } from "../../lib/organization-view";
import type { Framework, Control } from "../../lib/types";

type ScopeFilter = "all" | "global" | "org";

export default function FrameworksListPage() {
  const { canEdit } = useGrcPermissions();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const { organizationId } = useOrganizationView();

  const orgNameById = useOrgNamesMap();

  const { rows: rawRows, loading, error } = useTable<Framework>(TABLE_FRAMEWORKS, {
    pageSize: 500,
    order_by: "name",
    order_dir: "asc" });
  const frameworks: Framework[] = useMemo(() => rawRows ?? [], [rawRows]);

  // Fetch all controls once and group client-side — much cheaper than per-row useTable.
  const { rows: controlRows } = useTable<Control>(TABLE_CONTROLS, { pageSize: 1000 });
  const controlsByFramework = useMemo(() => {
    const m = new Map<string, number>();
    (controlRows ?? []).forEach((c) => {
      if (!c?.framework_id) return;
      m.set(c.framework_id, (m.get(c.framework_id) ?? 0) + 1);
    });
    return m;
  }, [controlRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return frameworks.filter((f) => {
      if (scopeFilter === "global" && !isGlobal(f)) return false;
      if (scopeFilter === "org" && isGlobal(f)) return false;
      if (organizationId && f.organization_id != null && f.organization_id !== organizationId) return false;
      if (!q) return true;
      const name = (f.name ?? "").toLowerCase();
      const desc = (f.description ?? "").toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [frameworks, scopeFilter, search, organizationId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Frameworks"
        subtitle="Compliance frameworks, domains, and controls. Build your own or use a baseline catalog."
        actions={canEdit ? (
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} /> New framework
          </button>
        ) : undefined}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 420 }}>
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
            aria-label="Search frameworks"
            className="cv-field"
            placeholder="Search frameworks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 32 }}
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

      {loading && frameworks.length === 0 ? (
        <LoadingSkeleton variant="cards" rows={5} label="Loading frameworks" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={search || scopeFilter !== "all" ? "No matching frameworks" : "No frameworks yet"}
          body={
            search || scopeFilter !== "all"
              ? "Adjust your filter or search term."
              : "Create your first compliance framework to start building controls."
          }
          cta={
            canEdit && !search && scopeFilter === "all" ? (
              <button
                type="button"
                className="cv-btn cv-btn--primary cv-btn--sm"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={14} /> New framework
              </button>
            ) : null
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((f) => {
            const count = controlsByFramework.get(f.id) ?? 0;
            return (
              <Link
                key={f.id}
                to={`/frameworks/${f.id}`}
                className="cv-card cv-card--hover cv-framework-row"
              >
                <div
                  className="cv-stat-tile__icon cv-stat-tile__icon--purple"
                  style={{ width: 36, height: 36 }}
                >
                  <BookOpen size={16} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                    <span className="cv-table-primary-link" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.name ?? "Untitled framework"}
                    </span>
                    {f.version ? <span className="cv-chip cv-chip--mono cv-chip--neutral">v{f.version}</span> : null}
                    {f.is_active === false ? <span className="cv-chip cv-chip--neutral">Inactive</span> : null}
                  </div>
                  <div className="cv-table-secondary">
                    {f.description || "No description"}
                  </div>
                </div>
                <div className="cv-framework-row__scope">
                  <span className="cv-small">Organization</span>
                  {f.organization_id ? (
                    <span title={orgNameById.get(f.organization_id) ?? "Unknown organization"}>
                      {orgNameById.get(f.organization_id) ?? "Unknown organization"}
                    </span>
                  ) : (
                    <ScopeBadge row={f} />
                  )}
                </div>
                <div className="cv-framework-row__count">
                  <strong>{count}</strong>
                  <span>controls</span>
                </div>
                <ChevronRight size={16} style={{ color: "var(--cv-fg-3)" }} />
              </Link>
            );
          })}
        </div>
      )}

      {canEdit ? <CreateFrameworkDialog open={createOpen} onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}

interface CreateFrameworkDialogProps {
  open: boolean;
  onClose: () => void;
}

function CreateFrameworkDialog({ open, onClose }: CreateFrameworkDialogProps) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const userOrgId = user?.organizationId && user.organizationId.length > 0 ? user.organizationId : null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1.0");
  const [orgId, setOrgId] = useState<string | null>(userOrgId);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const reset = () => {
    setName("");
    setDescription("");
    setVersion("1.0");
    setOrgId(userOrgId);
  };

  const cancel = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: trimmed,
        description: description.trim() || null,
        version: version.trim() || null,
        is_active: true,
        scope: orgId == null ? "global" : "organization",
        organization_id: orgId };
      const created = (await tables.insert(TABLE_FRAMEWORKS, payload as any)) as any;
      reset();
      onClose();
      const newId = created?.id ?? created?.data?.id;
      if (newId) navigate(`/frameworks/${newId}`);
    } catch (err: any) {
      toast.error("Could not create framework: " + (err?.message ?? "unknown"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BifrostDialogFrame
      onDismiss={cancel}
      dismissDisabled={saving}
      labelledBy="new-framework-title"
      style={{ width: "min(520px, calc(100vw - 32px))" }}
    >
        <div className="cv-dialog__header">
          <h2 id="new-framework-title" className="cv-dialog__title">New framework</h2>
          <p id="new-framework-description" className="cv-small" style={{ margin: "4px 0 0" }}>
            Add a reusable standard or a customer-specific control set.
          </p>
        </div>
        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-framework-name">Name *</label>
            <input
              id="new-framework-name"
              autoFocus
              className="cv-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="NIST CSF 2.0"
              disabled={saving}
            />
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-framework-description-field">Description</label>
            <textarea
              id="new-framework-description-field"
              className="cv-field"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this framework covers"
              rows={3}
              disabled={saving}
            />
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-framework-version">Version</label>
            <input
              id="new-framework-version"
              className="cv-field"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.0"
              disabled={saving}
            />
          </div>
          <OrgPicker
            id="new-framework-organization"
            label="Organization"
            value={orgId}
            onChange={setOrgId}
            allowGlobal
            required
            disabled={saving}
          />
        </div>
        <div className="cv-dialog__footer">
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            onClick={cancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            onClick={submit}
            disabled={saving}
          >
            {saving ? "Creating…" : "Create framework"}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}
