import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable } from "bifrost";
import { Input } from "@/components/ui/input";

import { AlertCircle, ChevronRight, ClipboardList, Loader2, Plus, Search, Upload, X } from "lucide-react";

import EmptyState from "../../components/shared/EmptyState";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import FileUpload, { type UploadedFile } from "../../components/shared/FileUpload";
import OrgPicker from "../../components/shared/OrgPicker";
import PageHeader from "../../components/shared/PageHeader";
import ThemedSelect from "../../components/shared/ThemedSelect";
import BifrostDialogFrame from "../../components/shared/BifrostDialogFrame";
import {
  TABLE_QUESTIONNAIRE_ITEMS,
  TABLE_QUESTIONNAIRE_RESPONSES,
  TABLE_QUESTIONNAIRES,
  TABLE_SOURCE_DOCUMENTS,
} from "../../lib/grc-tables";
import { useOrgNamesMap } from "../../lib/directory";
import { useOrganizationView } from "../../lib/organization-view";
import { useGrcPermissions } from "../../lib/current-user";
import type { Questionnaire, QuestionnaireItem, QuestionnaireResponse, QuestionnaireStatus, SourceDocument } from "../../lib/types";

type StatusFilter = "all" | QuestionnaireStatus;

const STATUS_OPTIONS: Array<{ label: string; value: QuestionnaireStatus }> = [
  { label: "Draft", value: "draft" },
  { label: "Extracting", value: "extracting" },
  { label: "Answering", value: "answering" },
  { label: "Needs review", value: "needs_review" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
];

function labelize(value?: string | null): string {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusTone(status?: string | null): string {
  if (status === "completed") return "cv-chip--green";
  if (status === "needs_review" || status === "answering" || status === "extracting") return "cv-chip--gold";
  if (status === "failed") return "cv-chip--red";
  return "cv-chip--neutral";
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "-";
  }
}

export default function QuestionnairesPage() {
  const { canEdit } = useGrcPermissions();
  const navigate = useNavigate();
  const orgNameById = useOrgNamesMap();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { organizationId } = useOrganizationView();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [draft, setDraft] = useState({
    organization_id: null as string | null,
    name: "",
    carrier: "",
  });

  const { rows: questionnaireRows, loading, error } = useTable<Questionnaire>(TABLE_QUESTIONNAIRES, {
    pageSize: 1000,
    order_by: "updated_at",
    order_dir: "desc",
  });
  const { rows: sourceDocuments } = useTable<SourceDocument>(TABLE_SOURCE_DOCUMENTS, { pageSize: 1000 });
  const { rows: items } = useTable<QuestionnaireItem>(TABLE_QUESTIONNAIRE_ITEMS, { pageSize: 1000 });
  const { rows: responses } = useTable<QuestionnaireResponse>(TABLE_QUESTIONNAIRE_RESPONSES, { pageSize: 1000 });

  const sourceById = useMemo(() => {
    const map = new Map<string, SourceDocument>();
    (sourceDocuments ?? []).forEach((row) => map.set(row.id, row));
    return map;
  }, [sourceDocuments]);

  const countsByQuestionnaire = useMemo(() => {
    const map = new Map<string, { questions: number; accepted: number; needsReview: number }>();
    const ensure = (id: string) => {
      const current = map.get(id);
      if (current) return current;
      const next = { questions: 0, accepted: 0, needsReview: 0 };
      map.set(id, next);
      return next;
    };
    (items ?? []).forEach((row) => {
      ensure(row.questionnaire_id).questions += 1;
    });
    (responses ?? []).forEach((row) => {
      const c = ensure(row.questionnaire_id);
      if (row.status === "accepted" || row.status === "applied") c.accepted += 1;
      if (row.status === "needs_review" || row.status === "draft") c.needsReview += 1;
    });
    return map;
  }, [items, responses]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (questionnaireRows ?? []).filter((row) => {
      if (organizationId && row.organization_id !== organizationId) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!q) return true;
      const source = row.source_document_id ? sourceById.get(row.source_document_id) : null;
      return (
        (row.name ?? "").toLowerCase().includes(q) ||
        (row.carrier ?? "").toLowerCase().includes(q) ||
        (source?.file_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [organizationId, questionnaireRows, search, sourceById, statusFilter]);

  const onUploaded = (file: UploadedFile) => {
    setUploaded(file);
    if (!draft.name.trim()) {
      setDraft((d) => ({ ...d, name: file.name.replace(/\.[^.]+$/, "") }));
    }
  };

  const createQuestionnaire = async () => {
    if (!draft.organization_id) {
      toast.error("Organization is required");
      return;
    }
    if (!draft.name.trim()) {
      toast.error("Questionnaire name is required");
      return;
    }
    if (!uploaded) {
      toast.error("Upload a PDF or Word document first");
      return;
    }
    setCreating(true);
    try {
      const source = await tables.insert(TABLE_SOURCE_DOCUMENTS, {
        organization_id: draft.organization_id,
        name: draft.name.trim(),
        document_type: "questionnaire",
        file_name: uploaded.name,
        file_path: uploaded.path,
        mime_type: uploaded.contentType,
        metadata_json: JSON.stringify({ size_bytes: uploaded.sizeBytes }),
      });
      const questionnaire = await tables.insert(TABLE_QUESTIONNAIRES, {
        organization_id: draft.organization_id,
        name: draft.name.trim(),
        source_document_id: source.id,
        carrier: draft.carrier.trim() || null,
        status: "draft",
      });
      toast.success("Questionnaire created");
      navigate(`/questionnaires/${questionnaire.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create questionnaire");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <PageHeader
        title="Questionnaires"
        subtitle="Source documents, extracted questions, structured answers, and GRC links for customer questionnaires."
        actions={canEdit ? (
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />
            New questionnaire
          </button>
        ) : undefined}
      />

      {canEdit && createOpen ? (
        <BifrostDialogFrame
          onDismiss={() => setCreateOpen(false)}
          dismissDisabled={creating}
          labelledBy="new-questionnaire-title"
          style={{ width: "min(560px, calc(100vw - 32px))" }}
        >
            <div className="cv-dialog__header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 id="new-questionnaire-title" className="cv-dialog__title">New questionnaire</h2>
                <p id="new-questionnaire-description" className="cv-small" style={{ margin: "4px 0 0" }}>
                  Upload the customer form and set the organization that owns the response.
                </p>
              </div>
              <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => setCreateOpen(false)} disabled={creating} style={{ padding: 4 }} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <OrgPicker
                value={draft.organization_id}
                onChange={(organization_id) => setDraft((d) => ({ ...d, organization_id }))}
                allowGlobal={false}
                label="Organization"
                required
                autoFocus
              />
              <div className="cv-field-group">
                <label className="cv-field-label" htmlFor="questionnaire-name">Name *</label>
                <Input id="questionnaire-name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="cv-field-group">
                <label className="cv-field-label" htmlFor="questionnaire-carrier">Carrier</label>
                <Input id="questionnaire-carrier" value={draft.carrier} onChange={(e) => setDraft((d) => ({ ...d, carrier: e.target.value }))} />
              </div>
              <FileUpload
                organizationId={draft.organization_id}
                accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                acceptLabel="PDF or Word document"
                label={uploaded ? uploaded.name : "Drop a PDF or Word questionnaire"}
                maxSizeMb={50}
                onUploaded={onUploaded}
                disabled={creating}
              />
            </div>
            <div className="cv-dialog__footer" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </button>
              <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={createQuestionnaire} disabled={creating}>
                {creating ? "Creating..." : "Create questionnaire"}
              </button>
            </div>
        </BifrostDialogFrame>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--cv-fg-3)" }} />
          <Input aria-label="Search questionnaires" placeholder="Search questionnaires..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 30 }} />
        </div>
        <div style={{ minWidth: 170 }}>
          <ThemedSelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            options={[{ label: "All statuses", value: "all" }, ...STATUS_OPTIONS]}
            ariaLabel="Filter by status"
          />
        </div>
      </div>

      {error ? (
        <div className="cv-callout cv-callout--danger">
          <div className="cv-callout__label">
            <AlertCircle size={14} />
            Error
          </div>
          <div className="cv-callout__body">{String(error)}</div>
        </div>
      ) : loading ? (
        <LoadingSkeleton rows={6} label="Loading questionnaires" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No questionnaires match"
          body="Upload a PDF or Word questionnaire to create the source document and review workspace."
          cta={canEdit ? (
            <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} />
              New questionnaire
            </button>
          ) : null}
        />
      ) : (
        <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="cv-data-table" style={{ width: "100%", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ width: 200 }}>Organization</th>
                <th>Questionnaire</th>
                <th style={{ width: 130 }}>Status</th>
                <th style={{ width: 80, textAlign: "right" }}>Questions</th>
                <th style={{ width: 80, textAlign: "right" }}>Accepted</th>
                <th style={{ width: 100, textAlign: "right" }}>Review</th>
                <th style={{ width: 120 }}>Updated</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const counts = countsByQuestionnaire.get(row.id) ?? { questions: 0, accepted: 0, needsReview: 0 };
                return (
                  <tr key={row.id} className="cv-data-table__row--clickable" onClick={() => navigate(`/questionnaires/${row.id}`)}>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {orgNameById.get(row.organization_id) ?? "Unknown organization"}
                    </td>
                    <td style={{ overflow: "hidden" }}>
                      <Link className="cv-table-primary-link" to={`/questionnaires/${row.id}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</Link>
                      <div style={{ color: "var(--cv-fg-3)", fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.carrier || "No carrier"}
                      </div>
                    </td>
                    <td><span className={"cv-chip " + statusTone(row.status)} style={{ whiteSpace: "nowrap" }}>{labelize(row.status)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="cv-mono">{counts.questions}</span></td>
                    <td style={{ textAlign: "right" }}><span className="cv-mono">{counts.accepted}</span></td>
                    <td style={{ textAlign: "right" }}><span className="cv-mono">{counts.needsReview}</span></td>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmtDate(row.updated_at ?? row.created_at)}</td>
                    <td><ChevronRight size={15} style={{ color: "var(--cv-fg-3)" }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
