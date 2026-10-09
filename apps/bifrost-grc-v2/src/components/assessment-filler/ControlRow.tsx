import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, FileText, ListChecks, Paperclip, Plus, Upload, X } from "lucide-react";
import StatusSegmented from "./StatusSegmented";
import ImplementationSlider from "./ImplementationSlider";
import OverridesPanel from "./OverridesPanel";
import MultiSelectDropdown from "../shared/MultiSelectDropdown";
import BifrostDialogFrame from "../shared/BifrostDialogFrame";
import type {
  AssessmentControl,
  AssessmentControlOverride,
  AppliedControl,
  Control,
  ControlMapping,
  ControlStatus,
  Evidence,
  EvidenceLink,
  Exception,
  ExceptionLink,
  Policy,
  PolicyLink,
} from "../../lib/types";

export interface LinkedAppliedControl {
  appliedControl: AppliedControl;
  mapping: ControlMapping;
}

export interface LinkedEvidenceRecord {
  evidence: Evidence;
  link?: EvidenceLink;
  inheritedFrom?: AppliedControl;
  legacy?: boolean;
}

export interface LinkedPolicyRecord {
  policy: Policy;
  link: PolicyLink;
  inheritedFrom?: AppliedControl;
}

export interface LinkedExceptionRecord {
  exception: Exception;
  link?: ExceptionLink;
  inheritedFrom?: AppliedControl;
  legacy?: boolean;
}

interface ControlRowProps {
  ac: AssessmentControl;
  control: Control | undefined;
  evidence: Evidence[]; // evidence rows attached to this control on this assessment
  mappedAppliedControls?: LinkedAppliedControl[];
  linkedEvidence?: LinkedEvidenceRecord[];
  linkedPolicies?: LinkedPolicyRecord[];
  linkedExceptions?: LinkedExceptionRecord[];
  availableEvidence?: Evidence[];
  availableAppliedControls?: AppliedControl[];
  availablePolicies?: Policy[];
  availableExceptions?: Exception[];
  expanded: boolean;
  onToggle: () => void;
  onStatusChange: (status: ControlStatus) => void;
  onImplementationChange: (pct: number) => void;
  onNotesChange: (notes: string) => void;
  onCreateEvidence: (file?: File) => void;
  onAttachExistingEvidence?: (evidenceId: string) => Promise<void>;
  onDetachEvidence?: (linkId: string) => Promise<void>;
  onAttachPolicy?: (policyId: string) => Promise<void>;
  onAttachException?: (exceptionId: string) => Promise<void>;
  onDetachPolicy?: (linkId: string) => Promise<void>;
  onDetachException?: (linkId: string) => Promise<void>;
  onAttachAppliedControl?: (appliedControlId: string) => Promise<void>;
  onDetachAppliedControl?: (mappingId: string) => Promise<void>;
  onUnlinkEvidence: (evidenceId: string) => void;
  saving?: boolean;
  effectiveSourceLabel?: string;
  // Per-org override plumbing.
  appliedOrganizations?: string[] | null;
  orgNameById?: Map<string, string>;
  overrides?: AssessmentControlOverride[];
  onSetOverride?: (orgId: string, status: ControlStatus, notes?: string, implementationPercentage?: number) => Promise<void>;
  onClearOverride?: (overrideId: string) => Promise<void>;
  onUpdateOverrideNotes?: (overrideId: string, notes: string) => Promise<void>;
}

export default function ControlRow({
  ac,
  control,
  evidence,
  mappedAppliedControls = [],
  linkedEvidence = [],
  linkedPolicies = [],
  linkedExceptions = [],
  availableEvidence = [],
  availableAppliedControls = [],
  availablePolicies = [],
  availableExceptions = [],
  expanded,
  onToggle,
  onStatusChange,
  onImplementationChange,
  onNotesChange,
  onCreateEvidence,
  onAttachExistingEvidence,
  onDetachEvidence,
  onAttachPolicy,
  onAttachException,
  onDetachPolicy,
  onDetachException,
  onAttachAppliedControl,
  onDetachAppliedControl,
  onUnlinkEvidence,
  saving,
  effectiveSourceLabel,
  appliedOrganizations,
  orgNameById,
  overrides,
  onSetOverride,
  onClearOverride,
  onUpdateOverrideNotes,
}: ControlRowProps) {
  const [notes, setNotes] = useState<string>(ac.notes ?? "");
  const [linkingPolicy, setLinkingPolicy] = useState(false);
  const [linkingException, setLinkingException] = useState(false);
  const [linkingEvidence, setLinkingEvidence] = useState(false);
  const [linkingAppliedControl, setLinkingAppliedControl] = useState(false);
  const [evidenceDragOver, setEvidenceDragOver] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evidenceDragDepthRef = useRef(0);
  const lastSentRef = useRef<string>(ac.notes ?? "");

  // Sync if upstream value changes (e.g. refetch after workflow recompute).
  useEffect(() => {
    setNotes(ac.notes ?? "");
    lastSentRef.current = ac.notes ?? "";
  }, [ac.id, ac.notes]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const scheduleNotesSave = (next: string) => {
    setNotes(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (next !== lastSentRef.current) {
        lastSentRef.current = next;
        onNotesChange(next);
      }
    }, 500);
  };

  const flushNotesNow = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (notes !== lastSentRef.current) {
      lastSentRef.current = notes;
      onNotesChange(notes);
    }
  };

  const evidenceRecords: LinkedEvidenceRecord[] = [
    ...linkedEvidence,
    ...evidence
      .filter((ev) => !linkedEvidence.some((row) => row.evidence.id === ev.id))
      .map((ev) => ({ evidence: ev, legacy: true })),
  ];
  const inheritedPolicyIds = new Set(
    linkedPolicies.filter((row) => row.inheritedFrom).map((row) => row.policy.id),
  );
  const inheritedExceptionIds = new Set(
    linkedExceptions.filter((row) => row.inheritedFrom || row.legacy).map((row) => row.exception.id),
  );
  const directPolicies = linkedPolicies.filter((row) => !row.inheritedFrom);
  const directExceptions = linkedExceptions.filter((row) => !row.inheritedFrom && !row.legacy && row.link);
  const inheritedEvidenceIds = new Set(
    evidenceRecords.filter((row) => row.inheritedFrom || row.legacy).map((row) => row.evidence.id),
  );
  const directEvidence = evidenceRecords.filter((row) => !row.inheritedFrom && !row.legacy && row.link);
  const evidenceOptions = availableEvidence
    .filter((row) => !inheritedEvidenceIds.has(row.id))
    .map((row) => ({
      value: row.id,
      label: row.name,
      hint: row.url || row.notes_markdown ? "Evidence record" : "Attachment",
    }));
  const appliedControlOptions = availableAppliedControls.map((row) => ({
    value: row.id,
    label: row.name,
    hint: [formatLabel(row.status ?? "unknown"), formatLabel(row.control_type ?? "control")].join(" · "),
  }));
  const policyOptions = availablePolicies
    .filter((row) => !inheritedPolicyIds.has(row.id))
    .map((row) => ({ value: row.id, label: row.name, hint: formatLabel(row.status ?? "draft") }));
  const exceptionOptions = availableExceptions
    .filter((row) => !inheritedExceptionIds.has(row.id))
    .map((row) => ({
      value: row.id,
      label: row.name || row.reason,
      hint: formatLabel(row.status ?? "pending"),
    }));

  const togglePolicy = async (policyId: string, selected: boolean) => {
    setLinkingPolicy(true);
    try {
      if (selected) {
        await onAttachPolicy?.(policyId);
      } else {
        const row = directPolicies.find((candidate) => candidate.policy.id === policyId);
        if (row) await onDetachPolicy?.(row.link.id);
      }
    } finally {
      setLinkingPolicy(false);
    }
  };

  const toggleEvidence = async (evidenceId: string, selected: boolean) => {
    setLinkingEvidence(true);
    try {
      if (selected) {
        await onAttachExistingEvidence?.(evidenceId);
      } else {
        const row = directEvidence.find((candidate) => candidate.evidence.id === evidenceId);
        if (row?.link) await onDetachEvidence?.(row.link.id);
      }
    } finally {
      setLinkingEvidence(false);
    }
  };

  const toggleException = async (exceptionId: string, selected: boolean) => {
    setLinkingException(true);
    try {
      if (selected) {
        await onAttachException?.(exceptionId);
      } else {
        const row = directExceptions.find((candidate) => candidate.exception.id === exceptionId);
        if (row?.link) await onDetachException?.(row.link.id);
      }
    } finally {
      setLinkingException(false);
    }
  };

  const toggleAppliedControl = async (appliedControlId: string, selected: boolean) => {
    setLinkingAppliedControl(true);
    try {
      if (selected) {
        await onAttachAppliedControl?.(appliedControlId);
      } else {
        const row = mappedAppliedControls.find(
          (candidate) => candidate.appliedControl.id === appliedControlId,
        );
        if (row) await onDetachAppliedControl?.(row.mapping.id);
      }
    } finally {
      setLinkingAppliedControl(false);
    }
  };

  return (
    <div
      className={`cv-assessment-control cv-assessment-control--${ac.status ?? "not_assessed"}`}
      data-expanded={expanded ? "true" : "false"}
      title={`Status: ${formatLabel(ac.status ?? "not_assessed")}`}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        evidenceDragDepthRef.current += 1;
        setEvidenceDragOver(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        evidenceDragDepthRef.current = Math.max(0, evidenceDragDepthRef.current - 1);
        if (evidenceDragDepthRef.current === 0) setEvidenceDragOver(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        evidenceDragDepthRef.current = 0;
        setEvidenceDragOver(false);
        onCreateEvidence(event.dataTransfer.files[0]);
      }}
    >
      <div className="cv-assessment-control__summary">
        <button
          type="button"
          className="cv-assessment-control__toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="cv-assessment-control__chevron" aria-hidden="true">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <span className="cv-chip cv-chip--mono cv-chip--neutral" style={{ flexShrink: 0 }}>
            {control?.control_id ?? "—"}
          </span>
          <div className="cv-assessment-control__identity">
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: "var(--cv-fg-1)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {control?.title ?? "Control"}
              </span>
              {overrides && overrides.length > 0 ? (
                <span
                  className="cv-chip cv-chip--neutral"
                  style={{ fontSize: 11, flexShrink: 0 }}
                  title={`${overrides.length} per-org exception${overrides.length === 1 ? "" : "s"}`}
                >
                  {overrides.length} {overrides.length === 1 ? "exception" : "exceptions"}
                </span>
              ) : null}
              {effectiveSourceLabel ? (
                <span className="cv-chip cv-chip--teal" style={{ fontSize: 10, flexShrink: 0 }}>
                  {effectiveSourceLabel}
                </span>
              ) : null}
            </div>
            {!expanded && ac.notes ? (
              <div
                className="cv-small"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  marginTop: 2,
                }}
              >
                {ac.notes}
              </div>
            ) : null}
          </div>
        </button>
        <div className="cv-assessment-control__inline-status">
          <StatusSegmented value={ac.status} onChange={onStatusChange} disabled={saving} />
        </div>
      </div>

      {expanded ? (
        <div className="cv-assessment-control__details">
          {control?.description ? (
            <div className="cv-assessment-control__description">
              {control.description}
            </div>
          ) : null}

          <div className="cv-assessment-control__evaluation">
            <div>
              <div className="cv-section-label" style={{ marginBottom: 4 }}>
                Implementation
              </div>
              <ImplementationSlider
                value={ac.implementation_percentage}
                onCommit={onImplementationChange}
                disabled={saving}
              />
            </div>
          </div>

          <div className="cv-assessment-control__notes">
            <div className="cv-section-label" style={{ marginBottom: 6 }}>
              Notes
            </div>
            <textarea
              className="cv-field"
              value={notes}
              onChange={(e) => scheduleNotesSave(e.target.value)}
              onBlur={flushNotesNow}
              placeholder="Implementation details, gaps, evidence pointers…"
              rows={3}
            />
          </div>

          {(() => {
            // Only render the org-specific section when there's actually
            // something to diverge against — multiple orgs in scope, or
            // perpetual "all orgs". Single-org assessments skip it entirely.
            const shouldShow =
              orgNameById &&
              onSetOverride &&
              onClearOverride &&
              onUpdateOverrideNotes &&
              (appliedOrganizations == null || appliedOrganizations.length > 1);
            if (!shouldShow) return null;
            return (
              <div className="cv-assessment-control__overrides">
                <div className="cv-section-label" style={{ marginBottom: 6 }}>
                  Org-specific status
                </div>
                <OverridesPanel
                  appliedOrganizations={appliedOrganizations}
                  orgNameById={orgNameById!}
                  defaultStatus={ac.status}
                  overrides={overrides ?? []}
                  onSetOverride={onSetOverride!}
                  onClearOverride={onClearOverride!}
                  onUpdateOverrideNotes={onUpdateOverrideNotes!}
                />
              </div>
            );
          })()}

          <div className="cv-assessment-control__relationships">
            <RelationshipSection
              title="Applied controls"
              icon={<ListChecks size={13} />}
              empty="No applied controls mapped."
              showRows={false}
              control={
                <MultiSelectDropdown
                  label="Applied controls mapped to this framework control"
                  options={appliedControlOptions}
                  selectedValues={mappedAppliedControls.map((row) => row.appliedControl.id)}
                  placeholder="Select applied controls…"
                  emptyText="No applied controls match."
                  hint="Updates the framework mapping used across assessments."
                  disabled={linkingAppliedControl}
                  onToggle={toggleAppliedControl}
                />
              }
              rows={mappedAppliedControls.map(({ appliedControl, mapping }) => ({
                id: mapping.id,
                label: appliedControl.name,
                meta: `${formatLabel(mapping.relationship)} · ${formatLabel(mapping.status ?? "imported")}`,
                tone: "neutral",
              }))}
            />

            <RelationshipSection
              title="Evidence"
              icon={<Paperclip size={13} />}
              empty="No evidence attached."
              control={
                <div className="cv-relationship-actions">
                  <MultiSelectDropdown
                    label="Evidence for this assessment control"
                    options={evidenceOptions}
                    selectedValues={directEvidence.map((row) => row.evidence.id)}
                    placeholder="Attach existing evidence…"
                    disabled={linkingEvidence}
                    onToggle={toggleEvidence}
                  />
                  <button
                    type="button"
                    className="cv-btn cv-btn--secondary cv-evidence-create"
                    onClick={() => onCreateEvidence()}
                    aria-label="Create evidence"
                    title="Create evidence"
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                </div>
              }
              rows={evidenceRecords.map((row) => ({
                id: row.link?.id ?? row.evidence.id,
                label: row.evidence.name,
                meta: row.inheritedFrom
                  ? `Inherited from ${row.inheritedFrom.name}`
                  : row.legacy
                  ? "Legacy direct link"
                  : formatLabel(row.link?.relationship ?? "supports"),
                tone: "teal",
                onRemove: row.legacy
                  ? () => onUnlinkEvidence(row.evidence.id)
                  : row.link && !row.inheritedFrom
                  ? () => onDetachEvidence?.(row.link!.id)
                  : undefined,
              }))}
            />

            <RelationshipSection
              title="Policies"
              icon={<FileText size={13} />}
              empty="No policies attached."
              control={onAttachPolicy ? (
                <MultiSelectDropdown
                  label="Policies for this assessment control"
                  options={policyOptions}
                  selectedValues={directPolicies.map((row) => row.policy.id)}
                  placeholder="Select policies…"
                  disabled={linkingPolicy}
                  onToggle={togglePolicy}
                />
              ) : undefined}
              rows={linkedPolicies.map((row) => ({
                id: row.link.id,
                label: row.policy.name,
                meta: row.inheritedFrom
                  ? `Inherited from ${row.inheritedFrom.name}`
                  : formatLabel(row.link.relationship ?? "supports"),
                tone: "gold",
              }))}
            />

            <RelationshipSection
              title="Exceptions"
              icon={<AlertTriangle size={13} />}
              empty="No GRC exceptions attached."
              control={onAttachException ? (
                <MultiSelectDropdown
                  label="Exceptions for this assessment control"
                  options={exceptionOptions}
                  selectedValues={directExceptions.map((row) => row.exception.id)}
                  placeholder="Select exceptions…"
                  disabled={linkingException}
                  onToggle={toggleException}
                />
              ) : undefined}
              rows={linkedExceptions.map((row) => ({
                id: row.link?.id ?? row.exception.id,
                label: row.exception.name || row.exception.reason,
                meta: row.inheritedFrom
                  ? `Inherited from ${row.inheritedFrom.name}`
                  : row.legacy
                  ? "Direct framework control exception"
                  : formatLabel(row.link?.relationship ?? "documents_gap"),
                tone: "red",
              }))}
            />
          </div>
        </div>
      ) : null}
      {evidenceDragOver ? (
        <div className="cv-assessment-control__drop-overlay" role="status">
          <Upload size={22} aria-hidden="true" />
          <strong>Drop to create evidence</strong>
          <span>{control?.control_id ?? "Control"} · {control?.title ?? "Assessment control"}</span>
        </div>
      ) : null}
    </div>
  );
}

function formatLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface RelationshipRow {
  id: string;
  label: string;
  meta?: string | null;
  tone: "neutral" | "teal" | "gold" | "red";
  onRemove?: () => void;
  actionLabel?: string;
  onAction?: () => void;
}

function RelationshipRows({
  rows,
  presentation,
  title,
}: {
  rows: RelationshipRow[];
  presentation: "chips" | "list";
  title: string;
}) {
  return (
    <div className={presentation === "list" ? "cv-relationship-list" : "cv-relationship-chips"}>
      {rows.map((row) => (
        presentation === "list" ? (
          <div key={row.id} className="cv-relationship-list__row">
            <div className="cv-relationship-list__content">
              <strong>{row.label}</strong>
              {row.meta ? <span>{row.meta}</span> : null}
            </div>
            {row.onAction && row.actionLabel ? (
              <button
                type="button"
                className="cv-btn cv-btn--secondary cv-btn--sm"
                onClick={row.onAction}
              >
                {row.actionLabel}
              </button>
            ) : null}
          </div>
        ) : (
          <span
            key={row.id}
            className={`cv-chip cv-chip--${row.tone}`}
            style={{ paddingRight: row.onRemove ? 4 : undefined, gap: 4, maxWidth: "100%" }}
            title={row.meta ?? undefined}
          >
            <span style={{ textTransform: "none", letterSpacing: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {row.label}
            </span>
            {row.meta ? (
              <span style={{ opacity: 0.72, textTransform: "none", letterSpacing: 0 }}>
                ({row.meta})
              </span>
            ) : null}
            {row.onRemove ? (
              <button
                type="button"
                onClick={row.onRemove}
                className="cv-relationship-chip__remove"
                aria-label={`Remove ${title.toLowerCase()} link`}
              >
                <X size={12} />
              </button>
            ) : null}
          </span>
        )
      ))}
    </div>
  );
}

const RELATIONSHIP_PREVIEW_LIMIT = 3;

function RelationshipSection({
  className,
  presentation = "chips",
  title,
  icon,
  empty,
  rows,
  control,
  showRows = true,
}: {
  className?: string;
  presentation?: "chips" | "list";
  title: string;
  icon: any;
  empty: string;
  rows: RelationshipRow[];
  control?: any;
  showRows?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const dialogTitleId = useId();
  const previewRows = rows.slice(0, RELATIONSHIP_PREVIEW_LIMIT);

  return (
    <section className={`cv-relationship-section${className ? ` ${className}` : ""}`}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div className="cv-section-label" style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
          {icon}
          {title}
          <span className="cv-chip cv-chip--neutral cv-chip--mono">{rows.length}</span>
        </div>
      </div>
      {showRows && rows.length === 0 ? (
        <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
          {empty}
        </div>
      ) : showRows ? (
        <RelationshipRows rows={previewRows} presentation={presentation} title={title} />
      ) : null}
      {showRows && rows.length > RELATIONSHIP_PREVIEW_LIMIT ? (
        <button
          type="button"
          className="cv-relationship-section__view-all"
          onClick={() => setShowAll(true)}
        >
          View all {rows.length}
        </button>
      ) : null}
      {control ? <div style={{ marginTop: 8 }}>{control}</div> : null}
      {showAll ? (
        <BifrostDialogFrame
          onDismiss={() => setShowAll(false)}
          labelledBy={dialogTitleId}
          style={{ width: "min(680px, calc(100vw - 32px))" }}
        >
          <div className="cv-dialog__header">
            <h2 id={dialogTitleId} className="cv-dialog__title">{title}</h2>
            <div className="cv-small" style={{ marginTop: 4 }}>{rows.length} linked records</div>
          </div>
          <div className="cv-dialog__body">
            <RelationshipRows rows={rows} presentation={presentation} title={title} />
          </div>
          <div className="cv-dialog__footer">
            <button
              type="button"
              className="cv-btn cv-btn--secondary cv-btn--sm"
              onClick={() => setShowAll(false)}
            >
              Close
            </button>
          </div>
        </BifrostDialogFrame>
      ) : null}
    </section>
  );
}
