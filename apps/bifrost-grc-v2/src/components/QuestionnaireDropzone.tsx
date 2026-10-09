import React, { useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkflowMutation } from "bifrost";
import { Upload, FileText, Loader2 } from "lucide-react";

const WF_START_UPLOAD = "workflows/grc_v2/grc_source_documents.py::start_grc_source_upload";
const WF_FINISH_UPLOAD = "workflows/grc_v2/grc_source_documents.py::finish_grc_source_upload";

interface Props {
  questionnaireId: string;
  onUploaded?: () => void;
}

const ACCEPTED = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export default function QuestionnaireDropzone({ questionnaireId, onUploaded }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { mutate: startUpload } = useWorkflowMutation(WF_START_UPLOAD);
  const { mutate: finishUpload } = useWorkflowMutation(WF_FINISH_UPLOAD);

  async function handleFile(file: File) {
    if (busy) return;
    setBusy(true);
    setStage("Preparing upload…");
    try {
      const start = (await startUpload({
        questionnaire_id: questionnaireId,
        file_name: file.name,
        mime_type: file.type || "application/octet-stream",
        name: file.name,
      })) as { source_document_id: string; upload_url: string; file_path: string };

      if (!start?.upload_url) {
        throw new Error("Backend did not return an upload URL.");
      }

      setStage("Uploading…");
      const putRes = await fetch(start.upload_url, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (${putRes.status}): ${await putRes.text().catch(() => "")}`);
      }

      setStage("Linking + converting…");
      await finishUpload({
        source_document_id: start.source_document_id,
        questionnaire_id: questionnaireId,
      });

      toast.success("Source uploaded. Run 'Extract' to pull questions.");
      onUploaded?.();
    } catch (err) {
      toast.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(event) => {
        if (!busy && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy}
      aria-label={busy ? stage : "Upload a PDF or Word questionnaire"}
      className="grc-dropzone"
      style={{
        border: dragging ? "2px dashed var(--cv-cb)" : "2px dashed var(--cv-border-1)",
        background: dragging ? "var(--cv-bg-3)" : "var(--cv-bg-2)",
        borderRadius: 10,
        padding: "48px 28px",
        textAlign: "center",
        cursor: busy ? "wait" : "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        alignItems: "center",
        transform: dragging ? "scale(1.01)" : "scale(1)",
      }}
    >
      <div style={{
        width: 56, height: 56, borderRadius: "50%", background: "var(--cv-bg-3)",
        display: "flex", alignItems: "center", justifyContent: "center", color: "var(--cv-fg-2)",
      }}>
        {busy ? <Loader2 size={24} className="animate-spin" /> : <Upload size={24} />}
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--cv-fg-1)" }}>
          {busy ? stage : "Drop a questionnaire here"}
        </div>
        <div style={{ fontSize: 12, color: "var(--cv-fg-3)", marginTop: 4 }}>
          PDF or DOCX · or <span style={{ color: "var(--cv-cb)", textDecoration: "underline" }}>browse</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--cv-fg-3)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><FileText size={12} /> Carrier insurance form</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><FileText size={12} /> Vendor security questionnaire</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        aria-label="Choose a PDF or Word questionnaire"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
