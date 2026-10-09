import { useGovernedTables } from "../../lib/governed-tables";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useTable } from "bifrost";
import { Paperclip, X } from "lucide-react";
import { TABLE_EVIDENCE } from "../../lib/grc-tables";
import { useCurrentUser } from "../../lib/current-user";
import type { Evidence } from "../../lib/types";
import { rowOrganizationIdForScope } from "../../lib/scope";
import FileUpload, { type UploadedFile } from "../shared/FileUpload";
import MarkdownEditor from "../shared/MarkdownEditor";
import OrgScopeField from "../shared/OrgScopeField";
import TagCombobox from "../shared/TagCombobox";
import BifrostDialogFrame from "../shared/BifrostDialogFrame";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface EvidenceCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (id?: string) => void;
}

export default function EvidenceCreateDialog({
  open,
  onClose,
  onCreated,
}: EvidenceCreateDialogProps) {
  const tables = useGovernedTables();
  const user = useCurrentUser();
  const defaultScope: string[] | null = null;
  const { rows: evidenceRows } = useTable<Evidence>(TABLE_EVIDENCE, { pageSize: 1000 });
  const tagSuggestions = useMemo(
    () => Array.from(new Set((evidenceRows ?? []).flatMap((row) => row.tags ?? []))),
    [evidenceRows],
  );
  const [name, setName] = useState("");
  const [notesMarkdown, setNotesMarkdown] = useState("");
  const [url, setUrl] = useState("");
  const [organizationScope, setOrganizationScope] = useState<string[] | null>(defaultScope);
  const [submitting, setSubmitting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [tags, setTags] = useState<string[]>([]);

  if (!open) return null;

  const reset = () => {
    setName("");
    setNotesMarkdown("");
    setUrl("");
    setOrganizationScope(defaultScope);
    setSubmitting(false);
    setUrlError(null);
    setUploaded(null);
    setTags([]);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    setUrlError(null);
    const trimmedName = name.trim();
    const cleanUrl = url.trim();
    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }
    if (organizationScope?.length === 0) {
      toast.error("Choose at least one organization or select All");
      return;
    }
    if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
      setUrlError("URL must start with http:// or https://");
      return;
    }

    setSubmitting(true);
    try {
      const created = (await tables.insert(TABLE_EVIDENCE, {
        name: trimmedName,
        notes_markdown: notesMarkdown.trim() || null,
        urls_json: JSON.stringify(cleanUrl ? [{ url: cleanUrl }] : []),
        attachments_json: JSON.stringify(
          uploaded
            ? [{
                path: uploaded.path,
                name: uploaded.name,
                size_bytes: uploaded.sizeBytes,
                content_type: uploaded.contentType,
              }]
            : [],
        ),
        provenance_json: JSON.stringify({ source: "manual", created_from: "grc_evidence_dialog" }),
        tags,
        review_status: "approved",
        organization_id: rowOrganizationIdForScope(organizationScope, user.organizationId),
        applied_organizations: organizationScope,
        excluded_organizations: [],
      })) as { id?: string } | null | undefined;
      onCreated(created?.id);
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create evidence");
      setSubmitting(false);
    }
  };

  return (
    <BifrostDialogFrame
      onDismiss={close}
      dismissDisabled={submitting}
      labelledBy="new-evidence-title"
      style={{ width: "min(680px, calc(100vw - 32px))" }}
    >
        <div className="cv-dialog__header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 id="new-evidence-title" className="cv-dialog__title">New evidence</h2>
            <p id="new-evidence-description" className="cv-small" style={{ margin: "4px 0 0" }}>
              Capture reusable proof with notes, a URL, an attachment, or any useful combination.
            </p>
          </div>
          <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={close} disabled={submitting} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <OrgScopeField
            id="new-evidence-scope"
            value={organizationScope}
            onChange={setOrganizationScope}
            disabled={submitting}
          />
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-evidence-name">Name *</label>
            <input
              id="new-evidence-name"
              className="cv-field"
              placeholder="What does this evidence prove?"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-evidence-url">URL</label>
            <input
              id="new-evidence-url"
              className="cv-field"
              type="url"
              placeholder="https://…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              aria-invalid={Boolean(urlError)}
            />
            {urlError ? <span className="cv-field-error">{urlError}</span> : null}
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label">Notes</label>
            <MarkdownEditor
              value={notesMarkdown}
              onChange={setNotesMarkdown}
              ariaLabel="Evidence notes"
              minHeight={132}
              disabled={submitting}
            />
          </div>
          <div className="cv-field-group">
            <div className="cv-field-label">Attachment</div>
            <FileUpload
              organizationId={user.organizationId}
              onUploaded={setUploaded}
              disabled={submitting}
              label={uploaded ? "Change attachment" : "Drop a file or click to attach"}
            />
            {uploaded ? (
              <div className="cv-callout cv-callout--note">
                <Paperclip size={14} />
                <div className="cv-callout__body">
                  {uploaded.name} · {formatBytes(uploaded.sizeBytes)}
                </div>
              </div>
            ) : null}
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-evidence-tags">Tags</label>
            <TagCombobox
              id="new-evidence-tags"
              value={tags}
              onChange={setTags}
              suggestions={tagSuggestions}
              disabled={submitting}
            />
          </div>
        </div>
        <div className="cv-dialog__footer">
          <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={close} disabled={submitting}>Cancel</button>
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create evidence"}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}
