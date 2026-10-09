import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkflowMutation } from "bifrost";

import { FileText, Link2, Camera, StickyNote, ExternalLink } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import ScopeBadge from "../shared/ScopeBadge";
import type { Evidence, EvidenceType } from "../../lib/types";
import { WF_GET_DOWNLOAD_URL } from "../../lib/grc-tables";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

function isImagePath(path?: string | null): boolean {
  if (!path) return false;
  const clean = path.split("?")[0]?.split("#")[0] ?? "";
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.includes(clean.slice(dot).toLowerCase());
}

const ICONS: Record<EvidenceType, LucideIcon> = {
  document: FileText,
  url: Link2,
  screenshot: Camera,
  note: StickyNote,
};

const TYPE_TONES: Record<EvidenceType, string> = {
  document: "cv-chip--purple",
  url: "cv-chip--teal",
  screenshot: "cv-chip--gold",
  note: "cv-chip--green",
};

function relTime(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

interface EvidenceCardProps {
  item: Evidence;
}

export default function EvidenceCard({ item }: EvidenceCardProps) {
  const type: EvidenceType = (item.type as EvidenceType) ?? "note";
  const Icon = ICONS[type] ?? StickyNote;
  const tone = TYPE_TONES[type] ?? "cv-chip--neutral";

  const showThumb = isImagePath(item.file_path ?? null);
  const containerRef = useRef<HTMLAnchorElement | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [intersected, setIntersected] = useState(false);
  const { mutate: getDownloadUrl } = useWorkflowMutation(WF_GET_DOWNLOAD_URL);

  useEffect(() => {
    if (!showThumb) return;
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setIntersected(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIntersected(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "100px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [showThumb]);

  useEffect(() => {
    if (!showThumb || !intersected || thumbUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = (await getDownloadUrl({ path: item.file_path, organization_id: item.organization_id })) as
          | { url?: string }
          | null;
        if (!cancelled && res?.url) setThumbUrl(res.url);
      } catch {
        // silent — fall back to icon
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showThumb, intersected, item.file_path]);

  return (
    <Link
      ref={containerRef}
      to={`/evidence/${item.id}`}
      className="cv-card cv-card--hover"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 16,
        textDecoration: "none",
        color: "inherit",
        minHeight: 168,
      }}
    >
      {showThumb && thumbUrl ? (
        <div
          style={{
            height: 80,
            borderRadius: "var(--cv-r-sm)",
            overflow: "hidden",
            background: "var(--cv-bg-3)",
            border: "1px solid var(--cv-border)",
          }}
        >
          <img
            src={thumbUrl}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div
          className="cv-stat-tile__icon"
          style={{ width: 32, height: 32, flexShrink: 0 }}
        >
          <Icon size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--cv-fg-1)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.name ?? "Untitled"}
          </div>
          <div className="cv-small" style={{ marginTop: 2 }}>
            Updated {relTime(item.updated_at)}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className={"cv-chip " + tone}>{type}</span>
        <ScopeBadge row={item} />
      </div>

      {item.notes ? (
        <div
          className="cv-small"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            color: "var(--cv-fg-2)",
            lineHeight: 1.45,
          }}
        >
          {item.notes}
        </div>
      ) : null}

      {type === "url" && item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="cv-link"
          style={{
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "100%",
          }}
        >
          <ExternalLink size={11} />
          {item.url}
        </a>
      ) : null}
    </Link>
  );
}
