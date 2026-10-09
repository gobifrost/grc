import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { tables } from "bifrost";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import ThemedSelect from "@/components/shared/ThemedSelect";
import { Plus, X, Loader2 } from "lucide-react";
import type { Control, Framework, PolicyLink } from "../../lib/types";
import { TABLE_POLICY_LINKS } from "../../lib/grc-tables";

interface LinkedControlsPickerProps {
  policyId: string;
  policyOrganizationId?: string | null;
  appliedOrganizations?: string[] | null;
  excludedOrganizations?: string[] | null;
  links: PolicyLink[];
  allControls: Control[];
  frameworks: Framework[];
  onChanged: () => void;
  disabled?: boolean;
}

/**
 * Linked-controls section for the policy detail page. Shows the list of
 * currently linked controls (with framework + title resolved client-side)
 * and lets the user open a sub-dialog to link more or unlink existing.
 */
export default function LinkedControlsPicker({
  policyId,
  policyOrganizationId,
  appliedOrganizations,
  excludedOrganizations,
  links,
  allControls,
  frameworks,
  onChanged,
  disabled = false,
}: LinkedControlsPickerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const controlsById = useMemo(() => {
    const m = new Map<string, Control>();
    (allControls ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [allControls]);

  const frameworksById = useMemo(() => {
    const m = new Map<string, Framework>();
    (frameworks ?? []).forEach((f) => m.set(f.id, f));
    return m;
  }, [frameworks]);

  const controlLinks = useMemo(
    () => (links ?? []).filter((l) => l.target_type === "control"),
    [links],
  );

  const linkedControlIds = useMemo(
    () => new Set(controlLinks.map((l) => l.target_id)),
    [controlLinks],
  );

  async function unlink(linkRowId: string) {
    setBusyId(linkRowId);
    try {
      await tables.delete(TABLE_POLICY_LINKS, linkRowId);
      onChanged();
    } catch (err) {
      toast.error("Failed to unlink control");
      console.error(err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
          {controlLinks.length} control{controlLinks.length === 1 ? "" : "s"} linked
        </div>
        {!disabled ? <button
          type="button"
          className="cv-btn cv-btn--secondary cv-btn--sm"
          onClick={() => setPickerOpen(true)}
        >
          <Plus size={14} style={{ marginRight: 6 }} />
          Link controls
        </button> : null}
      </div>

      {controlLinks.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--cv-border)",
            borderRadius: 10,
            padding: 24,
            textAlign: "center",
            color: "var(--cv-fg-3)",
            fontSize: 13,
          }}
        >
          No controls linked. Link controls to show how this policy enforces them.
        </div>
      ) : (
        <div
          style={{
            border: "1px solid var(--cv-border)",
            borderRadius: 10,
            background: "var(--cv-bg-2)",
            overflow: "hidden",
          }}
        >
          {controlLinks.map((link, idx) => {
            const ctrl = controlsById.get(link.target_id);
            const fw = ctrl?.framework_id
              ? frameworksById.get(ctrl.framework_id)
              : undefined;
            return (
              <div
                key={link.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderTop: idx === 0 ? "none" : "1px solid var(--cv-border)",
                }}
              >
                <span
                  className="cv-chip cv-chip--mono cv-chip--teal"
                  style={{ flexShrink: 0 }}
                >
                  {ctrl?.control_id ?? "?"}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: "var(--cv-fg-1)",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {ctrl?.title ?? "(control no longer exists)"}
                  </div>
                  {fw ? (
                    <div style={{ color: "var(--cv-fg-3)", fontSize: 12 }}>
                      {fw.name}
                    </div>
                  ) : null}
                </div>
                {!disabled ? <button
                  type="button"
                  className="cv-btn cv-btn--ghost cv-btn--sm"
                  onClick={() => unlink(link.id)}
                  disabled={busyId === link.id}
                  aria-label="Unlink control"
                  title="Unlink control"
                >
                  {busyId === link.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <X size={14} />
                  )}
                </button> : null}
              </div>
            );
          })}
        </div>
      )}

      <LinkControlsDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        policyId={policyId}
        policyOrganizationId={policyOrganizationId}
        appliedOrganizations={appliedOrganizations}
        excludedOrganizations={excludedOrganizations}
        allControls={allControls}
        frameworks={frameworks}
        linkedIds={linkedControlIds}
        onLinked={onChanged}
      />
    </div>
  );
}

interface LinkControlsDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  policyId: string;
  policyOrganizationId?: string | null;
  appliedOrganizations?: string[] | null;
  excludedOrganizations?: string[] | null;
  allControls: Control[];
  frameworks: Framework[];
  linkedIds: Set<string>;
  onLinked: () => void;
}

function LinkControlsDialog({
  open,
  onOpenChange,
  policyId,
  policyOrganizationId,
  appliedOrganizations,
  excludedOrganizations,
  allControls,
  frameworks,
  linkedIds,
  onLinked,
}: LinkControlsDialogProps) {
  const [search, setSearch] = useState("");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (allControls ?? [])
      .filter((c) => !linkedIds.has(c.id))
      .filter((c) =>
        frameworkFilter === "all" ? true : c.framework_id === frameworkFilter,
      )
      .filter((c) => {
        if (!q) return true;
        return (
          (c.control_id ?? "").toLowerCase().includes(q) ||
          (c.title ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, 200);
  }, [allControls, linkedIds, frameworkFilter, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveLinks() {
    if (selected.size === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    const ids = Array.from(selected);
    try {
      for (const controlId of ids) {
        await tables.insert(TABLE_POLICY_LINKS, {
          policy_id: policyId,
          target_type: "control",
          target_id: controlId,
          relationship: "governs",
          organization_id: policyOrganizationId,
          applied_organizations: appliedOrganizations ?? null,
          excluded_organizations: excludedOrganizations ?? [],
        });
      }
      setSelected(new Set());
      setSearch("");
      setFrameworkFilter("all");
      onOpenChange(false);
      onLinked();
    } catch (err) {
      toast.error("Failed to link controls");
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o);
      }}
    >
      <DialogContent
        className="sm:max-w-[640px]"
        style={{ background: "var(--cv-bg-2)", color: "var(--cv-fg-1)" }}
      >
        <DialogHeader>
          <DialogTitle>Link controls to policy</DialogTitle>
        </DialogHeader>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <Input
              placeholder="Search by control id or title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <ThemedSelect
              ariaLabel="Framework"
              value={frameworkFilter}
              onChange={setFrameworkFilter}
              style={{ minWidth: 180 }}
              options={[
                { value: "all", label: "All frameworks" },
                ...(frameworks ?? []).map((framework) => ({ value: framework.id, label: framework.name })),
              ]}
            />
          </div>

          <div
            style={{
              border: "1px solid var(--cv-border)",
              borderRadius: 8,
              background: "var(--cv-bg-1)",
              maxHeight: 360,
              overflow: "auto",
            }}
          >
            {candidates.length === 0 ? (
              <div
                style={{
                  padding: 28,
                  textAlign: "center",
                  color: "var(--cv-fg-3)",
                  fontSize: 13,
                }}
              >
                No controls match the current filters.
              </div>
            ) : (
              candidates.map((c, idx) => {
                const checked = selected.has(c.id);
                return (
                  <label
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      borderTop: idx === 0 ? "none" : "1px solid var(--cv-border)",
                      cursor: "pointer",
                      background: checked ? "var(--cv-bS)" : "transparent",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(c.id)}
                    />
                    <span
                      className="cv-chip cv-chip--mono cv-chip--teal"
                      style={{ flexShrink: 0 }}
                    >
                      {c.control_id}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        color: "var(--cv-fg-1)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.title}
                    </span>
                  </label>
                );
              })
            )}
          </div>

          <div style={{ color: "var(--cv-fg-3)", fontSize: 12 }}>
            {selected.size} selected
            {candidates.length === 200
              ? " — showing first 200 matches; refine search to see more"
              : ""}
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            onClick={saveLinks}
            disabled={saving || selected.size === 0}
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" style={{ marginRight: 6 }} />
                Linking...
              </>
            ) : (
              `Link ${selected.size || ""} control${selected.size === 1 ? "" : "s"}`.trim()
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
