import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTable } from "bifrost";
import { Input } from "@/components/ui/input";

import { AlertCircle, ChevronRight, ExternalLink, FileText, Files, Loader2, Search, Type } from "lucide-react";

import EmptyState from "../../components/shared/EmptyState";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import PageHeader from "../../components/shared/PageHeader";
import ThemedSelect from "../../components/shared/ThemedSelect";
import { TABLE_EVIDENCE_LINKS, TABLE_QUESTIONNAIRES, TABLE_SOURCE_DOCUMENTS } from "../../lib/grc-tables";
import { useOrgNamesMap } from "../../lib/directory";
import { useOrganizationView } from "../../lib/organization-view";
import type { EvidenceLink, Questionnaire, SourceDocument } from "../../lib/types";

function fmtDate(iso?: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "-";
  }
}

function labelize(value?: string | null): string {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function docTone(type?: string | null): string {
  if (type === "questionnaire") return "cv-chip--teal";
  if (type === "evidence_attachment") return "cv-chip--purple";
  if (type === "policy_document") return "cv-chip--green";
  if (type === "ciso_export") return "cv-chip--gold";
  return "cv-chip--neutral";
}

export default function SourceDocumentsPage() {
  const navigate = useNavigate();
  const orgNameById = useOrgNamesMap();

  const [search, setSearch] = useState("");
  const { organizationId } = useOrganizationView();
  const [typeFilter, setTypeFilter] = useState("all");

  const { rows: documents, loading, error } = useTable<SourceDocument>(TABLE_SOURCE_DOCUMENTS, {
    pageSize: 1000,
    order_by: "updated_at",
    order_dir: "desc",
  });
  const { rows: questionnaires } = useTable<Questionnaire>(TABLE_QUESTIONNAIRES, { pageSize: 1000 });
  const { rows: evidenceLinks } = useTable<EvidenceLink>(TABLE_EVIDENCE_LINKS, { pageSize: 1000 });

  const typeOptions = useMemo(() => {
    const types = new Set<string>();
    (documents ?? []).forEach((row) => {
      if (row.document_type) types.add(row.document_type);
    });
    return [
      { label: "All types", value: "all" },
      ...Array.from(types).sort().map((type) => ({ label: labelize(type), value: type })),
    ];
  }, [documents]);

  const statsByDocument = useMemo(() => {
    const map = new Map<string, { questionnaires: number; evidenceLinks: number }>();
    const ensure = (id: string) => {
      const current = map.get(id);
      if (current) return current;
      const next = { questionnaires: 0, evidenceLinks: 0 };
      map.set(id, next);
      return next;
    };
    (questionnaires ?? []).forEach((row) => {
      if (row.source_document_id) ensure(row.source_document_id).questionnaires += 1;
    });
    (evidenceLinks ?? []).forEach((row) => {
      if (row.target_type === "source_document") ensure(row.target_id).evidenceLinks += 1;
    });
    return map;
  }, [evidenceLinks, questionnaires]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (documents ?? []).filter((row) => {
      if (organizationId && row.organization_id !== organizationId) return false;
      if (typeFilter !== "all" && row.document_type !== typeFilter) return false;
      if (!q) return true;
      const hay = `${row.name ?? ""} ${row.file_name ?? ""} ${row.url ?? ""} ${row.source_system ?? ""} ${row.source_id ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [documents, organizationId, search, typeFilter]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <PageHeader
        title="Source Documents"
        subtitle="Uploaded, imported, and extracted source files used by questionnaires, evidence, and migration records."
      />

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--cv-fg-3)" }} />
          <Input aria-label="Search source documents" placeholder="Search source documents..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 30 }} />
        </div>
        <div style={{ minWidth: 180 }}>
          <ThemedSelect
            value={typeFilter}
            onChange={setTypeFilter}
            options={typeOptions}
            ariaLabel="Filter by document type"
          />
        </div>
        <div style={{ flex: 1 }} />
        <span className="cv-small">
          {filtered.length} of {(documents ?? []).length}
        </span>
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
        <LoadingSkeleton rows={6} label="Loading source documents" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Files}
          title="No source documents match"
          body="Source documents are created by questionnaire uploads, migration imports, and evidence attachments."
        />
      ) : (
        <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="cv-data-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 190 }}>Organization</th>
                <th>Document</th>
                <th style={{ width: 150 }}>Type</th>
                <th style={{ width: 110 }}>Questionnaires</th>
                <th style={{ width: 100 }}>Evidence</th>
                <th style={{ width: 145 }}>Source</th>
                <th style={{ width: 115 }}>Updated</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const stats = statsByDocument.get(row.id) ?? { questionnaires: 0, evidenceLinks: 0 };
                return (
                  <tr key={row.id} className="cv-data-table__row--clickable" onClick={() => navigate(`/source-documents/${row.id}`)}>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
                      {orgNameById.get(row.organization_id) ?? "Unknown organization"}
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <FileText size={15} style={{ color: "var(--cv-fg-3)", flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <Link className="cv-table-primary-link" to={`/source-documents/${row.id}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.name}
                          </Link>
                          <div style={{ color: "var(--cv-fg-3)", fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.file_name || (row.url ? "External source" : "Imported source")}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td><span className={"cv-chip " + docTone(row.document_type)}>{labelize(row.document_type)}</span></td>
                    <td><span className="cv-mono">{stats.questionnaires}</span></td>
                    <td><span className="cv-mono">{stats.evidenceLinks}</span></td>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
                      {row.source_system ? (
                        <span className="cv-chip cv-chip--neutral">{row.source_system}</span>
                      ) : row.url ? (
                        <ExternalLink size={14} />
                      ) : "-"}
                    </td>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>{fmtDate(row.updated_at ?? row.created_at)}</td>
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
