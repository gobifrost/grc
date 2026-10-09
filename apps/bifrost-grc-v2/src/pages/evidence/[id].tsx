import { useGovernedTables } from "../../lib/governed-tables";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTable } from "bifrost";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, ArrowLeft, Trash2, Edit3, Save, X, AlertTriangle, ExternalLink } from "lucide-react";
import { useParams } from "react-router-dom";
import PageHeader from "../../components/shared/PageHeader";
import SectionHeader from "../../components/shared/SectionHeader";
import ScopeBadge from "../../components/shared/ScopeBadge";
import OrgScopeField from "../../components/shared/OrgScopeField";
import TagCombobox from "../../components/shared/TagCombobox";
import MarkdownEditor from "../../components/shared/MarkdownEditor";
import EvidencePreview from "../../components/evidence/EvidencePreview";
import AttachedToList from "../../components/evidence/AttachedToList";
import { confirm } from "../../components/shared/ConfirmDialog";
import FileUpload, { type UploadedFile } from "../../components/shared/FileUpload";
import { TABLE_EVIDENCE } from "../../lib/grc-tables";
import { getRow } from "../../lib/table-helpers";
import { scopeOrgIds } from "../../lib/scope";
import { useUserNameLookup } from "../../lib/directory";
import MarkdownPreview from "../../components/policy-builder/MarkdownPreview";
import { useGrcPermissions } from "../../lib/current-user";
import type { Evidence } from "../../lib/types";

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit" });
  } catch {
    return "—";
  }
}

function parseJsonArray(raw?: string | null): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstEvidenceUrl(row: Evidence): string {
  const urls = parseJsonArray(row.urls_json);
  const first = urls[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof first.url === "string") return first.url;
  return row.url ?? "";
}

export default function EvidenceDetailPage() {
  const tables = useGovernedTables();
  const { canEdit } = useGrcPermissions();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const userName = useUserNameLookup();
  const { rows: evidenceRows } = useTable<Evidence>(TABLE_EVIDENCE, { pageSize: 1000 });
  const tagSuggestions = useMemo(
    () => Array.from(new Set((evidenceRows ?? []).flatMap((row) => row.tags ?? []))),
    [evidenceRows],
  );

  const [item, setItem] = useState<Evidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Editable draft fields
  const [draftName, setDraftName] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftOrganizationScope, setDraftOrganizationScope] = useState<string[] | null>(null);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftUpload, setDraftUpload] = useState<UploadedFile | null>(null);

  const load = async (showSpinner = true) => {
    if (!id) return;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const row = await getRow<Evidence>(TABLE_EVIDENCE, id);
      if (!row) {
        setError("Evidence not found.");
        setItem(null);
      } else {
        setItem(row);
        setDraftName(row.name ?? "");
        setDraftNotes(row.notes_markdown ?? row.notes ?? "");
        setDraftUrl(firstEvidenceUrl(row));
        setDraftOrganizationScope(scopeOrgIds(row));
        setDraftTags(Array.isArray(row.tags) ? row.tags : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load evidence");
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const beginEdit = () => {
    if (!item) return;
    setDraftName(item.name ?? "");
    setDraftNotes(item.notes_markdown ?? item.notes ?? "");
    setDraftUrl(firstEvidenceUrl(item));
    setDraftOrganizationScope(scopeOrgIds(item));
    setDraftTags(Array.isArray(item.tags) ? item.tags : []);
    setDraftUpload(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (item) {
      setDraftName(item.name ?? "");
      setDraftNotes(item.notes_markdown ?? item.notes ?? "");
      setDraftUrl(firstEvidenceUrl(item));
      setDraftOrganizationScope(scopeOrgIds(item));
      setDraftTags(Array.isArray(item.tags) ? item.tags : []);
    }
    setEditing(false);
    setDraftUpload(null);
  };

  const saveEdit = async () => {
    if (!id || !item) return;
    if (!draftName.trim()) {
      toast.error("Name is required");
      return;
    }
    if (draftOrganizationScope?.length === 0) {
      toast.error("Choose at least one organization or select All");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        applied_organizations: draftOrganizationScope,
        excluded_organizations: [],
        name: draftName.trim(),
        notes_markdown: draftNotes.trim() || null,
        urls_json: JSON.stringify(draftUrl.trim() ? [{ url: draftUrl.trim() }] : []),
        tags: draftTags,
        ...(draftUpload
          ? {
              attachments_json: JSON.stringify([{
                path: draftUpload.path,
                name: draftUpload.name,
                size_bytes: draftUpload.sizeBytes,
                content_type: draftUpload.contentType,
              }]),
            }
          : {}),
      };
      await tables.update(TABLE_EVIDENCE, id, payload);
      setEditing(false);
      setDraftUpload(null);
      await load(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id || !item) return;
    const ok = await confirm({
      title: "Delete this evidence?",
      body: `"${item.name ?? "Untitled"}" will be permanently removed.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      destructive: true });
    if (!ok) return;
    setDeleting(true);
    try {
      await tables.delete(TABLE_EVIDENCE, id);
      navigate("/evidence");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: 320 }}>
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (error || !item) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Link to="/evidence" className="cv-link" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4 }}>
          <ArrowLeft size={13} />
          Back to evidence
        </Link>
        <Alert variant="destructive">
          <AlertTriangle size={14} />
          <AlertTitle>Couldn't load evidence</AlertTitle>
          <AlertDescription>{error ?? "Not found"}</AlertDescription>
        </Alert>
        <div>
          <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => load(true)}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const tags = item.tags ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Link
        to="/evidence"
        className="cv-link"
        style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
      >
        <ArrowLeft size={13} />
        Back to evidence
      </Link>

      <PageHeader
        title={
          editing ? (
            <span className="cv-editable-title">
              <input
                className="cv-editable-title__input"
                aria-label="Evidence name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </span>
          ) : item.name ?? "Untitled"
        }
        subtitle={
          item.created_at
            ? `Created ${fmtDate(item.created_at)}${item.created_by ? ` by ${userName(item.created_by)}` : ""}`
            : undefined
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ScopeBadge row={item} />
            {canEdit && !editing ? (
              <>
                <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={beginEdit}>
                  <Edit3 size={13} />
                  Edit
                </button>
                <button
                  className="cv-btn cv-btn--destructive cv-btn--sm"
                  onClick={remove}
                  disabled={deleting}
                >
                  <Trash2 size={13} />
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </>
            ) : canEdit && editing ? (
              <>
                <button
                  className="cv-btn cv-btn--secondary cv-btn--sm"
                  onClick={cancelEdit}
                  disabled={saving}
                >
                  <X size={13} />
                  Cancel
                </button>
                <button
                  className="cv-btn cv-btn--primary cv-btn--sm"
                  onClick={saveEdit}
                  disabled={saving}
                >
                  <Save size={13} />
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            ) : null}
          </div>
        }
      />

      <div className="cv-record-layout">
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <div className="cv-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <SectionHeader label="Evidence content" />
            <div className="cv-field-group">
              <div className="cv-field-label">Notes</div>
              {editing ? (
                <MarkdownEditor
                  value={draftNotes}
                  onChange={setDraftNotes}
                  ariaLabel="Evidence notes"
                  minHeight={180}
                />
              ) : item.notes_markdown || item.notes ? (
                <div className="cv-markdown-preview">
                  <MarkdownPreview source={item.notes_markdown || item.notes || ""} />
                </div>
              ) : (
                <span className="cv-small">No notes.</span>
              )}
            </div>

            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor={editing ? "evidence-url" : undefined}>URL</label>
              {editing ? (
                <input
                  id="evidence-url"
                  type="url"
                  className="cv-field"
                  placeholder="https://…"
                  value={draftUrl}
                  onChange={(event) => setDraftUrl(event.target.value)}
                />
              ) : draftUrl ? (
                <a href={draftUrl} target="_blank" rel="noopener noreferrer" className="cv-link" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{draftUrl}</span>
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              ) : (
                <span className="cv-small">No URL.</span>
              )}
            </div>

            <div className="cv-field-group">
              <div className="cv-field-label">Attachment</div>
              <EvidencePreview item={item} mode="attachment" />
              {editing ? (
                <>
                  {draftUpload ? (
                    <div className="cv-callout cv-callout--note">
                      <div className="cv-callout__body">
                        New attachment: {draftUpload.name} · saves with this record
                      </div>
                      <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => setDraftUpload(null)}>
                        Clear
                      </button>
                    </div>
                  ) : null}
                  <FileUpload
                    organizationId={draftOrganizationScope?.[0] ?? null}
                    onUploaded={setDraftUpload}
                    label={parseJsonArray(item.attachments_json).length > 0 || item.file_path
                      ? "Change attachment"
                      : "Add attachment"}
                  />
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cv-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeader label="Scope" />
            {editing ? (
              <OrgScopeField
                id="evidence-organization-scope"
                value={draftOrganizationScope}
                onChange={setDraftOrganizationScope}
              />
            ) : (
              <ScopeBadge row={item} />
            )}
          </div>
          <div className="cv-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeader label="Tags" />
            {editing ? (
              <TagCombobox
                id="evidence-tags"
                value={draftTags}
                onChange={setDraftTags}
                suggestions={tagSuggestions}
              />
            ) : tags.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {tags.map((tag) => <span key={tag} className="cv-chip cv-chip--neutral">{tag}</span>)}
              </div>
            ) : (
              <span className="cv-small">No tags.</span>
            )}
          </div>
          <div className="cv-card" style={{ display: "grid", gap: 8 }}>
            <SectionHeader label="Audit" />
            <AuditRow label="Created" value={fmtDate(item.created_at)} />
            <AuditRow label="Updated" value={fmtDate(item.updated_at)} />
            <AuditRow label="Created by" value={userName(item.created_by)} />
            <AuditRow label="Uploaded by" value={userName(item.uploaded_by)} />
          </div>
        </div>
      </div>

      {/* Attached to */}
      <div>
        <SectionHeader label="Attached to" />
        <div className="cv-card cv-card--pad-sm">
          <AttachedToList
            evidenceId={item.id}
            assessmentId={item.assessment_id ?? null}
            controlId={item.control_id ?? null}
          />
        </div>
      </div>
    </div>
  );
}

function AuditRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
      <span style={{ color: "var(--cv-fg-3)" }}>{label}</span>
      <span style={{ color: "var(--cv-fg-2)", textAlign: "right" }}>{value}</span>
    </div>
  );
}
