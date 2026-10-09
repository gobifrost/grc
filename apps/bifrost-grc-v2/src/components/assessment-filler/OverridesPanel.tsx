import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Search, ShieldOff } from "lucide-react";
import StatusBadge from "../shared/StatusBadge";
import StatusSegmented from "./StatusSegmented";
import type {
  AssessmentControlOverride,
  ControlStatus,
} from "../../lib/types";

interface OverridesPanelProps {
  // Orgs this assessment is applied to. null = all orgs (perpetual).
  appliedOrganizations: string[] | null | undefined;
  // Map of all known orgs (id → name) for picker + display.
  orgNameById: Map<string, string>;
  // Default status for the control across the whole assessment.
  defaultStatus: ControlStatus | undefined;
  // Existing per-org overrides for this control.
  overrides: AssessmentControlOverride[];
  // Mutation hooks.
  onSetOverride: (orgId: string, status: ControlStatus, notes?: string) => Promise<void>;
  onClearOverride: (overrideId: string) => Promise<void>;
  onUpdateOverrideNotes: (overrideId: string, notes: string) => Promise<void>;
}

/**
 * Per-org exceptions to a control's default status. Shows the default
 * prominently, then lists explicit exceptions with inline status edit, with
 * a picker to add a new exception for any applied org that doesn't have one.
 *
 * Design notes:
 *  - Default is the "headline" (one row, prominent).
 *  - Exceptions are visually subordinate, indented, with smaller chrome.
 *  - Picker filters to orgs in scope that don't yet have an override.
 *  - When perpetual scope (null), the picker shows all known orgs.
 */
export default function OverridesPanel({
  appliedOrganizations,
  orgNameById,
  defaultStatus,
  overrides,
  onSetOverride,
  onClearOverride,
  onUpdateOverrideNotes,
}: OverridesPanelProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  // Orgs eligible to be added as an exception:
  //  - perpetual (null) → every known org that doesn't yet have an override
  //  - specific set    → that set minus orgs that already have an override
  const overrideByOrg = useMemo(() => {
    const m = new Map<string, AssessmentControlOverride>();
    overrides.forEach((o) => m.set(o.customer_organization_id, o));
    return m;
  }, [overrides]);

  const candidateOrgIds = useMemo(() => {
    const scope =
      appliedOrganizations == null
        ? Array.from(orgNameById.keys())
        : appliedOrganizations;
    return scope.filter((id) => !overrideByOrg.has(id));
  }, [appliedOrganizations, orgNameById, overrideByOrg]);

  const filteredCandidates = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const ids = q
      ? candidateOrgIds.filter((id) =>
          (orgNameById.get(id) ?? id).toLowerCase().includes(q),
        )
      : candidateOrgIds;
    return ids
      .map((id) => ({ id, name: orgNameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [candidateOrgIds, pickerQuery, orgNameById]);

  // Sort overrides alphabetically by org name for stable rendering.
  const sortedOverrides = useMemo(() => {
    return [...overrides].sort((a, b) => {
      const aName = orgNameById.get(a.customer_organization_id) ?? "";
      const bName = orgNameById.get(b.customer_organization_id) ?? "";
      return aName.localeCompare(bName);
    });
  }, [overrides, orgNameById]);

  // Don't render the section at all when single-org scope (or zero) — there's
  // nothing meaningful to "override against".
  if (
    appliedOrganizations != null &&
    appliedOrganizations.length <= 1
  ) {
    return null;
  }

  const scopeLabel =
    appliedOrganizations == null
      ? "all organizations"
      : `${appliedOrganizations.length} organizations`;

  return (
    <div
      style={{
        border: "1px solid var(--cv-border)",
        borderRadius: "var(--cv-r-md)",
        background: "var(--cv-bg-2)",
        overflow: "hidden",
      }}
    >
      {/* Default headline */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: "var(--cv-bg-3)",
          borderBottom: "1px solid var(--cv-border)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="cv-small"
            style={{
              color: "var(--cv-fg-3)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              fontSize: 11,
            }}
          >
            Default for {scopeLabel}
          </div>
        </div>
        <StatusBadge kind="control" value={defaultStatus} />
      </div>

      {/* Exceptions list */}
      {sortedOverrides.length === 0 ? (
        <div
          style={{
            padding: "14px 16px",
            color: "var(--cv-fg-3)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ShieldOff size={13} />
          No exceptions — every org uses the default.
        </div>
      ) : (
        <div>
          {sortedOverrides.map((ov) => (
            <OverrideRow
              key={ov.id}
              override={ov}
              orgName={orgNameById.get(ov.customer_organization_id) ?? "Unknown org"}
              onStatusChange={(s) => onSetOverride(ov.customer_organization_id, s)}
              onNotesChange={(n) => onUpdateOverrideNotes(ov.id, n)}
              onClear={() => onClearOverride(ov.id)}
            />
          ))}
        </div>
      )}

      {/* Add exception */}
      <div
        style={{
          borderTop: "1px solid var(--cv-border)",
          padding: "8px 12px",
        }}
      >
        {pickerOpen ? (
          <AddOverridePicker
            candidates={filteredCandidates}
            query={pickerQuery}
            onQueryChange={setPickerQuery}
            onClose={() => {
              setPickerOpen(false);
              setPickerQuery("");
            }}
            onPick={async (orgId) => {
              // Default new override to "not_applicable" — most common exception
              // shape ("not applicable for this client"). Users can change it
              // immediately in the row that just appeared above.
              await onSetOverride(orgId, "not_applicable");
              setPickerOpen(false);
              setPickerQuery("");
            }}
          />
        ) : (
          <button
            type="button"
            className="cv-btn cv-btn--ghost cv-btn--sm"
            onClick={() => setPickerOpen(true)}
            disabled={candidateOrgIds.length === 0}
            title={
              candidateOrgIds.length === 0
                ? "Every applied org already has an exception"
                : "Add an exception for an organization"
            }
          >
            <Plus size={13} /> Add exception
            {candidateOrgIds.length > 0 ? (
              <span className="cv-small" style={{ color: "var(--cv-fg-3)", marginLeft: 6 }}>
                ({candidateOrgIds.length} {candidateOrgIds.length === 1 ? "org" : "orgs"} eligible)
              </span>
            ) : null}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OverrideRow — single per-org exception row with inline edits.
// ---------------------------------------------------------------------------

interface OverrideRowProps {
  override: AssessmentControlOverride;
  orgName: string;
  onStatusChange: (status: ControlStatus) => void;
  onNotesChange: (notes: string) => void;
  onClear: () => void;
}

function OverrideRow({
  override,
  orgName,
  onStatusChange,
  onNotesChange,
  onClear,
}: OverrideRowProps) {
  const [notes, setNotes] = useState<string>(override.notes ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef<string>(override.notes ?? "");

  useEffect(() => {
    setNotes(override.notes ?? "");
    lastSentRef.current = override.notes ?? "";
  }, [override.id, override.notes]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const scheduleNotes = (next: string) => {
    setNotes(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (next !== lastSentRef.current) {
        lastSentRef.current = next;
        onNotesChange(next);
      }
    }, 500);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(140px, 200px) minmax(0, 380px) 1fr auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        borderBottom: "1px solid var(--cv-border)",
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: "var(--cv-fg-1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={orgName}
      >
        {orgName}
      </div>
      <div style={{ minWidth: 0 }}>
        <StatusSegmented value={override.status} onChange={onStatusChange} />
      </div>
      <input
        type="text"
        className="cv-field"
        placeholder="Why? (optional)"
        value={notes}
        onChange={(e) => scheduleNotes(e.target.value)}
        onBlur={() => {
          if (timerRef.current) clearTimeout(timerRef.current);
          if (notes !== lastSentRef.current) {
            lastSentRef.current = notes;
            onNotesChange(notes);
          }
        }}
        style={{ fontSize: 13 }}
      />
      <button
        type="button"
        className="cv-btn cv-btn--ghost cv-btn--sm"
        onClick={onClear}
        title="Remove exception (revert to default)"
        style={{ padding: 6, color: "var(--cv-fg-3)" }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddOverridePicker — searchable inline picker.
// ---------------------------------------------------------------------------

interface AddOverridePickerProps {
  candidates: Array<{ id: string; name: string }>;
  query: string;
  onQueryChange: (q: string) => void;
  onClose: () => void;
  onPick: (orgId: string) => void;
}

function AddOverridePicker({
  candidates,
  query,
  onQueryChange,
  onClose,
  onPick,
}: AddOverridePickerProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ position: "relative" }}>
        <Search
          size={13}
          style={{
            position: "absolute",
            left: 10,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--cv-fg-3)",
          }}
        />
        <input
          type="text"
          className="cv-field"
          autoFocus
          placeholder="Search organizations…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          style={{ paddingLeft: 30, fontSize: 13 }}
        />
      </div>
      <div
        style={{
          maxHeight: 220,
          overflow: "auto",
          border: "1px solid var(--cv-border)",
          borderRadius: "var(--cv-r-sm)",
          background: "var(--cv-bg-1)",
        }}
      >
        {candidates.length === 0 ? (
          <div
            style={{
              padding: "12px 14px",
              color: "var(--cv-fg-3)",
              fontSize: 13,
            }}
          >
            {query ? "No matches" : "No eligible orgs"}
          </div>
        ) : (
          candidates.slice(0, 50).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 14px",
                background: "transparent",
                border: 0,
                borderBottom: "1px solid var(--cv-border)",
                color: "var(--cv-fg-1)",
                fontSize: 13,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--cv-bg-3)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              {c.name}
            </button>
          ))
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
