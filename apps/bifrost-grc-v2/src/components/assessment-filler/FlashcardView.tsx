import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../../lib/app-state";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Paperclip, X, SkipForward } from "lucide-react";
import StatusSegmented from "./StatusSegmented";
import ImplementationSlider from "./ImplementationSlider";
import type {
  AssessmentControl,
  Control,
  ControlStatus,
  Domain,
  Evidence,
} from "../../lib/types";

interface FlashcardViewProps {
  assessmentId: string;
  assessmentName?: string;
  acRows: AssessmentControl[]; // already domain/sort-order ordered
  controlById: Map<string, Control>;
  domainById: Map<string, Domain>;
  evidenceByControl: Map<string, Evidence[]>;
  onStatusChange: (ac: AssessmentControl, status: ControlStatus) => void;
  onImplementationChange: (ac: AssessmentControl, pct: number) => void;
  onNotesChange: (ac: AssessmentControl, notes: string) => void;
  onAttachEvidence: (ac: AssessmentControl) => void;
  onUnlinkEvidence: (evidenceId: string) => void;
  onClose?: () => void;
}

export default function FlashcardView({
  assessmentId,
  assessmentName,
  acRows,
  controlById,
  domainById,
  evidenceByControl,
  onStatusChange,
  onImplementationChange,
  onNotesChange,
  onAttachEvidence,
  onUnlinkEvidence,
  onClose,
}: FlashcardViewProps) {
  const [index, setIndex] = useAppState<number>(`flashcard-${assessmentId}`, 0);
  const safeIndex = Math.max(0, Math.min(acRows.length - 1, index ?? 0));
  const [showGuidance, setShowGuidance] = useState(false);

  const current = acRows[safeIndex];
  const control = current ? controlById.get(current.control_id) : undefined;
  const domain = control?.domain_id ? domainById.get(control.domain_id) : undefined;
  const evList = current ? evidenceByControl.get(current.control_id) ?? [] : [];

  // Notes draft state (autosave on blur, 500ms debounce)
  const [notes, setNotes] = useState<string>(current?.notes ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef<string>(current?.notes ?? "");

  useEffect(() => {
    setNotes(current?.notes ?? "");
    lastSentRef.current = current?.notes ?? "";
    setShowGuidance(false);
  }, [current?.id, current?.notes]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const scheduleNotesSave = (next: string) => {
    setNotes(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (current && next !== lastSentRef.current) {
        lastSentRef.current = next;
        onNotesChange(current, next);
      }
    }, 500);
  };

  const flushNotesNow = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (current && notes !== lastSentRef.current) {
      lastSentRef.current = notes;
      onNotesChange(current, notes);
    }
  };

  const goPrev = () => {
    flushNotesNow();
    setIndex(Math.max(0, safeIndex - 1));
  };
  const goNext = () => {
    flushNotesNow();
    setIndex(Math.min(acRows.length - 1, safeIndex + 1));
  };
  const goNextPending = () => {
    flushNotesNow();
    const i = acRows.findIndex(
      (ac, idx) => idx > safeIndex && (ac.status ?? "not_assessed") === "not_assessed",
    );
    if (i >= 0) setIndex(i);
    else {
      // wrap from start
      const j = acRows.findIndex((ac) => (ac.status ?? "not_assessed") === "not_assessed");
      if (j >= 0) setIndex(j);
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        flushNotesNow();
        onClose();
      } else if (e.key === "ArrowLeft" || key === "j") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight" || key === "k") {
        e.preventDefault();
        goNext();
      } else if (key === "c" && current) {
        e.preventDefault();
        onStatusChange(current, "compliant");
      } else if (key === "p" && current) {
        e.preventDefault();
        onStatusChange(current, "partially_compliant");
      } else if (key === "n" && current) {
        e.preventDefault();
        onStatusChange(current, "non_compliant");
      } else if (key === "x" && current) {
        e.preventDefault();
        onStatusChange(current, "not_assessed");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeIndex, acRows.length]);

  // Touched count for progress strip (any non-not_assessed OR has notes OR has impl_pct > 0)
  const touchedCount = useMemo(() => {
    return acRows.filter((ac) => {
      if ((ac.status ?? "not_assessed") !== "not_assessed") return true;
      if (ac.notes && ac.notes.trim().length > 0) return true;
      if ((ac.implementation_percentage ?? 0) > 0) return true;
      return false;
    }).length;
  }, [acRows]);

  if (acRows.length === 0 || !current) {
    return (
      <div className="cv-card" style={{ padding: 32, textAlign: "center" }}>
        <div className="cv-body" style={{ color: "var(--cv-fg-3)" }}>
          No controls to walk through.
        </div>
      </div>
    );
  }

  const touchedPct = acRows.length > 0 ? Math.round((touchedCount / acRows.length) * 100) : 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        gap: 16,
        minHeight: 0,
        height: "100%",
        padding: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div className="cv-small" style={{ marginBottom: 2 }}>
            {assessmentName ?? "Assessment"}
          </div>
          <div className="cv-h2">Flashcards</div>
        </div>
        <button
          type="button"
          className="cv-btn cv-btn--secondary cv-btn--sm"
          onClick={() => {
            flushNotesNow();
            onClose?.();
          }}
        >
          <X size={13} /> Close
        </button>
      </div>
      {/* Card */}
      <div
        className="cv-card"
        style={{
          padding: 28,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          maxWidth: 1040,
          margin: "0 auto",
          width: "100%",
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        {/* Header: control_id chip + crumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span
            className="cv-chip cv-chip--mono cv-chip--neutral"
            style={{ fontSize: 14, padding: "4px 10px" }}
          >
            {control?.control_id ?? "—"}
          </span>
          {domain ? (
            <span className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
              {domain.name}
            </span>
          ) : null}
        </div>

        {/* Title */}
        <h1
          style={{
            fontSize: 26,
            fontWeight: 600,
            lineHeight: 1.25,
            color: "var(--cv-fg-1)",
            margin: 0,
          }}
        >
          {control?.title ?? "Control"}
        </h1>

        {/* Description */}
        {control?.description ? (
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.6,
              color: "var(--cv-fg-2)",
            }}
          >
            {control.description}
          </div>
        ) : null}

        {/* Guidance (collapsible) */}
        {control?.guidance ? (
          <div>
            <button
              type="button"
              className="cv-btn cv-btn--ghost cv-btn--sm"
              onClick={() => setShowGuidance((v) => !v)}
              style={{ paddingLeft: 0 }}
            >
              {showGuidance ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              Guidance
            </button>
            {showGuidance ? (
              <div
                className="cv-callout cv-callout--note"
                style={{ marginTop: 6, whiteSpace: "pre-wrap" }}
              >
                <div className="cv-callout__body">{control.guidance}</div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Status segmented (large) */}
        <div>
          <div className="cv-section-label" style={{ marginBottom: 6 }}>
            Status
          </div>
          <div style={{ fontSize: 14 }}>
            <StatusSegmented
              value={current.status}
              onChange={(s) => onStatusChange(current, s)}
              fullWidth
            />
          </div>
        </div>

        {/* Implementation */}
        <div>
          <div className="cv-section-label" style={{ marginBottom: 4 }}>
            Implementation
          </div>
          <ImplementationSlider
            value={current.implementation_percentage}
            onCommit={(pct) => onImplementationChange(current, pct)}
          />
        </div>

        {/* Notes */}
        <div>
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

        {/* Evidence */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <div className="cv-section-label" style={{ margin: 0 }}>
              Evidence
            </div>
            <button
              type="button"
              className="cv-btn cv-btn--ghost cv-btn--sm"
              onClick={() => onAttachEvidence(current)}
            >
              <Paperclip size={13} />
              Attach
            </button>
          </div>
          {evList.length === 0 ? (
            <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
              No evidence attached.
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {evList.map((ev) => (
                <span
                  key={ev.id}
                  className="cv-chip cv-chip--teal"
                  style={{ paddingRight: 4, gap: 4 }}
                >
                  <span style={{ textTransform: "none", letterSpacing: 0 }}>{ev.name}</span>
                  <button
                    type="button"
                    onClick={() => onUnlinkEvidence(ev.id)}
                    style={{
                      background: "transparent",
                      border: 0,
                      color: "inherit",
                      cursor: "pointer",
                      display: "inline-flex",
                      padding: 0,
                    }}
                    aria-label="Unlink evidence"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Nav controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="cv-btn cv-btn--secondary cv-btn--sm"
          onClick={goPrev}
          disabled={safeIndex === 0}
        >
          <ArrowLeft size={13} /> Previous
        </button>
        <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          onClick={goNext}
          disabled={safeIndex >= acRows.length - 1}
        >
          Skip
        </button>
        <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          onClick={goNextPending}
        >
          <SkipForward size={13} /> Next pending
        </button>
        <button
          type="button"
          className="cv-btn cv-btn--primary cv-btn--sm"
          onClick={goNext}
          disabled={safeIndex >= acRows.length - 1}
        >
          Next <ArrowRight size={13} />
        </button>
      </div>

      {/* Progress strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          background: "var(--cv-bg-2)",
          border: "1px solid var(--cv-border)",
          borderRadius: "var(--cv-r-md)",
        }}
      >
        <div className="cv-small" style={{ minWidth: 200 }}>
          Control {safeIndex + 1} of {acRows.length}
          {domain ? ` · ${domain.name}` : ""}
        </div>
        <div style={{ flex: 1 }}>
          <div className="cv-meter" style={{ height: 4 }}>
            <div
              className="cv-meter__fill cv-meter__fill--teal"
              style={{ width: `${touchedPct}%` }}
            />
          </div>
        </div>
        <div className="cv-mono cv-small" style={{ minWidth: 60, textAlign: "right" }}>
          {touchedCount}/{acRows.length} touched
        </div>
      </div>
    </div>
  );
}
