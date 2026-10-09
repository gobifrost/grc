import { useEffect, useRef, useState } from "react";
import { useWorkflowQuery } from "bifrost";
import { Loader2, AlertCircle, ExternalLink, FileText, File } from "lucide-react";

const WF_GET_PDF_URL = "workflows/grc_v2/grc_source_documents.py::get_grc_source_pdf_url";

interface Props {
  sourceDocumentId: string | null | undefined;
  fileName?: string | null;
  /** Page to scroll to (1-indexed). Defaults to 1. Change to navigate. */
  page?: number | null;
  /** Optional height override (e.g. "calc(100vh - 240px)"). */
  height?: string;
}

interface PdfUrlResult {
  url: string | null;
  status: string;
  pdf_file_path?: string;
  error?: string;
}

export default function QuestionnairePdfPane(props: Props) {
  if (!props.sourceDocumentId) {
    return (
      <div
        className="cv-card cv-card--pad-sm"
        style={{ height: props.height ?? "calc(100vh - 200px)", minHeight: 400 }}
      >
        <div className="cv-flex" style={{ alignItems: "center", gap: 8, color: "var(--cv-fg-2)" }}>
          <FileText size={14} />
          <span style={{ fontSize: 13 }}>No source document linked.</span>
        </div>
      </div>
    );
  }
  return <LoadedQuestionnairePdfPane {...props} sourceDocumentId={props.sourceDocumentId} />;
}

function LoadedQuestionnairePdfPane({ sourceDocumentId, fileName, page, height }: Props & { sourceDocumentId: string }) {
  const { data, loading: isLoading, error: isError } = useWorkflowQuery<PdfUrlResult>(
    WF_GET_PDF_URL,
    { source_document_id: sourceDocumentId },
  );
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [requestedPage, setRequestedPage] = useState<number>(page ?? 1);

  useEffect(() => {
    if (page && page !== requestedPage) setRequestedPage(page);
  }, [page]);

  const src = data?.url
    ? `${data.url}${data.url.includes("#") ? "&" : "#"}page=${requestedPage}&toolbar=1&navpanes=0`
    : null;

  const paneStyle = {
    height: height ?? "calc(100vh - 200px)",
    minHeight: 400,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  };

  return (
    <div className="cv-card cv-card--pad-sm" style={paneStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--cv-fg-1)", overflow: "hidden" }}>
          <FileText size={14} />
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {fileName ?? "Source PDF"}
          </span>
        </div>
        {data?.url ? (
          <a href={data.url} target="_blank" rel="noreferrer" className="cv-btn cv-btn--secondary cv-btn--xs" style={{ textDecoration: "none" }}>
            <ExternalLink size={12} /> Open
          </a>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, border: "1px solid var(--cv-border-1)", borderRadius: 6, overflow: "hidden", background: "var(--cv-bg-2)" }}>
        {isLoading ? (
          <div className="cv-flex" style={{ height: "100%", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--cv-fg-2)" }}>
            <Loader2 size={16} className="animate-spin" /> Loading PDF…
          </div>
        ) : data?.status === "unsupported_type" ? (
          <div style={{ height: "100%", overflow: "auto", padding: 18, background: "var(--cv-bg-1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--cv-fg-2)", fontSize: 13, marginBottom: 10 }}>
              <AlertCircle size={14} />
              <span>No PDF preview available for this source type. Showing metadata:</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--cv-fg-2)", display: "grid", gridTemplateColumns: "120px 1fr", gap: 6 }}>
              <span style={{ color: "var(--cv-fg-3)" }}>File name</span><span>{fileName ?? "—"}</span>
              <span style={{ color: "var(--cv-fg-3)" }}>MIME type</span><span className="cv-mono">{data?.error ? data.error : "—"}</span>
            </div>
          </div>
        ) : isError || data?.status === "source_missing" || !src ? (
          <div className="cv-flex" style={{ height: "100%", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--cv-danger)", padding: 24, textAlign: "center" }}>
            <AlertCircle size={16} />
            <span>
              {data?.status === "source_missing"
                ? "Source file is missing from storage."
                : data?.error || "Failed to load source PDF."}
            </span>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={src}
            title={fileName ?? "Source PDF"}
            style={{ width: "100%", height: "100%", border: "none", background: "white" }}
          />
        )}
      </div>
    </div>
  );
}
