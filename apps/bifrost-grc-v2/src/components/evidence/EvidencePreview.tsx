import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkflowMutation } from "bifrost";

import { ExternalLink, FileText, Link2, Download, Loader2, AlertTriangle } from "lucide-react";
import type { Evidence } from "../../lib/types";
import { WF_GET_DOWNLOAD_URL } from "../../lib/grc-tables";

interface EvidencePreviewProps {
  item: Evidence;
  mode?: "all" | "attachment";
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

function extOf(path?: string | null): string {
  if (!path) return "";
  const clean = path.split("?")[0]?.split("#")[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot).toLowerCase() : "";
}

function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.includes(ext);
}

function basename(path?: string | null): string {
  if (!path) return "file";
  const clean = path.split("?")[0] ?? path;
  const seg = clean.split("/").filter(Boolean);
  return seg[seg.length - 1] ?? "file";
}

function parseArray(raw?: string | null): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstUrl(item: Evidence): string | null {
  const first = parseArray(item.urls_json)[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof first.url === "string") return first.url;
  return item.url ?? null;
}

function firstAttachmentPath(item: Evidence): string | null {
  const first = parseArray(item.attachments_json)[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof first.path === "string") return first.path;
  return item.file_path ?? null;
}

export default function EvidencePreview({ item, mode = "all" }: EvidencePreviewProps) {
  const filePath = firstAttachmentPath(item);
  const evidenceUrl = mode === "all" ? firstUrl(item) : null;
  const notes = mode === "all" ? item.notes_markdown ?? item.notes ?? "" : "";

  const { mutate: getDownloadUrl } = useWorkflowMutation(WF_GET_DOWNLOAD_URL);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSignedUrl(null);
    setUrlError(null);
    if (!filePath) return;
    setUrlLoading(true);
    (async () => {
      try {
        const res = (await getDownloadUrl({ path: filePath, organization_id: item.organization_id })) as
          | { url?: string }
          | null;
        if (cancelled) return;
        if (!res?.url) {
          setUrlError("Download URL response missing url");
        } else {
          setSignedUrl(res.url);
        }
      } catch (e) {
        if (cancelled) return;
        setUrlError(e instanceof Error ? e.message : "Failed to fetch download URL");
      } finally {
        if (!cancelled) setUrlLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  if (notes.trim() && !filePath && !evidenceUrl) {
    return (
      <div
        style={{
          whiteSpace: "pre-wrap",
          fontFamily: "var(--cv-font-mono)",
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--cv-fg-1)",
          background: "var(--cv-bg-3)",
          border: "1px solid var(--cv-border)",
          borderRadius: "var(--cv-r-md)",
          padding: 14,
          maxHeight: 480,
          overflow: "auto",
        }}
      >
        {notes}
      </div>
    );
  }

  if (evidenceUrl) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <a
          href={evidenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="cv-card cv-card--hover"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: 14,
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <div className="cv-stat-tile__icon cv-stat-tile__icon--teal" style={{ width: 32, height: 32 }}>
            <Link2 size={16} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>Link</div>
            <div
              style={{
                fontSize: 13,
                color: "var(--cv-fg-1)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {evidenceUrl}
            </div>
          </div>
          <ExternalLink size={14} className="cv-small" />
        </a>
        <a
          href={evidenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="cv-btn cv-btn--secondary cv-btn--sm"
          style={{ alignSelf: "flex-start", textDecoration: "none" }}
        >
          <ExternalLink size={13} />
          Open in new tab
        </a>
      </div>
    );
  }

  // document / screenshot
  if (!filePath) {
    // legacy stub fallback — url-only doc reference
    return (
      <div className="cv-small" style={{ padding: "8px 4px" }}>
        {mode === "attachment" ? "No attachment." : "No content stored."}
      </div>
    );
  }

  if (urlLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "24px 12px",
          color: "var(--cv-fg-3)",
          fontSize: 13,
        }}
      >
        <Loader2 className="animate-spin" size={14} />
        Loading preview…
      </div>
    );
  }

  if (urlError || !signedUrl) {
    return (
      <div
        className="cv-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: 12,
          color: "var(--cv-fg-2)",
          fontSize: 13,
        }}
      >
        <AlertTriangle size={14} className="cv-small" />
        {urlError ?? "Preview unavailable."}
      </div>
    );
  }

  const ext = extOf(filePath);
  const name = basename(filePath);

  if (isImageExt(ext)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            background: "var(--cv-bg-3)",
            border: "1px solid var(--cv-border)",
            borderRadius: "var(--cv-r-md)",
            padding: 8,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <img
            src={signedUrl}
            alt={item.name ?? "Evidence"}
            style={{
              maxHeight: 600,
              maxWidth: "100%",
              objectFit: "contain",
              borderRadius: "var(--cv-r-sm)",
            }}
          />
        </div>
        <a
          href={signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="cv-btn cv-btn--secondary cv-btn--sm"
          style={{ alignSelf: "flex-start", textDecoration: "none" }}
        >
          <ExternalLink size={13} />
          Open original
        </a>
      </div>
    );
  }

  if (ext === ".pdf") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <iframe
          src={signedUrl}
          title={item.name ?? "PDF preview"}
          style={{ width: "100%", height: "80vh", border: 0, borderRadius: "var(--cv-r-md)" }}
        />
        <a
          href={signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="cv-btn cv-btn--secondary cv-btn--sm"
          style={{ alignSelf: "flex-start", textDecoration: "none" }}
        >
          <ExternalLink size={13} />
          Open in new tab
        </a>
      </div>
    );
  }

  // generic download card
  return (
    <div
      className="cv-card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: 14,
      }}
    >
      <div className="cv-stat-tile__icon cv-stat-tile__icon--purple" style={{ width: 32, height: 32 }}>
        <FileText size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--cv-fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
          {ext ? ext.slice(1).toUpperCase() + " file" : "File"}
        </div>
      </div>
      <a
        href={signedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="cv-btn cv-btn--secondary cv-btn--sm"
        style={{ textDecoration: "none" }}
      >
        <Download size={13} />
        Download
      </a>
    </div>
  );
}
