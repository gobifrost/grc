import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import FileUpload, { type UploadedFile } from "../shared/FileUpload";
import MarkdownEditor from "../shared/MarkdownEditor";
import TagCombobox from "../shared/TagCombobox";
import BifrostDialogFrame from "../shared/BifrostDialogFrame";

interface EvidencePickerDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string | null;
  initialFile?: File | null;
  tagSuggestions?: string[];
  onCreateNew: (input: {
    name: string;
    url?: string;
    notes?: string;
    attachment?: UploadedFile;
    tags?: string[];
  }) => Promise<void>;
}

/**
 * Creates evidence only. Existing evidence is attached directly from the
 * assessment relationship selector, so this dialog never asks users to choose
 * between two unrelated tasks.
 */
export default function EvidencePickerDialog({
  open,
  onClose,
  organizationId,
  initialFile = null,
  tagSuggestions = [],
  onCreateNew,
}: EvidencePickerDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [attachment, setAttachment] = useState<UploadedFile | undefined>();
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !initialFile) return;
    setName((current) => current || initialFile.name.replace(/\.[^.]+$/, ""));
  }, [initialFile, open]);

  if (!open) return null;

  const resetAndClose = () => {
    setName("");
    setUrl("");
    setNotes("");
    setAttachment(undefined);
    setTags([]);
    setErr(null);
    setBusy(false);
    onClose();
  };

  const handleCreate = async () => {
    setErr(null);
    if (!name.trim()) {
      setErr("Name is required.");
      return;
    }
    setBusy(true);
    try {
      await onCreateNew({
        name: name.trim(),
        url: url.trim() || undefined,
        notes: notes.trim() || undefined,
        attachment,
        tags,
      });
      resetAndClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BifrostDialogFrame
      onDismiss={resetAndClose}
      dismissDisabled={busy}
      labelledBy="new-evidence-title"
      style={{ width: "min(680px, calc(100vw - 32px))" }}
    >
        <div className="cv-dialog__header">
          <div>
            <h2 id="new-evidence-title" className="cv-dialog__title">Create evidence</h2>
            <div className="cv-small" style={{ marginTop: 4 }}>
              Add notes, a URL, an attachment, or any useful combination.
            </div>
          </div>
        </div>
        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-evidence-name">Name *</label>
            <input
              id="new-evidence-name"
              autoFocus
              className="cv-field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="What does this evidence prove?"
            />
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-evidence-url">URL</label>
            <input
              id="new-evidence-url"
              type="url"
              className="cv-field"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label">Notes</label>
            <MarkdownEditor
              value={notes}
              onChange={setNotes}
              ariaLabel="Evidence notes"
              minHeight={120}
            />
          </div>
          <div className="cv-field-group">
            <div className="cv-field-label">Attachment</div>
            <FileUpload
              organizationId={organizationId}
              initialFile={initialFile}
              disabled={busy}
              label={attachment ? "Change attachment" : "Drop a file or click to attach"}
              onUploaded={(file) => {
                setAttachment(file);
                setName((current) => current || file.name.replace(/\.[^.]+$/, ""));
              }}
            />
            {attachment ? (
              <div className="cv-callout cv-callout--note">
                <Paperclip size={14} aria-hidden="true" />
                <div className="cv-callout__body">{attachment.name}</div>
              </div>
            ) : null}
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-evidence-tags">Tags</label>
            <TagCombobox
              id="new-evidence-tags"
              value={tags}
              suggestions={tagSuggestions}
              onChange={setTags}
            />
          </div>
          {err ? (
            <div className="cv-callout cv-callout--danger">
              <div className="cv-callout__body">{err}</div>
            </div>
          ) : null}
        </div>
        <div className="cv-dialog__footer">
          <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={resetAndClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={handleCreate} disabled={busy}>
            {busy ? "Creating…" : "Create and attach"}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}
