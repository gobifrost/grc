import { useGovernedTables } from "../lib/governed-tables";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useTable, useWorkflowMutation } from "bifrost";
import { Circle, Loader2, AlertCircle, ShieldAlert, ShieldCheck, Wrench, ShoppingCart, UserCog, ListChecks, RefreshCw } from "lucide-react";
import { TABLE_RECOMMENDATIONS } from "../lib/grc-tables";

const WF_CLASSIFY_GAPS = "workflows/grc_v2/grc_recommendations.py::classify_grc_questionnaire_gaps";

interface Props {
  questionnaireId: string;
  /** Set to false on the customer-facing view to hide msp_action cards (future). */
  includeMspActions?: boolean;
  readOnly?: boolean;
}

interface Recommendation {
  id: string;
  title: string;
  body: string;
  gap_kind: string;
  who_acts: string;
  severity: string;
  status: string;
  completion_notes?: string | null;
  metadata_json?: string | null;
}

const WHO_ACTS_META: Record<string, { label: string; icon: typeof Wrench }> = {
  msp_action: { label: "MSP action", icon: Wrench },
  customer_action: { label: "Customer action", icon: UserCog },
  vendor_purchase: { label: "Vendor purchase", icon: ShoppingCart },
  customer_decides: { label: "Customer decides", icon: AlertCircle },
  already_covered: { label: "Already covered", icon: ShieldCheck },
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: "cv-chip--red",
  high: "cv-chip--red",
  medium: "cv-chip--gold",
  low: "cv-chip--neutral",
};

export default function QuestionnaireRecommendations({ questionnaireId, includeMspActions = true, readOnly = false }: Props) {
  const tables = useGovernedTables();
  const [busyId, setBusyId] = useState<string | null>(null);
  const {
    rows: recommendations,
    loading: isLoading,
    error: recommendationsError,
  } = useTable<Recommendation>(TABLE_RECOMMENDATIONS, {
    where: { questionnaire_id: questionnaireId, status: "open" },
    pageSize: 1000,
  });

  const { mutate: classifyGaps, loading: rerunning } = useWorkflowMutation(WF_CLASSIFY_GAPS);

  async function rerun() {
    try {
      const result = (await classifyGaps({ questionnaire_id: questionnaireId })) as any;
      toast.success(`Recommendations refreshed: ${result?.created ?? 0} new, ${result?.reused ?? 0} kept.`);
    } catch (err) {
      toast.error(`Re-run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const recs: Recommendation[] = useMemo(
    () => [...recommendations]
      .filter((r) => includeMspActions || r.who_acts !== "msp_action")
      .sort((a, b) => {
        const severity = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
        const actor = { msp_action: 0, vendor_purchase: 1, customer_action: 2, customer_decides: 3, already_covered: 4 } as Record<string, number>;
        return (severity[a.severity] ?? 5) - (severity[b.severity] ?? 5)
          || (actor[a.who_acts] ?? 5) - (actor[b.who_acts] ?? 5);
      }),
    [recommendations, includeMspActions],
  );

  const grouped = useMemo(() => {
    const groups: Record<string, Recommendation[]> = {};
    for (const rec of recs) {
      const key = rec.who_acts || "other";
      (groups[key] ||= []).push(rec);
    }
    return groups;
  }, [recs]);

  async function handleDone(rec: Recommendation) {
    setBusyId(rec.id);
    try {
      await tables.update(TABLE_RECOMMENDATIONS, rec.id, {
        status: "done",
      });
      toast.success("Marked done.");
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(rec: Recommendation) {
    setBusyId(rec.id);
    try {
      await tables.update(TABLE_RECOMMENDATIONS, rec.id, {
        status: "dismissed",
        completion_notes: "Dismissed by user.",
      });
      toast.info("Dismissed.");
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="cv-card cv-card--pad-sm cv-flex" style={{ alignItems: "center", gap: 8, color: "var(--cv-fg-2)", fontSize: 13 }}>
        <Loader2 size={14} className="animate-spin" /> Loading recommendations…
      </div>
    );
  }
  if (recommendationsError) {
    return (
      <div className="cv-card cv-card--pad-sm cv-flex" style={{ alignItems: "center", gap: 8, color: "var(--cv-danger)", fontSize: 13 }}>
        <AlertCircle size={14} /> Failed to load recommendations.
      </div>
    );
  }
  if (recs.length === 0) {
    return (
      <div className="cv-card cv-card--pad-sm" style={{ fontSize: 13, color: "var(--cv-fg-2)", display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ListChecks size={14} /> No open recommendations. Build them from the current answers to surface gaps.
        </span>
        {!readOnly ? <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={rerun} disabled={rerunning}>
          {rerunning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {rerunning ? "Building…" : "Build recommendations"}
        </button> : null}
      </div>
    );
  }

  return (
    <div className="cv-card cv-card--pad-sm" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ListChecks size={14} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>Recommendations</span>
        <span className="cv-chip cv-chip--neutral cv-chip--sm">{recs.length} open</span>
        <span style={{ flex: 1 }} />
        {!readOnly ? <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={rerun} disabled={rerunning} title="Re-run the gap classifier on the current answers">
          {rerunning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {rerunning ? "Refreshing…" : "Refresh"}
        </button> : null}
      </div>

      {Object.entries(grouped).map(([who, items]) => {
        const meta = WHO_ACTS_META[who] || { label: who, icon: ShieldAlert };
        const Icon = meta.icon;
        return (
          <div key={who} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--cv-fg-2)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              <Icon size={12} /> {meta.label} ({items.length})
            </div>
            {items.map((rec) => (
              <div
                key={rec.id}
                style={{
                  border: "1px solid var(--cv-border-1)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  background: "var(--cv-bg-2)",
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                }}
              >
                {!readOnly ? <button
                  onClick={() => handleDone(rec)}
                  disabled={busyId === rec.id}
                  title="Mark done"
                  style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--cv-fg-2)", marginTop: 2 }}
                >
                  {busyId === rec.id ? <Loader2 size={16} className="animate-spin" /> : <Circle size={16} />}
                </button> : null}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 500, fontSize: 13, color: "var(--cv-fg-1)" }}>{rec.title}</span>
                    <span className={`cv-chip cv-chip--sm ${SEVERITY_CLASS[rec.severity] || "cv-chip--neutral"}`}>{rec.severity}</span>
                    <span className="cv-chip cv-chip--sm cv-chip--neutral">{rec.gap_kind.replace(/_/g, " ")}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--cv-fg-2)", marginTop: 4, lineHeight: 1.4 }}>{rec.body}</div>
                </div>
                {!readOnly ? <button
                  onClick={() => handleDismiss(rec)}
                  disabled={busyId === rec.id}
                  className="cv-btn cv-btn--secondary cv-btn--xs"
                  title="Dismiss this recommendation"
                >
                  Dismiss
                </button> : null}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
