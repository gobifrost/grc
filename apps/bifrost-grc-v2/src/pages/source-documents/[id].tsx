import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { tables, useTable, useWorkflowMutation } from "bifrost";
import { AlertCircle, ArrowLeft, Download, ExternalLink, FileText, Link2, Loader2, Text } from "lucide-react";
import { useParams } from "react-router-dom";

import PageHeader from "../../components/shared/PageHeader";
import SectionHeader from "../../components/shared/SectionHeader";
import ScopeBadge from "../../components/shared/ScopeBadge";
import {
  TABLE_EVIDENCE,
  TABLE_EVIDENCE_LINKS,
  TABLE_QUESTIONNAIRE_ITEMS,
  TABLE_QUESTIONNAIRES,
  TABLE_SOURCE_DOCUMENTS,
  WF_GET_DOWNLOAD_URL,
  WF_READ_GRC_WORKSPACE_TEXT_FILE,
} from "../../lib/grc-tables";
import { useOrgNamesMap } from "../../lib/directory";
import { getRow } from "../../lib/table-helpers";
import type { Evidence, EvidenceLink, Questionnaire, QuestionnaireItem, SourceDocument } from "../../lib/types";

function fmtDate(iso?: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function labelize(value?: string | null): string {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function safeJson(value?: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const INTERNAL_METADATA_KEY = /(path|location|checksum|source.?id|organization.?id|token|secret|signature|url)/i;

function visibleMetadata(value: Record<string, unknown> | null): Array<[string, string]> {
  if (!value) return [];
  return Object.entries(value)
    .filter(([key, item]) => !INTERNAL_METADATA_KEY.test(key) && ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]): [string, string] => [labelize(key), String(item)])
    .slice(0, 20);
}

function docTone(type?: string | null): string {
  if (type === "questionnaire") return "cv-chip--teal";
  if (type === "evidence_attachment") return "cv-chip--purple";
  if (type === "policy_document") return "cv-chip--green";
  if (type === "ciso_export") return "cv-chip--gold";
  return "cv-chip--neutral";
}

function FieldRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "150px minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
      <div className="cv-small">{label}</div>
      <div style={{ color: "var(--cv-fg-1)", overflowWrap: "anywhere" }}>{value ?? "-"}</div>
    </div>
  );
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

function extOf(path?: string | null): string {
  if (!path) return "";
  const clean = path.split("?")[0]?.split("#")[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot).toLowerCase() : "";
}

export default function SourceDocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const orgNameById = useOrgNamesMap();

  const [doc, setDoc] = useState<SourceDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [signedUrlError, setSignedUrlError] = useState<string | null>(null);
  const [signedUrlLoading, setSignedUrlLoading] = useState(false);
  const [extractedText, setExtractedText] = useState<{ text: string; chars: number; truncated: boolean } | null>(null);
  const [extractedTextError, setExtractedTextError] = useState<string | null>(null);
  const [extractedTextLoading, setExtractedTextLoading] = useState(false);
  const { mutate: getDownloadUrl } = useWorkflowMutation(WF_GET_DOWNLOAD_URL);
  const { mutate: readWorkspaceText } = useWorkflowMutation(WF_READ_GRC_WORKSPACE_TEXT_FILE);

  const { rows: questionnaires } = useTable<Questionnaire>(TABLE_QUESTIONNAIRES, {
    pageSize: 1000,
    where: id ? { source_document_id: id } : undefined,
  });
  const { rows: evidenceLinks } = useTable<EvidenceLink>(TABLE_EVIDENCE_LINKS, {
    pageSize: 1000,
    where: id ? { target_type: "source_document", target_id: id } : undefined,
  });
  const { rows: evidenceRows } = useTable<Evidence>(TABLE_EVIDENCE, { pageSize: 1000 });
  const { rows: questionnaireItems } = useTable<QuestionnaireItem>(TABLE_QUESTIONNAIRE_ITEMS, { pageSize: 1000 });

  const evidenceById = useMemo(() => {
    const map = new Map<string, Evidence>();
    (evidenceRows ?? []).forEach((row) => map.set(row.id, row));
    return map;
  }, [evidenceRows]);

  const metadata = useMemo(() => safeJson(doc?.metadata_json), [doc?.metadata_json]);
  const metadataEntries = useMemo(() => visibleMetadata(metadata), [metadata]);
  const relatedQuestionnaireIds = useMemo(() => new Set((questionnaires ?? []).map((row) => row.id)), [questionnaires]);
  const relatedQuestionnaireItems = useMemo(
    () => (questionnaireItems ?? []).filter((row) => relatedQuestionnaireIds.has(row.questionnaire_id)),
    [questionnaireItems, relatedQuestionnaireIds],
  );

  useEffect(() => {
    let cancelled = false;
    setSignedUrl(null);
    setSignedUrlError(null);
    if (!doc?.file_path) return;
    setSignedUrlLoading(true);
    (async () => {
      try {
        const result = (await getDownloadUrl({ path: doc.file_path, organization_id: doc.organization_id })) as { url?: string } | null;
        if (cancelled) return;
        if (!result?.url) {
          console.warn("Source document preview unavailable", { sourceDocumentId: doc.id });
          setSignedUrlError("File preview isn’t available. Re-upload the source or contact support.");
        }
        else setSignedUrl(result.url);
      } catch {
        console.warn("Source document preview unavailable", { sourceDocumentId: doc.id });
        if (!cancelled) setSignedUrlError("File preview isn’t available. Re-upload the source or contact support.");
      } finally {
        if (!cancelled) setSignedUrlLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.file_path]);

  useEffect(() => {
    let cancelled = false;
    setExtractedText(null);
    setExtractedTextError(null);
    if (!doc?.extracted_text_path) return;
    setExtractedTextLoading(true);
    (async () => {
      try {
        const result = (await readWorkspaceText({ source_document_id: doc.id, max_chars: 120000 })) as
          | { text?: string; chars?: number; truncated?: boolean }
          | null;
        if (cancelled) return;
        setExtractedText({
          text: result?.text ?? "",
          chars: result?.chars ?? result?.text?.length ?? 0,
          truncated: Boolean(result?.truncated),
        });
      } catch {
        console.warn("Source document extracted-text preview unavailable", { sourceDocumentId: doc.id });
        if (!cancelled) {
          setExtractedTextError(
            "Extracted text isn’t available for this document. Re-run extraction from its questionnaire.",
          );
        }
      } finally {
        if (!cancelled) setExtractedTextLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.extracted_text_path]);

  async function load() {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const row = await getRow<SourceDocument>(TABLE_SOURCE_DOCUMENTS, id);
      if (!row) {
        setLoadError("Source document not found");
        setDoc(null);
      } else {
        setDoc(row);
      }
    } catch (err) {
      console.error("Source document failed to load", err);
      setLoadError("This source document couldn’t be loaded. Try again or contact support.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) {
    return (
      <div className="cv-card" style={{ padding: 32, display: "flex", justifyContent: "center", color: "var(--cv-fg-3)" }}>
        <Loader2 size={18} className="animate-spin" style={{ marginRight: 10 }} />
        Loading source document...
      </div>
    );
  }

  if (loadError || !doc) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => navigate("/source-documents")} style={{ alignSelf: "flex-start" }}>
          <ArrowLeft size={14} style={{ marginRight: 6 }} />
          Back to source documents
        </button>
        <div className="cv-callout cv-callout--danger">
          <div className="cv-callout__label">
            <AlertCircle size={14} />
            Error
          </div>
          <div className="cv-callout__body">{loadError ?? "Source document not found"}</div>
        </div>
      </div>
    );
  }

  const relatedEvidenceLinks = evidenceLinks ?? [];
  const relatedQuestionnaires = questionnaires ?? [];
  const ext = extOf(doc.file_name || doc.file_path);
  const isPdf = ext === ".pdf" || doc.mime_type === "application/pdf";
  const isImage = IMAGE_EXTS.includes(ext) || (doc.mime_type ?? "").startsWith("image/");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => navigate("/source-documents")} style={{ alignSelf: "flex-start" }}>
        <ArrowLeft size={14} style={{ marginRight: 6 }} />
        Back to source documents
      </button>

      <PageHeader
        title={doc.name}
        subtitle={doc.file_name || `${labelize(doc.document_type)} source`}
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {doc.url ? (
              <a className="cv-btn cv-btn--secondary cv-btn--sm" href={doc.url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                Open source
              </a>
            ) : null}
            {signedUrl ? (
              <a className="cv-btn cv-btn--primary cv-btn--sm" href={signedUrl} target="_blank" rel="noreferrer">
                <Download size={14} />
                Download file
              </a>
            ) : null}
          </div>
        }
      />

      <div className="cv-record-layout">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="cv-card" style={{ padding: 18, display: "grid", gap: 14 }}>
            <SectionHeader label="Document" />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span className={"cv-chip " + docTone(doc.document_type)}>{labelize(doc.document_type)}</span>
              <ScopeBadge row={doc} />
              {doc.source_system ? <span className="cv-chip cv-chip--neutral">{doc.source_system}</span> : null}
            </div>
            <FieldRow label="File name" value={doc.file_name} />
            <FieldRow label="File type" value={doc.mime_type ? labelize(doc.mime_type.replace("/", " / ")) : null} />
            <FieldRow label="Pages" value={doc.page_count} />
          </div>

          <div className="cv-card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <SectionHeader label="File preview" />
            {doc.file_path && signedUrlLoading ? (
              <div className="cv-small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Loader2 size={14} className="animate-spin" />
                Loading file preview...
              </div>
            ) : signedUrlError ? (
              <div className="cv-callout cv-callout--danger">
                <div className="cv-callout__label">Preview unavailable</div>
                <div className="cv-callout__body">{signedUrlError}</div>
              </div>
            ) : signedUrl && isPdf ? (
              <iframe
                src={signedUrl}
                title={doc.name}
                style={{ width: "100%", minHeight: "72vh", border: "1px solid var(--cv-border)", borderRadius: 8 }}
              />
            ) : signedUrl && isImage ? (
              <div style={{ background: "var(--cv-bg-3)", border: "1px solid var(--cv-border)", borderRadius: 8, padding: 8, display: "flex", justifyContent: "center" }}>
                <img src={signedUrl} alt={doc.name} style={{ maxWidth: "100%", maxHeight: 640, objectFit: "contain", borderRadius: 6 }} />
              </div>
            ) : signedUrl ? (
              <div className="cv-card cv-card--recessed" style={{ padding: 14, display: "flex", gap: 12, alignItems: "center" }}>
                <FileText size={18} style={{ color: "var(--cv-fg-3)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{doc.file_name ?? "Source file"}</div>
                  <div className="cv-small">Preview is not available for this file type.</div>
                </div>
                <a className="cv-btn cv-btn--secondary cv-btn--sm" href={signedUrl} target="_blank" rel="noreferrer">
                  <Download size={14} />
                  Download
                </a>
              </div>
            ) : doc.url ? (
              <a className="cv-card cv-card--recessed" style={{ padding: 14, display: "flex", gap: 12, alignItems: "center", color: "inherit", textDecoration: "none" }} href={doc.url} target="_blank" rel="noreferrer">
                <ExternalLink size={18} style={{ color: "var(--cv-fg-3)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>External source</div>
                  <div className="cv-small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.url}</div>
                </div>
              </a>
            ) : (
              <div className="cv-small">No file or URL is available for preview.</div>
            )}
          </div>

          <div className="cv-card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <SectionHeader label="Extracted text" />
            {doc.extracted_text_path && extractedTextLoading ? (
              <div className="cv-small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Loader2 size={14} className="animate-spin" />
                Loading extracted text...
              </div>
            ) : extractedTextError ? (
              <div className="cv-callout cv-callout--danger">
                <div className="cv-callout__label">Text unavailable</div>
                <div className="cv-callout__body">{extractedTextError}</div>
              </div>
            ) : extractedText ? (
              <>
                <div className="cv-small">
                  {extractedText.chars.toLocaleString()} characters{extractedText.truncated ? " (preview truncated)" : ""}
                </div>
                <pre style={{ margin: 0, maxHeight: 520, overflow: "auto", color: "var(--cv-fg-1)", background: "var(--cv-bg-1)", border: "1px solid var(--cv-border)", borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                  {extractedText.text || "(No extracted text)"}
                </pre>
              </>
            ) : (
              <div className="cv-small">No extracted text has been recorded for this document.</div>
            )}
          </div>

          <div className="cv-card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <SectionHeader label="Citation context" />
            {relatedQuestionnaireItems.length === 0 && relatedEvidenceLinks.filter((link) => link.citation).length === 0 ? (
              <div className="cv-small">No page, excerpt, or evidence citation context has been recorded yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {relatedQuestionnaireItems
                  .filter((item) => item.source_page || item.source_excerpt)
                  .slice(0, 50)
                  .map((item) => (
                    <Link key={item.id} to={`/questionnaires/${item.questionnaire_id}`} className="cv-card cv-card--recessed" style={{ padding: 12, color: "inherit", textDecoration: "none" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="cv-chip cv-chip--neutral">Question</span>
                        {item.source_page ? <span className="cv-chip cv-chip--mono cv-chip--teal">Page {item.source_page}</span> : null}
                        {item.source_anchor ? <span className="cv-chip cv-chip--mono cv-chip--neutral">{item.source_anchor}</span> : null}
                      </div>
                      <div style={{ fontWeight: 500, marginTop: 6 }}>{item.question_text}</div>
                      {item.source_excerpt ? <div className="cv-small" style={{ marginTop: 5, lineHeight: 1.5 }}>{item.source_excerpt}</div> : null}
                    </Link>
                  ))}
                {relatedEvidenceLinks
                  .filter((link) => link.citation)
                  .map((link) => {
                    const evidence = evidenceById.get(link.evidence_id);
                    return (
                      <Link key={link.id} to={evidence ? `/evidence/${evidence.id}` : "#"} className="cv-card cv-card--recessed" style={{ padding: 12, color: "inherit", textDecoration: "none" }}>
                        <span className="cv-chip cv-chip--purple">Evidence citation</span>
                        <div style={{ fontWeight: 500, marginTop: 6 }}>{evidence?.name ?? "Unresolved evidence"}</div>
                        <div className="cv-small" style={{ marginTop: 5, lineHeight: 1.5 }}>{link.citation}</div>
                      </Link>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="cv-card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <SectionHeader label={`Questionnaires (${relatedQuestionnaires.length})`} />
            {relatedQuestionnaires.length === 0 ? (
              <div style={{ color: "var(--cv-fg-3)", fontSize: 13 }}>No questionnaires use this source document.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {relatedQuestionnaires.map((row) => (
                  <Link key={row.id} to={`/questionnaires/${row.id}`} className="cv-card cv-card--recessed" style={{ padding: 12, textDecoration: "none", color: "inherit" }}>
                    <div style={{ fontWeight: 500 }}>{row.name}</div>
                    <div style={{ color: "var(--cv-fg-3)", fontSize: 12, marginTop: 3 }}>
                      {labelize(row.status)}{row.carrier ? ` · ${row.carrier}` : ""}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="cv-card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <SectionHeader label={`Evidence links (${relatedEvidenceLinks.length})`} />
            {relatedEvidenceLinks.length === 0 ? (
              <div style={{ color: "var(--cv-fg-3)", fontSize: 13 }}>No evidence links point at this source document.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {relatedEvidenceLinks.map((link) => {
                  const evidence = evidenceById.get(link.evidence_id);
                  return (
                    <Link key={link.id} to={evidence ? `/evidence/${evidence.id}` : "#"} className="cv-card cv-card--recessed" style={{ padding: 12, textDecoration: "none", color: "inherit" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Link2 size={14} style={{ color: "var(--cv-fg-3)" }} />
                        <span style={{ fontWeight: 500 }}>{evidence?.name ?? "Unresolved evidence"}</span>
                      </div>
                      <div style={{ color: "var(--cv-fg-3)", fontSize: 12, marginTop: 3 }}>
                        {link.relationship || "linked"} · {link.source_system || "manual"}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 12 }}>
          <div className="cv-card" style={{ padding: 18, display: "grid", gap: 10 }}>
            <SectionHeader label="Provenance" />
            <FieldRow label="Organization" value={orgNameById.get(doc.organization_id) ?? "Unknown organization"} />
            <FieldRow label="Source system" value={doc.source_system} />
            <FieldRow label="Created" value={fmtDate(doc.created_at)} />
            <FieldRow label="Updated" value={fmtDate(doc.updated_at)} />
          </div>

          <div className="cv-card" style={{ padding: 18 }}>
            <SectionHeader label="Metadata" />
            {metadataEntries.length > 0 ? (
              <div style={{ display: "grid", gap: 9, marginTop: 10 }}>
                {metadataEntries.map(([label, value]) => (
                  <FieldRow key={label} label={label} value={value} />
                ))}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--cv-fg-3)", fontSize: 13 }}>
                <FileText size={14} />
                No metadata recorded.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
