import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTable } from "bifrost";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { BookOpen, ClipboardCheck, AlertTriangle, FileText, Shield, CalendarClock, ArrowRight, View } from "lucide-react";

import PageHeader from "../components/shared/PageHeader";
import EmptyState from "../components/shared/EmptyState";
import StatTile from "../components/shared/StatTile";
import SectionHeader from "../components/shared/SectionHeader";
import ProgressRing from "../components/shared/ProgressRing";
import StatusBadge from "../components/shared/StatusBadge";
import RiskBadge from "../components/shared/RiskBadge";
import LoadingSkeleton from "../components/shared/LoadingSkeleton";
import { useOrgNamesMap, useUserNameLookup } from "../lib/directory";
import { appliesToOrg } from "../lib/scope";
import { useOrganizationView } from "../lib/organization-view";
import { effectivePoliciesForOrganization } from "../lib/effective-policy";
import {
  TABLE_FRAMEWORKS,
  TABLE_ASSESSMENTS,
  TABLE_ASSESSMENT_CONTROLS,
  TABLE_RISKS,
  TABLE_POLICIES,
} from "../lib/grc-tables";
import type {
  Framework,
  Assessment,
  AssessmentControl,
  Risk,
  Policy,
  RiskLevel,
} from "../lib/types";

const RISK_LEVELS: RiskLevel[] = ["very_high", "high", "medium", "low"];
const RISK_LEVEL_RANK: Record<RiskLevel, number> = { very_high: 0, high: 1, medium: 2, low: 3 };
const REVIEW_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function Dashboard() {
  const { organizationId } = useOrganizationView();
  const orgNameById = useOrgNamesMap();
  const userName = useUserNameLookup();
  // Pure table aggregation — no workflow execution. Each useTable snapshots and
  // then subscribes over WebSocket, so the dashboard updates live as data changes.
  const { rows: frameworkRows, total: frameworksTotal, loading: fwLoading } =
    useTable<Framework>(TABLE_FRAMEWORKS, { pageSize: 200, order_by: "name", order_dir: "asc" });
  const { rows: assessmentRows, loading: aLoading, error: aError } =
    useTable<Assessment>(TABLE_ASSESSMENTS, { pageSize: 1000, order_by: "updated_at", order_dir: "desc" });
  const { rows: riskRows, loading: rLoading, error: rError } =
    useTable<Risk>(TABLE_RISKS, { pageSize: 1000, order_by: "updated_at", order_dir: "desc" });
  const { rows: policyRows, loading: pLoading, error: pError } =
    useTable<Policy>(TABLE_POLICIES, { pageSize: 1000 });
  const { rows: acRows } = useTable<AssessmentControl>(TABLE_ASSESSMENT_CONTROLS, { pageSize: 1000 });

  const assessments = useMemo(
    () =>
      (assessmentRows ?? []).filter((row) => {
        return organizationId ? appliesToOrg(row, organizationId) : true;
      }),
    [assessmentRows, organizationId],
  );
  const risks = useMemo(
    () =>
      (riskRows ?? []).filter((row) => {
        return organizationId ? appliesToOrg(row, organizationId) : true;
      }),
    [organizationId, riskRows],
  );
  const policies = useMemo(
    () =>
      effectivePoliciesForOrganization(policyRows ?? [], organizationId),
    [organizationId, policyRows],
  );

  const activeAssessments = useMemo(
    () => assessments.filter((a) => a.status === "in_progress").length,
    [assessments],
  );
  const avgProgress = useMemo(() => {
    if (assessments.length === 0) return 0;
    const sum = assessments.reduce((acc, a) => acc + (a.progress_percentage ?? 0), 0);
    return sum / assessments.length;
  }, [assessments]);
  const openRisks = useMemo(() => risks.filter((r) => r.status === "open").length, [risks]);

  const riskByLevel = useMemo(() => {
    const m: Record<RiskLevel, number> = { very_high: 0, high: 0, medium: 0, low: 0 };
    risks.forEach((r) => {
      if (r.risk_level && r.risk_level in m) m[r.risk_level] += 1;
    });
    return m;
  }, [risks]);

  const upcomingReviews = useMemo(() => {
    const horizon = Date.now() + REVIEW_HORIZON_MS;
    return policies.filter((p) => {
      if (!p.review_date) return false;
      const t = new Date(p.review_date).getTime();
      return !Number.isNaN(t) && t <= horizon;
    }).length;
  }, [policies]);

  const recent = useMemo(() => assessments.slice(0, 5), [assessments]);
  const topRisks = useMemo(
    () =>
      risks
        .filter((r) => r.status === "open")
        .sort(
          (a, b) =>
            (RISK_LEVEL_RANK[a.risk_level ?? "low"] ?? 9) -
            (RISK_LEVEL_RANK[b.risk_level ?? "low"] ?? 9),
        )
        .slice(0, 5),
    [risks],
  );

  // Per-framework compliance roll-up from every assessment's control rows.
  const fwSummary = useMemo(() => {
    const byId = new Map<
      string,
      { name: string; total: number; compliant: number; partial: number; nonc: number }
    >();
    (frameworkRows ?? []).forEach((f) => {
      byId.set(f.id, { name: f.name ?? "Untitled", total: 0, compliant: 0, partial: 0, nonc: 0 });
    });
    const assessmentToFramework = new Map<string, string>();
    assessments.forEach((a) => {
      if (a.framework_id) assessmentToFramework.set(a.id, a.framework_id);
    });
    (acRows ?? []).forEach((ac) => {
      const fid = assessmentToFramework.get(ac.assessment_id);
      if (!fid) return;
      const entry = byId.get(fid);
      if (!entry) return;
      entry.total += 1;
      if (ac.status === "compliant") entry.compliant += 1;
      else if (ac.status === "partially_compliant") entry.partial += 1;
      else if (ac.status === "non_compliant") entry.nonc += 1;
    });
    return Array.from(byId.entries()).map(([id, v]) => ({ id, ...v }));
  }, [frameworkRows, acRows, assessments]);

  const isLoading = aLoading || rLoading || pLoading;
  const loadError = aError ?? rError ?? pError;

  if (isLoading) {
    return <LoadingSkeleton variant="page" rows={5} label="Loading dashboard" />;
  }

  if (loadError) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Compliance posture at a glance." />
        <Alert variant="destructive">
          <AlertTitle>Couldn't load dashboard</AlertTitle>
          <AlertDescription>{String(loadError.message ?? loadError)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const frameworkNameById = (id: string) =>
    (frameworkRows ?? []).find((f) => f.id === id)?.name ?? "Framework";
  const contextLabel =
    organizationId
        ? orgNameById.get(organizationId) ?? "selected organization"
        : "managed organizations";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <PageHeader
        title="Dashboard"
        subtitle={`Compliance posture, active assessments, and open risks across ${contextLabel}.`}
      />

      {/* Stat tiles */}
      <div className="cv-stat-row">
        <StatTile label="Frameworks" value={frameworksTotal} icon={BookOpen} iconTone="teal" />
        <StatTile
          label="Active assessments"
          value={activeAssessments}
          sub={`${assessments.length} in view`}
          icon={ClipboardCheck}
          iconTone="purple"
        />
        <StatTile
          label="Open risks"
          value={openRisks}
          sub={`${risks.length} in view`}
          icon={AlertTriangle}
          iconTone={openRisks > 0 ? "red" : "green"}
          numberTone={openRisks > 0 ? "bad" : "good"}
        />
        <StatTile label="Policies" value={policies.length} icon={FileText} iconTone="teal" />
        <StatTile
          label="Avg compliance"
          value={`${Math.round(avgProgress)}%`}
          sub={
            upcomingReviews > 0
              ? `${upcomingReviews} review${upcomingReviews === 1 ? "" : "s"} due`
              : "Across all assessments"
          }
          icon={Shield}
          iconTone={avgProgress >= 80 ? "green" : avgProgress >= 50 ? "gold" : "red"}
          numberTone={avgProgress >= 80 ? "good" : avgProgress >= 50 ? "warn" : "bad"}
        />
      </div>

      {/* Frameworks at a glance + Recent activity */}
      <div className="cv-two-col">
        <div>
          <SectionHeader
            label="Frameworks at a glance"
            action={
              <Link to="/frameworks" className="cv-link" style={{ fontSize: 12 }}>
                View all
              </Link>
            }
          />
          <div className="cv-card cv-card--pad-sm">
            {fwLoading ? (
              <LoadingSkeleton variant="cards" rows={3} label="Loading framework summaries" />
            ) : (frameworkRows?.length ?? 0) === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No frameworks yet"
                body="Add a framework to start tracking controls and assessments."
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {fwSummary.map((fw, idx) => {
                  const pct = fw.total > 0 ? Math.round((fw.compliant / fw.total) * 100) : 0;
                  return (
                    <Link
                      key={fw.id}
                      to={`/frameworks/${fw.id}`}
                      style={{
                        textDecoration: "none",
                        color: "inherit",
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "12px 8px",
                        borderTop: idx === 0 ? "0" : "1px solid var(--cv-border)",
                      }}
                    >
                      <ProgressRing
                        value={pct}
                        size={52}
                        strokeWidth={6}
                        label={`${pct}%`}
                        tone={fw.total === 0 ? "teal" : "auto"}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 500,
                            color: "var(--cv-fg-1)",
                            marginBottom: 4,
                          }}
                        >
                          {fw.name}
                        </div>
                        <div className="cv-small">
                          {fw.total === 0
                            ? "No active assessments"
                            : `${fw.compliant} compliant · ${fw.partial} partial · ${fw.nonc} non-compliant`}
                        </div>
                      </div>
                      <ArrowRight size={14} className="cv-small" />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div>
          <SectionHeader
            label="Recent activity"
            action={
              <Link to="/assessments" className="cv-link" style={{ fontSize: 12 }}>
                View all
              </Link>
            }
          />
          <div className="cv-card cv-card--pad-sm">
            {recent.length === 0 ? (
              <EmptyState
                icon={ClipboardCheck}
                title="No recent activity"
                body="When assessments are updated they'll show up here."
              />
            ) : (
              <table className="cv-data-table" style={{ borderRadius: 0, border: 0 }}>
                <thead>
                  <tr>
                    <th>Assessment</th>
                    <th>Status</th>
                    <th style={{ width: 100 }}>Progress</th>
                    <th style={{ width: 80 }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/assessments/${a.id}`} className="cv-link">
                          {a.name ?? "Untitled"}
                        </Link>
                        <div className="cv-small">{frameworkNameById(a.framework_id)}</div>
                      </td>
                      <td>
                        <StatusBadge kind="assessment" value={a.status} />
                      </td>
                      <td>
                        <div className="cv-meter">
                          <div
                            className={
                              "cv-meter__fill " +
                              ((a.progress_percentage ?? 0) >= 80
                                ? "cv-meter__fill--good"
                                : (a.progress_percentage ?? 0) >= 40
                                ? "cv-meter__fill--teal"
                                : "cv-meter__fill--warn")
                            }
                            style={{
                              width: `${Math.max(0, Math.min(100, a.progress_percentage ?? 0))}%`,
                            }}
                          />
                        </div>
                        <div className="cv-small" style={{ marginTop: 4 }}>
                          {Math.round(a.progress_percentage ?? 0)}%
                        </div>
                      </td>
                      <td className="cv-small">{fmtDate(a.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Risk breakdown + top risks */}
      <div className="cv-two-col">
        <div>
          <SectionHeader label="Risk breakdown" />
          <div className="cv-card">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {RISK_LEVELS.map((lvl) => (
                <div
                  key={lvl}
                  style={{
                    background: "var(--cv-bg-3)",
                    border: "1px solid var(--cv-border)",
                    borderRadius: "var(--cv-r-md)",
                    padding: 14,
                    textAlign: "center",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <div className="cv-stat-tile__num" style={{ fontSize: 22 }}>
                    {riskByLevel[lvl] ?? 0}
                  </div>
                  <RiskBadge level={lvl} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <SectionHeader
            label="Top open risks"
            action={
              <Link to="/risks" className="cv-link" style={{ fontSize: 12 }}>
                View all
              </Link>
            }
          />
          <div className="cv-card cv-card--pad-sm">
            {topRisks.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="No open risks"
                body="When risks are added to the register they'll show up here."
              />
            ) : (
              <table className="cv-data-table" style={{ borderRadius: 0, border: 0 }}>
                <thead>
                  <tr>
                    <th>Risk</th>
                    <th style={{ width: 110 }}>Level</th>
                    <th style={{ width: 140 }}>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {topRisks.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/risks/${r.id}`} className="cv-link">
                          {r.name ?? "Untitled risk"}
                        </Link>
                      </td>
                      <td>
                        <RiskBadge level={r.risk_level} />
                      </td>
                      <td className="cv-small">{userName(r.owner)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Upcoming reviews callout */}
      {upcomingReviews > 0 ? (
        <div className="cv-callout cv-callout--warn">
          <div className="cv-callout__label">
            <CalendarClock size={14} />
            Upcoming policy reviews
          </div>
          <div className="cv-callout__body">
            {upcomingReviews} polic{upcomingReviews === 1 ? "y is" : "ies are"} due for review in the next 30 days.{" "}
            <Link to="/policies" className="cv-link">
              Review now →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
