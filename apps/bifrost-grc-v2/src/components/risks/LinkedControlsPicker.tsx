import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";

import { X, Search, Check } from "lucide-react";
import ThemedSelect from "@/components/shared/ThemedSelect";
import BifrostDialogFrame from "@/components/shared/BifrostDialogFrame";
import {
  TABLE_CONTROLS,
  TABLE_FRAMEWORKS,
  TABLE_RISK_LINKS,
} from "../../lib/grc-tables";
import type { Control, Framework } from "../../lib/types";

interface LinkedControlsPickerProps {
  open: boolean;
  riskId: string;
  organizationId: string | null;
  appliedOrganizations?: string[] | null;
  excludedOrganizations?: string[] | null;
  alreadyLinkedControlIds: string[];
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
}

export default function LinkedControlsPicker({
  open,
  riskId,
  organizationId,
  appliedOrganizations,
  excludedOrganizations,
  alreadyLinkedControlIds,
  onOpenChange,
  onLinked,
}: LinkedControlsPickerProps) {
  const [search, setSearch] = useState("");
  const [frameworkId, setFrameworkId] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { rows: frameworks } = useTable<Framework>(TABLE_FRAMEWORKS, {
    pageSize: 200,
    order_by: "name",
    order_dir: "asc",
  });
  const { rows: controls, loading: controlsLoading } = useTable<Control>(TABLE_CONTROLS, {
    pageSize: 1000,
    order_by: "control_id",
    order_dir: "asc",
  });

  const frameworkList: Framework[] = Array.isArray(frameworks) ? frameworks : [];
  const controlList: Control[] = Array.isArray(controls) ? controls : [];
  const linkedSet = useMemo(() => new Set(alreadyLinkedControlIds), [alreadyLinkedControlIds]);

  const filtered = useMemo(() => {
    let list = controlList.filter((c) => !linkedSet.has(c.id));
    if (frameworkId) list = list.filter((c) => c.framework_id === frameworkId);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.title?.toLowerCase().includes(q) ||
          c.control_id?.toLowerCase().includes(q) ||
          c.description?.toLowerCase().includes(q),
      );
    }
    return list.slice(0, 200);
  }, [controlList, frameworkId, search, linkedSet]);

  const fwName = (id?: string | null) => frameworkList.find((f) => f.id === id)?.name ?? "Framework";

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const close = () => {
    if (busy) return;
    setSearch("");
    setFrameworkId("");
    setSelected(new Set());
    onOpenChange(false);
  };

  const submit = async () => {
    if (selected.size === 0) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      const ids = Array.from(selected);
      for (const cid of ids) {
        await tables.insert(TABLE_RISK_LINKS, {
          organization_id: organizationId,
          applied_organizations: appliedOrganizations ?? null,
          excluded_organizations: excludedOrganizations ?? [],
          risk_id: riskId,
          target_type: "control",
          target_id: cid,
          relationship: "mitigates",
        });
      }
      setSelected(new Set());
      onLinked();
      onOpenChange(false);
    } catch (err) {
      toast.error("Failed to link controls: " + ((err as Error)?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BifrostDialogFrame
      onDismiss={close}
      dismissDisabled={busy}
      style={{ width: "min(680px, calc(100vw - 32px))" }}
    >
        <div className="cv-dialog__header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 className="cv-dialog__title">Link controls</h2>
          <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={close} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 8, flex: 1, minHeight: 0 }}>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <div style={{ flex: 1, position: "relative" }}>
              <Search
                size={14}
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--cv-fg-3)",
                  pointerEvents: "none",
                }}
              />
              <input
                className="cv-field"
                style={{ paddingLeft: 30 }}
                placeholder="Search controls…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <ThemedSelect
              ariaLabel="Framework"
              style={{ maxWidth: 220 }}
              value={frameworkId}
              onChange={setFrameworkId}
              options={[
                { value: "", label: "All frameworks" },
                ...frameworkList.map((framework) => ({ value: framework.id, label: framework.name })),
              ]}
            />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", border: "1px solid var(--cv-border)", borderRadius: 8 }}>
            {controlsLoading ? (
              <div style={{ padding: 20, color: "var(--cv-fg-3)", fontSize: 13 }}>Loading controls…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 20, color: "var(--cv-fg-3)", fontSize: 13 }}>
                {controlList.length === linkedSet.size
                  ? "All controls already linked."
                  : "No matching controls."}
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {filtered.map((c) => {
                  const isSel = selected.has(c.id);
                  return (
                    <li
                      key={c.id}
                      style={{
                        borderBottom: "1px solid var(--cv-border)",
                        background: isSel ? "var(--cv-bg-3)" : "transparent",
                      }}
                    >
                      <button
                        type="button"
                        className="cv-picker-option cv-picker-option--row"
                        aria-pressed={isSel}
                        onClick={() => toggle(c.id)}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            border: "1px solid " + (isSel ? "var(--cv-cb)" : "var(--cv-border-control)"),
                            background: isSel ? "var(--cv-action)" : "transparent",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            marginTop: 2,
                            color: "var(--bf-primary-foreground)",
                          }}
                        >
                          {isSel ? <Check size={12} /> : null}
                        </span>
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                            <code style={{ fontFamily: "var(--cv-font-mono)", fontSize: 12, color: "var(--cv-fg-2)" }}>{c.control_id}</code>
                            <span style={{ fontWeight: 500, color: "var(--cv-fg-1)" }}>{c.title}</span>
                            <span className="cv-chip cv-chip--neutral" style={{ fontSize: 10 }}>{fwName(c.framework_id)}</span>
                          </span>
                          {c.description ? (
                            <span style={{ display: "block", fontSize: 12, color: "var(--cv-fg-3)", marginTop: 2, lineHeight: 1.4 }}>
                              {c.description.slice(0, 120)}
                              {c.description.length > 120 ? "…" : ""}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <div className="cv-dialog__footer">
          <div style={{ flex: 1, fontSize: 12, color: "var(--cv-fg-3)" }}>
            {selected.size > 0 ? `${selected.size} selected` : null}
          </div>
          <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="cv-btn cv-btn--primary cv-btn--sm"
            onClick={submit}
            disabled={busy || selected.size === 0}
          >
            {busy ? "Linking…" : `Link ${selected.size || ""}`.trim()}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}
