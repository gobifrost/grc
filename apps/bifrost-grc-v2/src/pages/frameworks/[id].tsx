import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";
import { ArrowLeft, Plus, Trash2, Delete, Group } from "lucide-react";
import { useParams } from "react-router-dom";
import PageHeader from "../../components/shared/PageHeader";
import ScopeBadge from "../../components/shared/ScopeBadge";
import { confirm } from "../../components/shared/ConfirmDialog";
import DomainGroup from "../../components/framework-builder/DomainGroup";
import InlineEdit from "../../components/framework-builder/InlineEdit";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import { useGrcPermissions } from "../../lib/current-user";
import {
  TABLE_FRAMEWORKS,
  TABLE_DOMAINS,
  TABLE_CONTROLS,
} from "../../lib/grc-tables";
import type { Framework, Domain, Control } from "../../lib/types";

function unwrapRow<T>(raw: unknown): (T & { id: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if ("data" in row && row.data && typeof row.data === "object") {
    return { id: String(row.id ?? ""), ...(row.data as Record<string, unknown>) } as T & { id: string };
  }
  return row as T & { id: string };
}

const deleteRow = (table: string, id: string) => tables.delete(table, id);

export default function FrameworkBuilderPage() {
  const { canEdit } = useGrcPermissions();
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const frameworkId = params.id ?? "";

  const [framework, setFramework] = useState<Framework | null>(null);
  const [fwLoading, setFwLoading] = useState(true);
  const [fwError, setFwError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Load framework via tables.get (useTable can't filter by id).
  useEffect(() => {
    let cancelled = false;
    if (!frameworkId) {
      setFwLoading(false);
      setFwError("Missing framework id");
      return;
    }
    setFwLoading(true);
    setFwError(null);
    tables
      .get(TABLE_FRAMEWORKS, frameworkId)
      .then((row: unknown) => {
        if (cancelled) return;
        setFramework(unwrapRow<Framework>(row));
        if (!row) setFwError("Framework not found.");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFwError((e as Error)?.message ?? "Failed to load framework");
      })
      .finally(() => {
        if (!cancelled) setFwLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [frameworkId, reloadKey]);

  // Domains under this framework (live).
  const {
    rows: domainRowsRaw,
    loading: domainsLoading,
  } = useTable<Domain>(TABLE_DOMAINS, {
    where: { framework_id: frameworkId },
    order_by: "sort_order",
    order_dir: "asc",
    pageSize: 500,
  });
  const domains: Domain[] = useMemo(
    () => [...(domainRowsRaw ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [domainRowsRaw],
  );

  // All controls under this framework (live).
  const { rows: controlRowsRaw } = useTable<Control>(TABLE_CONTROLS, {
    where: { framework_id: frameworkId },
    order_by: "sort_order",
    order_dir: "asc",
    pageSize: 1000,
  });
  const controlsByDomain = useMemo(() => {
    const m = new Map<string, Control[]>();
    (controlRowsRaw ?? []).forEach((c) => {
      const did = c.domain_id ?? "__none__";
      if (!m.has(did)) m.set(did, []);
      m.get(did)!.push(c);
    });
    m.forEach((arr) => arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    return m;
  }, [controlRowsRaw]);

  const totalControls = controlRowsRaw?.length ?? 0;

  function arrayMove<T>(arr: T[], from: number, to: number): T[] {
    const next = [...arr];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }

  // ----- Mutations -----

  const patchFramework = async (patch: Partial<Framework>) => {
    if (!framework) return;
    const next = { ...framework, ...patch };
    setFramework(next); // optimistic
    try {
      await tables.update(TABLE_FRAMEWORKS, framework.id, patch as Record<string, unknown>);
    } catch (e) {
      toast.error("Save failed: " + ((e as Error)?.message ?? "unknown"));
      setFramework(framework); // revert
    }
  };

  const patchDomain = async (id: string, patch: Partial<Domain>) => {
    try {
      await tables.update(TABLE_DOMAINS, id, patch as Record<string, unknown>);
    } catch (e) {
      toast.error("Save failed: " + ((e as Error)?.message ?? "unknown"));
    }
  };

  const patchControl = async (id: string, patch: Partial<Control>) => {
    try {
      await tables.update(TABLE_CONTROLS, id, patch as Record<string, unknown>);
    } catch (e) {
      toast.error("Save failed: " + ((e as Error)?.message ?? "unknown"));
    }
  };

  const addDomain = async () => {
    if (!framework) return;
    const sort_order = (domains[domains.length - 1]?.sort_order ?? 0) + 10;
    try {
      await tables.insert(TABLE_DOMAINS, {
        framework_id: framework.id,
        name: "New domain",
        sort_order,
        is_active: true,
        organization_id: framework.organization_id ?? null,
      } as Record<string, unknown>);
      // useTable subscription will pick it up.
    } catch (e) {
      toast.error("Could not add domain: " + ((e as Error)?.message ?? "unknown"));
    }
  };

  const deleteDomain = async (domain: Domain) => {
    const children = controlsByDomain.get(domain.id) ?? [];
    const ok = await confirm({
      title: `Delete domain "${domain.name || "Untitled"}"?`,
      body:
        children.length > 0
          ? `This domain has ${children.length} control(s). Controls will be deleted too.`
          : "This action can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      // delete child controls first
      for (const c of children) {
        await deleteRow(TABLE_CONTROLS, c.id);
      }
      await deleteRow(TABLE_DOMAINS, domain.id);
    } catch (e) {
      toast.error("Delete failed: " + ((e as Error)?.message ?? "unknown"));
    }
  };

  const addControl = async (domain: Domain) => {
    if (!framework) return;
    const existing = controlsByDomain.get(domain.id) ?? [];
    const sort_order = (existing[existing.length - 1]?.sort_order ?? 0) + 10;
    const nextNum = existing.length + 1;
    try {
      await tables.insert(TABLE_CONTROLS, {
        framework_id: framework.id,
        domain_id: domain.id,
        control_id: `C-${nextNum}`,
        title: "New control",
        sort_order,
        is_active: true,
        organization_id: framework.organization_id ?? null,
      } as Record<string, unknown>);
    } catch (e) {
      toast.error("Could not add control: " + ((e as Error)?.message ?? "unknown"));
    }
  };

  const deleteControl = async (control: Control) => {
    const ok = await confirm({
      title: `Delete control "${control.control_id || control.title || "Untitled"}"?`,
      body: "This action can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteRow(TABLE_CONTROLS, control.id);
    } catch (e) {
      toast.error("Delete failed: " + ((e as Error)?.message ?? "unknown"));
    }
  };

  const deleteFramework = async () => {
    if (!framework) return;
    const ok = await confirm({
      title: `Delete framework "${framework.name}"?`,
      body: `All ${domains.length} domain(s) and ${totalControls} control(s) will be deleted. This can't be undone.`,
      confirmLabel: "Delete framework",
      destructive: true,
    });
    if (!ok) return;
    try {
      for (const c of controlRowsRaw ?? []) {
        await deleteRow(TABLE_CONTROLS, c.id);
      }
      for (const d of domains) {
        await deleteRow(TABLE_DOMAINS, d.id);
      }
      await deleteRow(TABLE_FRAMEWORKS, framework.id);
      navigate("/frameworks");
    } catch (e) {
      toast.error("Delete failed: " + ((e as Error)?.message ?? "unknown"));
    }
  };

  // ----- Drag-and-drop (native HTML5) -----

  const [draggedDomainId, setDraggedDomainId] = useState<string | null>(null);
  const [dropTargetDomainId, setDropTargetDomainId] = useState<string | null>(null);
  const [draggedControlId, setDraggedControlId] = useState<string | null>(null);
  const [dropTargetControlId, setDropTargetControlId] = useState<string | null>(null);

  const reorderDomains = async (activeId: string, overId: string) => {
    const oldIndex = domains.findIndex((d) => d.id === activeId);
    const newIndex = domains.findIndex((d) => d.id === overId);
    if (oldIndex === newIndex) return;
    if (oldIndex < 0 || newIndex < 0) return;
    const next = [...domains];
    const reordered = arrayMove(next, oldIndex, newIndex);
    try {
      await Promise.all(
        reordered.map((d, i) =>
          d.sort_order === (i + 1) * 10
            ? null
            : tables.update(TABLE_DOMAINS, d.id, { sort_order: (i + 1) * 10 } as Record<string, unknown>),
        ),
      );
    } catch (err) {
      toast.error("Reorder failed: " + ((err as Error)?.message ?? "unknown"));
    }
  };

  const reorderControls = async (activeId: string, overId: string, domainId: string) => {
    const list = controlsByDomain.get(domainId) ?? [];
    const oldIndex = list.findIndex((c) => c.id === activeId);
    const newIndex = list.findIndex((c) => c.id === overId);
    if (oldIndex === newIndex) return;
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(list, oldIndex, newIndex);
    try {
      await Promise.all(
        next.map((c, i) =>
          c.sort_order === (i + 1) * 10
            ? null
            : tables.update(TABLE_CONTROLS, c.id, { sort_order: (i + 1) * 10 } as Record<string, unknown>),
        ),
      );
    } catch (err) {
      toast.error("Reorder failed: " + ((err as Error)?.message ?? "unknown"));
    }
  };

  const moveControlToDomain = async (controlId: string, domainId: string, overControlId?: string) => {
    const control = (controlRowsRaw ?? []).find((c) => c.id === controlId);
    if (!control) return;
    const targetControls = (controlsByDomain.get(domainId) ?? []).filter((c) => c.id !== controlId);
    const next = [...targetControls];
    const targetIndex = overControlId ? next.findIndex((c) => c.id === overControlId) : -1;
    next.splice(targetIndex >= 0 ? targetIndex : next.length, 0, { ...control, domain_id: domainId });
    try {
      await Promise.all(
        next.map((c, i) => {
          const sort_order = (i + 1) * 10;
          if (c.id === controlId) {
            return tables.update(TABLE_CONTROLS, c.id, { domain_id: domainId, sort_order } as Record<string, unknown>);
          }
          return c.sort_order === sort_order
            ? null
            : tables.update(TABLE_CONTROLS, c.id, { sort_order } as Record<string, unknown>);
        }),
      );
    } catch (err) {
      toast.error("Move failed: " + ((err as Error)?.message ?? "unknown"));
    }
  };

  // Domain drag handlers
  const onDragStartDomain = (id: string, e: React.DragEvent) => {
    setDraggedDomainId(id);
    try {
      e.dataTransfer.setData("text/plain", `domain:${id}`);
      e.dataTransfer.effectAllowed = "move";
    } catch {}
  };
  const onDragEndDomain = () => {
    setDraggedDomainId(null);
    setDropTargetDomainId(null);
  };
  const onDragOverDomain = (id: string, e: React.DragEvent) => {
    // Domain accepts: another domain (reorder) OR a control (move to this domain)
    if (!draggedDomainId && !draggedControlId) return;
    if (draggedDomainId === id) return; // can't drop on self
    e.preventDefault();
    e.stopPropagation();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {}
    if (dropTargetDomainId !== id) setDropTargetDomainId(id);
  };
  const onDragLeaveDomain = (id: string) => {
    if (dropTargetDomainId === id) setDropTargetDomainId(null);
  };
  const onDropDomain = async (id: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const srcDomain = draggedDomainId;
    const srcControl = draggedControlId;
    setDraggedDomainId(null);
    setDraggedControlId(null);
    setDropTargetDomainId(null);
    setDropTargetControlId(null);
    if (srcDomain && srcDomain !== id) {
      await reorderDomains(srcDomain, id);
    } else if (srcControl) {
      await moveControlToDomain(srcControl, id);
    }
  };

  // Control drag handlers
  const onDragStartControl = (id: string, e: React.DragEvent) => {
    setDraggedControlId(id);
    try {
      e.dataTransfer.setData("text/plain", `control:${id}`);
      e.dataTransfer.effectAllowed = "move";
    } catch {}
  };
  const onDragEndControl = () => {
    setDraggedControlId(null);
    setDropTargetControlId(null);
  };
  const onDragOverControl = (id: string, e: React.DragEvent) => {
    if (!draggedControlId) return; // only controls drop on controls
    if (draggedControlId === id) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {}
    if (dropTargetControlId !== id) setDropTargetControlId(id);
  };
  const onDragLeaveControl = (id: string) => {
    if (dropTargetControlId === id) setDropTargetControlId(null);
  };
  const onDropControl = async (id: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const src = draggedControlId;
    setDraggedControlId(null);
    setDropTargetControlId(null);
    if (!src || src === id) return;
    const srcCtrl = (controlRowsRaw ?? []).find((c) => c.id === src);
    const overCtrl = (controlRowsRaw ?? []).find((c) => c.id === id);
    if (!srcCtrl || !overCtrl) return;
    if (srcCtrl.domain_id === overCtrl.domain_id && srcCtrl.domain_id) {
      await reorderControls(src, id, srcCtrl.domain_id);
    } else if (overCtrl.domain_id) {
      await moveControlToDomain(src, overCtrl.domain_id, id);
    }
  };

  // ----- Render -----

  if (fwLoading) {
    return <LoadingSkeleton variant="editor" rows={5} label="Loading framework editor" />;
  }

  if (fwError || !framework) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          onClick={() => navigate("/frameworks")}
        >
          <ArrowLeft size={14} /> Back to frameworks
        </button>
        <div className="cv-callout cv-callout--danger">
          <div className="cv-callout__label">Couldn't load framework</div>
          <div className="cv-callout__body">{fwError ?? "Unknown error"}</div>
        </div>
        <div>
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <button
        type="button"
        className="cv-btn cv-btn--ghost cv-btn--sm"
        onClick={() => navigate("/frameworks")}
        style={{ alignSelf: "flex-start" }}
      >
        <ArrowLeft size={14} /> Frameworks
      </button>

      <PageHeader
        title={
          <InlineEdit
            value={framework.name ?? ""}
            placeholder="Framework name"
            onCommit={(v) => patchFramework({ name: v.trim() || "Untitled" })}
            readOnly={!canEdit}
          />
        }
        subtitle={
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ color: "var(--cv-fg-3)", fontSize: 12 }}>Version</span>
              <span className="cv-chip cv-chip--mono cv-chip--neutral">
                <InlineEdit
                  value={framework.version ?? ""}
                  placeholder="1.0"
                  mono
                  onCommit={(v) => patchFramework({ version: v.trim() || null })}
                  readOnly={!canEdit}
                />
              </span>
              <ScopeBadge row={framework} />
              {framework.is_active === false ? (
                <span className="cv-chip cv-chip--neutral">Inactive</span>
              ) : null}
            </div>
            <div style={{ color: "var(--cv-fg-2)", fontSize: 14, maxWidth: 720 }}>
              <InlineEdit
                value={framework.description ?? ""}
                placeholder="Add a description for this framework"
                multiline
                onCommit={(v) => patchFramework({ description: v.trim() || null })}
                readOnly={!canEdit}
              />
            </div>
          </div>
        }
        actions={canEdit ? (
          <button
            type="button"
            className="cv-btn cv-btn--destructive cv-btn--sm"
            onClick={deleteFramework}
          >
            <Trash2 size={14} /> Delete
          </button>
        ) : undefined}
      />

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--cv-bg-1)",
          padding: "0 0 10px",
          borderBottom: "1px solid var(--cv-border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        {canEdit ? <button
          type="button"
          className="cv-btn cv-btn--primary cv-btn--sm"
          onClick={addDomain}
        >
          <Plus size={14} /> Add domain
        </button> : null}
        <span style={{ fontSize: 13, color: "var(--cv-fg-3)" }}>
          {domains.length} domain{domains.length === 1 ? "" : "s"} · {totalControls} control
          {totalControls === 1 ? "" : "s"}
        </span>
      </div>

      {domainsLoading && domains.length === 0 ? (
        <LoadingSkeleton variant="editor" rows={4} label="Loading framework domains" />
      ) : domains.length === 0 ? (
        <div
          className="cv-card"
          style={{
            padding: 36,
            textAlign: "center",
            border: "1px dashed var(--cv-border)",
            background: "transparent",
          }}
        >
          <div className="cv-h3" style={{ marginBottom: 6 }}>
            No domains yet
          </div>
          <div style={{ color: "var(--cv-fg-3)", marginBottom: 12, fontSize: 14 }}>
            Group related controls into domains. Each control belongs to one domain.
          </div>
          {canEdit ? <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            onClick={addDomain}
          >
            <Plus size={14} /> Add your first domain
          </button> : null}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {domains.map((d) => (
            <DomainGroup
              key={d.id}
              domain={d}
              controls={controlsByDomain.get(d.id) ?? []}
              onPatchDomain={(p) => patchDomain(d.id, p)}
              onDeleteDomain={() => deleteDomain(d)}
              onAddControl={() => addControl(d)}
              onPatchControl={(cid, p) => patchControl(cid, p)}
              onDeleteControl={(cid) => {
                const c = (controlRowsRaw ?? []).find((x) => x.id === cid);
                return c ? deleteControl(c) : Promise.resolve();
              }}
              isDragging={draggedDomainId === d.id}
              isDropTarget={dropTargetDomainId === d.id}
              draggedControlId={draggedControlId}
              dropTargetControlId={dropTargetControlId}
              onDragStartDomain={onDragStartDomain}
              onDragEndDomain={onDragEndDomain}
              onDragOverDomain={onDragOverDomain}
              onDragLeaveDomain={onDragLeaveDomain}
              onDropDomain={onDropDomain}
              onDragStartControl={onDragStartControl}
              onDragEndControl={onDragEndControl}
              onDragOverControl={onDragOverControl}
              onDragLeaveControl={onDragLeaveControl}
              onDropControl={onDropControl}
              readOnly={!canEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
}
