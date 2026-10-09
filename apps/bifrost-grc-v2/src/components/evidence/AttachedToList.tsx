import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";

import { AlertTriangle, BookOpen, ClipboardCheck, FileText, Link2, ScrollText, Shield, Trash2, Icon } from "lucide-react";

import {
  TABLE_APPLIED_CONTROLS,
  TABLE_ASSESSMENT_CONTROLS,
  TABLE_ASSESSMENTS,
  TABLE_CONTROLS,
  TABLE_EVIDENCE_LINKS,
  TABLE_EXCEPTIONS,
  TABLE_FRAMEWORKS,
  TABLE_POLICIES,
  TABLE_QUESTIONNAIRE_ITEMS,
  TABLE_QUESTIONNAIRE_RESPONSES,
  TABLE_QUESTIONNAIRES,
  TABLE_RISKS,
  TABLE_SOURCE_DOCUMENTS,
} from "../../lib/grc-tables";
import { getRow } from "../../lib/table-helpers";
import { confirm } from "../shared/ConfirmDialog";
import type {
  AppliedControl,
  Assessment,
  AssessmentControl,
  Control,
  EvidenceLink,
  Exception,
  Framework,
  GrcLinkTarget,
  Policy,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
  Risk,
  SourceDocument,
} from "../../lib/types";

interface AttachedToListProps {
  evidenceId?: string | null;
  assessmentId?: string | null;
  controlId?: string | null;
}

function labelize(value?: string | null): string {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function AttachedToList({ evidenceId, assessmentId, controlId }: AttachedToListProps) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [control, setControl] = useState<Control | null>(null);
  const [framework, setFramework] = useState<Framework | null>(null);
  const [loading, setLoading] = useState(false);
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);

  // Fetch the link set once and filter locally. The live subscription filter
  // has returned incomplete snapshots for evidence_id equality in production,
  // while the unfiltered snapshot is consistent with list-page counts.
  const { rows: allEvidenceLinks } = useTable<EvidenceLink>(TABLE_EVIDENCE_LINKS, {
    pageSize: 1000,
  });
  const evidenceLinks = useMemo(
    () => (allEvidenceLinks ?? []).filter((link) => Boolean(evidenceId) && link.evidence_id === evidenceId),
    [allEvidenceLinks, evidenceId],
  );
  const { rows: appliedControls } = useTable<AppliedControl>(TABLE_APPLIED_CONTROLS, { pageSize: 1000 });
  const { rows: controls } = useTable<Control>(TABLE_CONTROLS, { pageSize: 1000 });
  const { rows: assessmentControls } = useTable<AssessmentControl>(TABLE_ASSESSMENT_CONTROLS, { pageSize: 1000 });
  const { rows: assessments } = useTable<Assessment>(TABLE_ASSESSMENTS, { pageSize: 1000 });
  const { rows: policies } = useTable<Policy>(TABLE_POLICIES, { pageSize: 1000 });
  const { rows: exceptions } = useTable<Exception>(TABLE_EXCEPTIONS, { pageSize: 1000 });
  const { rows: risks } = useTable<Risk>(TABLE_RISKS, { pageSize: 1000 });
  const { rows: sources } = useTable<SourceDocument>(TABLE_SOURCE_DOCUMENTS, { pageSize: 1000 });
  const { rows: questionnaires } = useTable<Questionnaire>(TABLE_QUESTIONNAIRES, { pageSize: 1000 });
  const { rows: questionnaireItems } = useTable<QuestionnaireItem>(TABLE_QUESTIONNAIRE_ITEMS, { pageSize: 1000 });
  const { rows: questionnaireResponses } = useTable<QuestionnaireResponse>(TABLE_QUESTIONNAIRE_RESPONSES, { pageSize: 1000 });

  const maps = useMemo(() => {
    const byId = <T extends { id: string }>(rows?: T[] | null) => {
      const m = new Map<string, T>();
      (rows ?? []).forEach((row) => m.set(row.id, row));
      return m;
    };
    return {
      applied: byId(appliedControls),
      controls: byId(controls),
      assessmentControls: byId(assessmentControls),
      assessments: byId(assessments),
      policies: byId(policies),
      exceptions: byId(exceptions),
      risks: byId(risks),
      sources: byId(sources),
      questionnaires: byId(questionnaires),
      questionnaireItems: byId(questionnaireItems),
      questionnaireResponses: byId(questionnaireResponses),
    };
  }, [
    appliedControls,
    assessmentControls,
    assessments,
    controls,
    exceptions,
    policies,
    questionnaireItems,
    questionnaireResponses,
    questionnaires,
    risks,
    sources,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!assessmentId && !controlId) {
      setAssessment(null);
      setControl(null);
      setFramework(null);
      return;
    }
    setLoading(true);
    const work = async () => {
      try {
        if (assessmentId) {
          const a = await getRow<Assessment>(TABLE_ASSESSMENTS, assessmentId);
          if (!cancelled) setAssessment(a ?? null);
        } else {
          setAssessment(null);
        }
        if (controlId) {
          const c = await getRow<Control>(TABLE_CONTROLS, controlId);
          if (!cancelled) setControl(c ?? null);
          if (c?.framework_id) {
            const f = await getRow<Framework>(TABLE_FRAMEWORKS, c.framework_id);
            if (!cancelled) setFramework(f ?? null);
          }
        } else {
          setControl(null);
          setFramework(null);
        }
      } catch {
        // Soft fail — show "not attached" rather than blowing up the detail page.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    work();
    return () => {
      cancelled = true;
    };
  }, [assessmentId, controlId]);

  const linkedRows = useMemo(() => {
    return (evidenceLinks ?? []).map((link) => resolveEvidenceLink(link, maps));
  }, [evidenceLinks, maps]);

  const detachLink = async (link: EvidenceLink) => {
    const ok = await confirm({
      title: "Detach evidence?",
      body: "The evidence record will remain in the catalog; only this reusable attachment will be removed.",
      confirmLabel: "Detach",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    setDeletingLinkId(link.id);
    try {
      await tables.delete(TABLE_EVIDENCE_LINKS, link.id);
      toast.success("Evidence detached");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to detach evidence");
    } finally {
      setDeletingLinkId(null);
    }
  };

  if (!assessmentId && !controlId && linkedRows.length === 0) {
    return (
      <div className="cv-small" style={{ padding: "4px 2px" }}>
        Not attached to any GRC records.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="cv-small" style={{ padding: "4px 2px" }}>
        Loading attachments…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {linkedRows.map(({ link, icon: Icon, label, meta, href }) => (
        <div
          key={link.id}
          className="cv-card cv-card--pad-sm"
          style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}
        >
          <Link
            to={href}
            className="cv-card--hover"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
              color: "inherit",
              minWidth: 0,
            }}
          >
            <div className="cv-stat-tile__icon cv-stat-tile__icon--teal" style={{ width: 30, height: 30 }}>
              <Icon size={15} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
                {labelize(link.target_type)}{link.relationship ? ` / ${link.relationship}` : ""}
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--cv-fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label}
              </div>
              {meta ? <div className="cv-small" style={{ marginTop: 2 }}>{meta}</div> : null}
            </div>
          </Link>
          <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => detachLink(link)} disabled={deletingLinkId === link.id} aria-label={`Detach ${label}`}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      {assessmentId ? (
        <Link
          to={`/assessments/${assessmentId}`}
          className="cv-card cv-card--hover cv-card--pad-sm"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <div className="cv-stat-tile__icon cv-stat-tile__icon--purple" style={{ width: 30, height: 30 }}>
            <ClipboardCheck size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>Assessment</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--cv-fg-1)" }}>
              {assessment?.name ?? "(deleted assessment)"}
            </div>
          </div>
        </Link>
      ) : null}

      {controlId ? (
        <Link
          to={framework?.id ? `/frameworks/${framework.id}` : "/controls"}
          className="cv-card cv-card--hover cv-card--pad-sm"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <div className="cv-stat-tile__icon" style={{ width: 30, height: 30 }}>
            <Shield size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>Control</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--cv-fg-1)" }}>
              {control
                ? `${control.control_id ?? ""} ${control.title ?? ""}`.trim() || "(unnamed control)"
                : "(deleted control)"}
            </div>
            {framework ? (
              <div className="cv-small" style={{ marginTop: 2, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <BookOpen size={11} />
                {framework.name}
              </div>
            ) : null}
          </div>
        </Link>
      ) : null}
    </div>
  );
}

function resolveEvidenceLink(
  link: EvidenceLink,
  maps: {
    applied: Map<string, AppliedControl>;
    controls: Map<string, Control>;
    assessmentControls: Map<string, AssessmentControl>;
    assessments: Map<string, Assessment>;
    policies: Map<string, Policy>;
    exceptions: Map<string, Exception>;
    risks: Map<string, Risk>;
    sources: Map<string, SourceDocument>;
    questionnaires: Map<string, Questionnaire>;
    questionnaireItems: Map<string, QuestionnaireItem>;
    questionnaireResponses: Map<string, QuestionnaireResponse>;
  },
) {
  const targetType = link.target_type as GrcLinkTarget;
  switch (targetType) {
    case "applied_control": {
      const row = maps.applied.get(link.target_id);
      return {
        link,
        icon: Shield,
        href: `/applied-controls/${link.target_id}`,
        label: row?.name ?? link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    case "control": {
      const row = maps.controls.get(link.target_id);
      return {
        link,
        icon: Shield,
        href: "/controls",
        label: row ? `${row.control_id} ${row.title}`.trim() : link.target_id,
        meta: null,
      };
    }
    case "assessment_control": {
      const row = maps.assessmentControls.get(link.target_id);
      const control = row?.control_id ? maps.controls.get(row.control_id) : undefined;
      return {
        link,
        icon: ClipboardCheck,
        href: row?.assessment_id ? `/assessments/${row.assessment_id}` : "/assessments",
        label: control ? `${control.control_id} ${control.title}`.trim() : link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    case "assessment": {
      const row = maps.assessments.get(link.target_id);
      return {
        link,
        icon: ClipboardCheck,
        href: `/assessments/${link.target_id}`,
        label: row?.name ?? link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    case "policy": {
      const row = maps.policies.get(link.target_id);
      return {
        link,
        icon: FileText,
        href: `/policies/${link.target_id}`,
        label: row?.name ?? link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    case "exception": {
      const row = maps.exceptions.get(link.target_id);
      return {
        link,
        icon: AlertTriangle,
        href: `/exceptions/${link.target_id}`,
        label: row?.reason ?? link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    case "risk": {
      const row = maps.risks.get(link.target_id);
      return {
        link,
        icon: AlertTriangle,
        href: `/risks/${link.target_id}`,
        label: row?.name ?? link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    case "source_document": {
      const row = maps.sources.get(link.target_id);
      return {
        link,
        icon: ScrollText,
        href: `/source-documents/${link.target_id}`,
        label: row?.name ?? row?.file_name ?? link.target_id,
        meta: row?.document_type ? labelize(row.document_type) : null,
      };
    }
    case "questionnaire_item": {
      const row = maps.questionnaireItems.get(link.target_id);
      return {
        link,
        icon: FileText,
        href: row?.questionnaire_id ? `/questionnaires/${row.questionnaire_id}` : "/questionnaires",
        label: row?.question_text ?? link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    case "questionnaire_response": {
      const row = maps.questionnaireResponses.get(link.target_id);
      return {
        link,
        icon: FileText,
        href: row?.questionnaire_id ? `/questionnaires/${row.questionnaire_id}` : "/questionnaires",
        label: row?.final_answer || row?.draft_answer || link.target_id,
        meta: row?.status ? labelize(row.status) : null,
      };
    }
    default: {
      const row = maps.questionnaires.get(link.target_id);
      return {
        link,
        icon: Link2,
        href: row ? `/questionnaires/${row.id}` : "/evidence",
        label: row?.name ?? link.target_id,
        meta: targetType,
      };
    }
  }
}
