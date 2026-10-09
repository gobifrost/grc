import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTable } from "bifrost";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { Loader2, Plus, Search, Paperclip, AlertTriangle, ChevronRight, Tags } from "lucide-react";
import PageHeader from "../../components/shared/PageHeader";
import EmptyState from "../../components/shared/EmptyState";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import EvidenceCreateDialog from "../../components/evidence/EvidenceCreateDialog";
import { useGrcPermissions } from "../../lib/current-user";
import ScopeBadge from "../../components/shared/ScopeBadge";
import { TABLE_EVIDENCE, TABLE_EVIDENCE_LINKS } from "../../lib/grc-tables";
import { appliesToOrg } from "../../lib/scope";
import { useOrganizationView } from "../../lib/organization-view";
import type { Evidence, EvidenceLink } from "../../lib/types";

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

interface UseTableShape<T> {
  rows?: T[] | null;
  documents?: T[] | null;
  loading?: boolean;
  error?: unknown;
}

export default function EvidenceListPage() {
  const { canEdit } = useGrcPermissions();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const { organizationId } = useOrganizationView();

  const navigate = useNavigate();
  // useTable returns either { rows } or a flat list depending on platform version.
  const table = useTable<Evidence>(TABLE_EVIDENCE, {
    pageSize: 500,
    order_by: "updated_at",
    order_dir: "desc",
  }) as unknown as UseTableShape<Evidence> | Evidence[];

  const { rows: evidenceLinks } = useTable<EvidenceLink>(TABLE_EVIDENCE_LINKS, { pageSize: 1000 });
  const attachedCountById = useMemo(() => {
    const m = new Map<string, number>();
    (evidenceLinks ?? []).forEach((l) => {
      const eid = (l as unknown as { evidence_id?: string }).evidence_id;
      if (eid) m.set(eid, (m.get(eid) ?? 0) + 1);
    });
    return m;
  }, [evidenceLinks]);

  const rows: Evidence[] = useMemo(() => {
    if (Array.isArray(table)) return table;
    return (table?.rows ?? table?.documents ?? []) as Evidence[];
  }, [table]);

  const loading = !Array.isArray(table) && Boolean(table?.loading);
  const error = !Array.isArray(table) ? table?.error : null;

  const allTags = useMemo(() => {
    const t = new Set<string>();
    rows.forEach((r) => {
      if (Array.isArray(r.tags)) r.tags.forEach((tag) => tag && t.add(tag));
    });
    return Array.from(t).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (organizationId && !appliesToOrg(r, organizationId)) return false;
      if (tagFilter) {
        if (!Array.isArray(r.tags) || !r.tags.includes(tagFilter)) return false;
      }
      if (q) {
        const hay = `${r.name ?? ""} ${r.notes_markdown ?? ""} ${r.notes ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, tagFilter, organizationId, search]);

  const totalCount = rows.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <PageHeader
        title="Evidence"
        subtitle="Supporting documentation for controls and assessments."
        actions={canEdit ? (
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />
            New evidence
          </button>
        ) : undefined}
      />

      {/* Filter row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 360 }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--cv-fg-3)",
            }}
          />
          <input
            aria-label="Search evidence"
            className="cv-field"
            placeholder="Search evidence…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 32 }}
          />
        </div>

        {allTags.length > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="cv-small">Tags:</span>
            <button
              className={
                "cv-chip " + (tagFilter === null ? "cv-chip--teal" : "cv-chip--neutral")
              }
              onClick={() => setTagFilter(null)}
              style={{ border: 0, cursor: "pointer" }}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                className={
                  "cv-chip " + (tagFilter === tag ? "cv-chip--teal" : "cv-chip--neutral")
                }
                onClick={() => setTagFilter(tag)}
                style={{ border: 0, cursor: "pointer" }}
              >
                {tag}
              </button>
            ))}
          </div>
        ) : null}

        <div style={{ flex: 1 }} />
        <span className="cv-small">
          {filtered.length} of {totalCount}
        </span>
      </div>

      {/* Body */}
      {loading ? (
        <LoadingSkeleton rows={6} label="Loading evidence" />
      ) : error ? (
        <Alert variant="destructive">
          <AlertTriangle size={14} />
          <AlertTitle>Couldn't load evidence</AlertTitle>
          <AlertDescription>
            {typeof error === "string" ? error : "The grc-evidence table query failed."}
          </AlertDescription>
        </Alert>
      ) : filtered.length === 0 ? (
        <div className="cv-card cv-card--pad-sm">
          {totalCount === 0 ? (
            <EmptyState
              icon={Paperclip}
              title="No evidence yet"
              body="Add documents, URLs, screenshots, or notes that support your controls and assessments."
              cta={canEdit ? (
                <button
                  className="cv-btn cv-btn--primary cv-btn--sm"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus size={14} />
                  New evidence
                </button>
              ) : null}
            />
          ) : (
            <EmptyState
              icon={Paperclip}
              title="No evidence matches"
              body="Try clearing the filters or search."
            />
          )}
        </div>
      ) : (
        <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="cv-data-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 190 }}>Scope</th>
                <th>Name</th>
                <th style={{ width: 90 }}>Attached</th>
                <th style={{ width: 115 }}>Updated</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const attached = attachedCountById.get(item.id) ?? 0;
                return (
                  <tr
                    key={item.id}
                    className="cv-data-table__row--clickable"
                    onClick={() => navigate(`/evidence/${item.id}`)}
                  >
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
                      <ScopeBadge row={item} />
                    </td>
                    <td>
                      <Link className="cv-table-primary-link" to={`/evidence/${item.id}`}>{item.name || "Untitled"}</Link>
                      {item.notes_markdown || item.notes ? (
                        <div style={{ color: "var(--cv-fg-3)", fontSize: 12, marginTop: 2, maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.notes_markdown || item.notes}
                        </div>
                      ) : null}
                    </td>
                    <td><span className="cv-mono">{attached}</span></td>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>{fmtDate(item.updated_at)}</td>
                    <td><ChevronRight size={15} style={{ color: "var(--cv-fg-3)" }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit ? <EvidenceCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          /* useTable subscribes — no manual refetch needed */
        }}
      /> : null}
    </div>
  );
}
