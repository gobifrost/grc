import { useGovernedTables } from "../../lib/governed-tables";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useTable, useWorkflowQuery } from "bifrost";
import { Input } from "@/components/ui/input";

import { Search, Plus, FileText, ChevronRight, Loader2, AlertCircle, LayoutTemplate } from "lucide-react";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";

import PageHeader from "../../components/shared/PageHeader";
import EmptyState from "../../components/shared/EmptyState";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import BifrostDialogFrame from "../../components/shared/BifrostDialogFrame";
import StatusBadge from "../../components/shared/StatusBadge";
import ScopeBadge from "../../components/shared/ScopeBadge";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ThemedSelect from "../../components/shared/ThemedSelect";
import {
  TABLE_POLICIES,
  TABLE_POLICY_TEMPLATES,
  TABLE_POLICY_LINKS,
  WF_LIST_POLICY_CAMPAIGNS } from "../../lib/grc-tables";
import { useOrganizationView } from "../../lib/organization-view";
import { effectivePoliciesForOrganization } from "../../lib/effective-policy";
import { appliesToOrg } from "../../lib/scope";
import type { Policy, PolicyLink, PolicyRole, PolicyStatus, PolicyTemplate, PolicyType } from "../../lib/types";
import { campaignIncludesPolicy, signoffLabel, type PolicyCampaignSummary } from "../../lib/policy-signoff";

type StatusFilter = "all" | PolicyStatus;

function PolicySectionTabs({ active, onShowPolicies, onShowTemplates }: {
  active: "policies" | "templates";
  onShowPolicies: () => void;
  onShowTemplates: () => void;
}) {
  return (
    <nav className="cv-policy-section-tabs" aria-label="Policy Workspace">
      <button type="button" className={active === "policies" ? "is-active" : ""} onClick={onShowPolicies}>
        <FileText size={15} /> Policies
      </button>
      <button type="button" className={active === "templates" ? "is-active" : ""} onClick={onShowTemplates}>
        <LayoutTemplate size={15} /> Templates
      </button>
    </nav>
  );
}

function policyDisplayName(policy: Policy, policiesById: Map<string, Policy>): string {
  if (policy.policy_role === "extension" && policy.base_policy_id) {
    return policiesById.get(policy.base_policy_id)?.name ?? policy.name;
  }
  return policy.name;
}

function relTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "—";
    const diff = Date.now() - then;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

function policyTypeLabel(value?: PolicyType | null): string {
  if (value === "ai_acceptable_use") return "AI Acceptable Use Policy";
  if (value === "incident_response_plan") return "Incident Response Plan";
  if (value === "system_security_plan") return "System Security Plan";
  if (value === "procedure") return "Procedure";
  return "Policy";
}

function policyRoleLabel(value?: PolicyRole | null): string {
  if (value === "base") return "Global Base";
  if (value === "extension") return "Customer Addendum";
  return "Standalone";
}

function PolicyTemplatesIndex({ templates, loading, error, canEdit, createOpen, setCreateOpen, onShowPolicies }: {
  templates: PolicyTemplate[];
  loading: boolean;
  error: unknown;
  canEdit: boolean;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  onShowPolicies: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter((template) => [template.name, template.description, template.default_name]
      .some((value) => (value ?? "").toLowerCase().includes(query)));
  }, [search, templates]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <PageHeader
        title="Policies"
        subtitle="Write policies once, then use templates to create consistent documents without hiding them in code."
        actions={canEdit ? <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}><Plus size={14} style={{ marginRight: 6 }} />New Template</button> : undefined}
      />
      <PolicySectionTabs active="templates" onShowPolicies={onShowPolicies} onShowTemplates={() => undefined} />
      <div style={{ position: "relative", width: "min(100%, 360px)" }}>
        <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--cv-fg-3)" }} />
        <Input aria-label="Search Policy Templates" placeholder="Search templates..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ paddingLeft: 30 }} />
      </div>
      {error ? (
        <div className="cv-card" style={{ border: "1px solid var(--cv-rS-bd)", background: "var(--cv-rS)", padding: 14, display: "flex", alignItems: "center", gap: 10, color: "var(--cv-red)" }}><AlertCircle size={16} /><span>Failed to load templates. {String(error)}</span></div>
      ) : loading ? <LoadingSkeleton rows={5} label="Loading policy templates" /> : filtered.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title={search ? "No Matching Templates" : "No Policy Templates Yet"}
          body={search ? "Try a different search." : "Templates are editable starting points. They do not create customer work until someone uses one."}
          cta={canEdit && !search ? <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}><Plus size={14} style={{ marginRight: 6 }} />New Template</button> : null}
        />
      ) : (
        <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="cv-data-table cv-policy-table">
            <colgroup><col className="cv-policy-table__scope" /><col className="cv-policy-table__policy" /><col /><col /><col /><col className="cv-policy-table__navigate" /></colgroup>
            <thead><tr><th>Scope</th><th>Template</th><th>Document</th><th>Creates</th><th>Updated</th><th aria-label="Open Template" /></tr></thead>
            <tbody>{filtered.map((template) => (
              <tr key={template.id} className="cv-data-table__row--clickable" onClick={() => navigate(`/policy-templates/${template.id}`)}>
                <td className="cv-policy-table__scope-cell"><ScopeBadge row={template} /></td>
                <td className="cv-policy-table__policy-cell"><div className="cv-policy-table__policy-name"><LayoutTemplate size={15} style={{ color: "var(--cv-fg-3)", flexShrink: 0 }} /><Link className="cv-table-primary-link" to={`/policy-templates/${template.id}`}>{template.name}</Link>{template.version ? <span className="cv-mono" style={{ fontSize: 11, color: "var(--cv-fg-3)" }}>v{template.version}</span> : null}</div></td>
                <td>{policyTypeLabel(template.policy_type)}</td>
                <td>{policyRoleLabel(template.default_policy_role)}</td>
                <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>{relTime(template.updated_at)}</td>
                <td><ChevronRight size={15} style={{ color: "var(--cv-fg-3)" }} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {canEdit ? <CreateTemplateDialog open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}

export default function PoliciesPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const templatesActive = searchParams.get("view") === "templates";
  const { organizationId } = useOrganizationView();
  const { canEdit } = useGrcPermissions();

  const navigate = useNavigate();

  const {
    rows: policyRowsRaw,
    loading: policiesLoading,
    error: policiesError } = useTable<Policy>(TABLE_POLICIES, {
    pageSize: 1000,
    order_by: "updated_at",
    order_dir: "desc" });

  const { rows: linkRowsRaw } = useTable<PolicyLink>(TABLE_POLICY_LINKS, {
    pageSize: 1000 });
  const { rows: templateRowsRaw, loading: templatesLoading, error: templatesError } = useTable<PolicyTemplate>(TABLE_POLICY_TEMPLATES, {
    pageSize: 1000,
    order_by: "updated_at",
    order_dir: "desc" });
  const campaignParams = useMemo(() => ({ organization_id: organizationId ?? "" }), [organizationId]);
  const campaignQuery = useWorkflowQuery<{ campaigns?: PolicyCampaignSummary[] }>(WF_LIST_POLICY_CAMPAIGNS, campaignParams);

  const policies = useMemo(() => policyRowsRaw ?? [], [policyRowsRaw]);
  const links = useMemo(() => linkRowsRaw ?? [], [linkRowsRaw]);
  const templates = useMemo(() => templateRowsRaw ?? [], [templateRowsRaw]);
  const visibleTemplates = useMemo(
    () => organizationId ? templates.filter((template) => appliesToOrg(template, organizationId)) : templates,
    [organizationId, templates],
  );
  const policiesById = useMemo(() => new Map(policies.map((policy) => [policy.id, policy])), [policies]);
  const linkCountByPolicy = useMemo(() => {
    const m = new Map<string, number>();
    links.forEach((l) => m.set(l.policy_id, (m.get(l.policy_id) ?? 0) + 1));
    return m;
  }, [links]);

  const effectivePolicies = useMemo(
    () => effectivePoliciesForOrganization(policies, organizationId),
    [organizationId, policies],
  );
  const campaignByPolicy = useMemo(() => {
    const byPolicy = new Map<string, PolicyCampaignSummary>();
    for (const campaign of campaignQuery.data?.campaigns ?? []) {
      for (const policy of effectivePolicies) {
        if (campaignIncludesPolicy(campaign, policy.id) && !byPolicy.has(policy.id)) byPolicy.set(policy.id, campaign);
      }
    }
    return byPolicy;
  }, [campaignQuery.data?.campaigns, effectivePolicies]);

  const counts = useMemo(() => {
    const c = { all: effectivePolicies.length, draft: 0, active: 0, archived: 0 };
    effectivePolicies.forEach((p) => {
      const s = (p.status ?? "draft") as PolicyStatus;
      if (s === "draft") c.draft += 1;
      else if (s === "active") c.active += 1;
      else if (s === "archived") c.archived += 1;
    });
    return c;
  }, [effectivePolicies]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return effectivePolicies.filter((p) => {
      if (statusFilter !== "all") {
        const s = (p.status ?? "draft") as PolicyStatus;
        if (s !== statusFilter) return false;
      }
      if (!q) return true;
      return (
        policyDisplayName(p, policiesById).toLowerCase().includes(q) ||
        (p.name ?? "").toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [effectivePolicies, policiesById, statusFilter, search]);

  const filters: Array<{ value: StatusFilter; label: string; count: number }> = [
    { value: "all", label: "All", count: counts.all },
    { value: "draft", label: "Draft", count: counts.draft },
    { value: "active", label: "Active", count: counts.active },
    { value: "archived", label: "Archived", count: counts.archived },
  ];

  if (templatesActive) {
    return (
      <PolicyTemplatesIndex
        templates={visibleTemplates}
        loading={templatesLoading}
        error={templatesError}
        canEdit={canEdit}
        createOpen={createTemplateOpen}
        setCreateOpen={setCreateTemplateOpen}
        onShowPolicies={() => setSearchParams({})}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
      <PageHeader
        title="Policies"
        subtitle="Manage governance policies, link them to controls, and track review cycles."
        actions={canEdit ? (
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} style={{ marginRight: 6 }} />
            New Policy
          </button>
        ) : undefined}
      />
      <PolicySectionTabs active="policies" onShowPolicies={() => setSearchParams({})} onShowTemplates={() => setSearchParams({ view: "templates" })} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--cv-fg-3)" }}
          />
          <Input
            aria-label="Search Policies"
            placeholder="Search policies..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 30 }}
          />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {filters.map((f) => {
            const active = statusFilter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                className={
                  "cv-btn cv-btn--sm " +
                  (active ? "cv-btn--primary" : "cv-btn--secondary")
                }
                onClick={() => setStatusFilter(f.value)}
              >
                {f.label}
                <span
                  style={{
                    marginLeft: 6,
                    opacity: 0.75,
                    fontVariantNumeric: "tabular-nums" }}
                >
                  {f.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {policiesError ? (
        <div
          className="cv-card"
          style={{
            border: "1px solid var(--cv-rS-bd)",
            background: "var(--cv-rS)",
            padding: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--cv-red)" }}
        >
          <AlertCircle size={16} />
          <span>Failed to load policies. {String(policiesError)}</span>
        </div>
      ) : policiesLoading ? (
        <LoadingSkeleton rows={6} label="Loading policies" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={
            search || statusFilter !== "all"
              ? "No Matching Policies"
              : "No Policies Yet"
          }
          body={
            search || statusFilter !== "all"
              ? "Try adjusting the search or filter."
              : "Create your first policy to start documenting your governance program."
          }
          cta={
            canEdit && !search && statusFilter === "all" ? (
              <button
                type="button"
                className="cv-btn cv-btn--primary cv-btn--sm"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={14} style={{ marginRight: 6 }} />
                New Policy
              </button>
            ) : null
          }
        />
      ) : (
        <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="cv-data-table cv-policy-table">
            <colgroup>
              <col className="cv-policy-table__scope" />
              <col className="cv-policy-table__policy" />
              <col className="cv-policy-table__status" />
              <col className="cv-policy-table__signoff" />
              <col className="cv-policy-table__links" />
              <col className="cv-policy-table__updated" />
              <col className="cv-policy-table__navigate" />
            </colgroup>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Policy</th>
                <th>Status</th>
                <th>Sign-Off</th>
                <th>Links</th>
                <th>Updated</th>
                <th aria-label="Open Policy" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const linkCount = linkCountByPolicy.get(p.id) ?? 0;
                return (
                  <tr
                    key={p.id}
                    className="cv-data-table__row--clickable"
                    onClick={() => navigate(`/policies/${p.id}`)}
                  >
                    <td className="cv-policy-table__scope-cell" style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
                      <ScopeBadge row={p} />
                    </td>
                    <td className="cv-policy-table__policy-cell">
                      <div className="cv-policy-table__policy-name">
                        <FileText size={15} style={{ color: "var(--cv-fg-3)", flexShrink: 0 }} />
                        <Link className="cv-table-primary-link" to={`/policies/${p.id}`}>{policyDisplayName(p, policiesById)}</Link>
                        {p.version ? (
                          <span style={{ fontSize: 11, color: "var(--cv-fg-3)", fontFamily: "var(--cv-font-mono)" }}>
                            v{p.version}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <StatusBadge kind="policy" value={p.status} />
                    </td>
                    <td><span className="cv-mono">{signoffLabel(campaignByPolicy.get(p.id))}</span></td>
                    <td><span className="cv-mono">{linkCount}</span></td>
                    <td style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>{relTime(p.updated_at)}</td>
                    <td><ChevronRight size={15} style={{ color: "var(--cv-fg-3)" }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit ? <CreatePolicyDialog open={createOpen} onOpenChange={setCreateOpen} policies={policies} templates={visibleTemplates} /> : null}
    </div>
  );
}

interface CreatePolicyDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  policies: Policy[];
  templates: PolicyTemplate[];
}

function CreatePolicyDialog({ open, onOpenChange, policies, templates }: CreatePolicyDialogProps) {
  const tables = useGovernedTables();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const userOrgId = user?.organizationId && user.organizationId.length > 0 ? user.organizationId : null;
  const [name, setName] = useState("");
  const [organizationScope, setOrganizationScope] = useState<string[] | null>(null);
  const [policyRole, setPolicyRole] = useState<PolicyRole>("standalone");
  const [policyType, setPolicyType] = useState<PolicyType>("policy");
  const [basePolicyId, setBasePolicyId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setName("");
    setOrganizationScope(null);
    setPolicyRole("standalone");
    setPolicyType("policy");
    setBasePolicyId("");
    setTemplateId("");
  }

  async function submit() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (policyRole === "extension" && organizationScope?.length !== 1) {
      toast.error("Choose exactly one customer for an extension");
      return;
    }
    if (policyRole === "extension" && !basePolicyId) {
      toast.error("Choose a global base policy");
      return;
    }
    if (policyRole !== "base" && organizationScope?.length === 0) {
      toast.error("Choose one organization or select All");
      return;
    }
    if (policyRole !== "base" && organizationScope && organizationScope.length > 1) {
      toast.error("Policies must be global or scoped to one organization; use a global base plus customer extensions");
      return;
    }
    setSaving(true);
    try {
      const selectedBase = policies.find((policy) => policy.id === basePolicyId);
      const selectedTemplate = templates.find((template) => template.id === templateId);
      const data: Record<string, unknown> = {
        name: name.trim(),
        status: "draft" as PolicyStatus,
        content: selectedTemplate?.content ?? "",
        version: "1.0",
        organization_id: policyRole === "base" || organizationScope === null
          ? null
          : organizationScope[0] ?? userOrgId,
        applied_organizations: policyRole === "base" ? null : organizationScope,
        excluded_organizations: [],
        policy_type: policyType,
        policy_role: policyRole,
        base_policy_id: policyRole === "extension" ? basePolicyId : null,
        extension_mode: policyRole === "extension" ? "supplement" : null,
        reviewed_base_version: policyRole === "extension"
          ? selectedBase?.version ?? null
          : null,
        template_id: selectedTemplate?.id ?? null,
        template_version: selectedTemplate?.version ?? null };
      const created = await tables.insert(TABLE_POLICIES, data);
      reset();
      onOpenChange(false);
      if (created?.id) {
        navigate(`/policies/${created.id}`);
      }
    } catch (err) {
      toast.error("Failed to create policy");
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <BifrostDialogFrame
      onDismiss={() => {
        reset();
        onOpenChange(false);
      }}
      dismissDisabled={saving}
      labelledBy="new-policy-title"
    >
        <div className="cv-dialog__header">
          <h2 id="new-policy-title" className="cv-dialog__title">New Policy</h2>
          <p id="new-policy-description" className="cv-small" style={{ margin: "4px 0 0" }}>
            Start a customer policy or a reusable global catalog policy.
          </p>
        </div>
        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ThemedSelect
            value={templateId}
            onChange={(value) => {
              setTemplateId(value);
              if (value === "__blank") return;
              const template = templates.find((item) => item.id === value);
              if (!template) return;
              const nextRole = template.default_policy_role ?? "standalone";
              setPolicyRole(nextRole);
              setPolicyType(template.policy_type ?? "policy");
              setName(template.default_name ?? template.name);
              if (nextRole === "base") setOrganizationScope(null);
              if (nextRole === "extension") {
                const matchingBase = policies.find((policy) => policy.policy_role === "base" && policy.policy_type === (template.base_policy_type ?? template.policy_type));
                setBasePolicyId(matchingBase?.id ?? "");
              }
            }}
            options={[
              { label: "Blank Policy", value: "__blank", hint: "Start with an empty editor" },
              ...templates.filter((template) => template.status === "active").map((template) => ({
                label: template.name,
                value: template.id,
                hint: template.description ?? `${template.version ?? "1.0"} · ${policyTypeLabel(template.policy_type)}`,
              })),
            ]}
            placeholder="Blank Policy"
            ariaLabel="Start From Template"
          />
          <ThemedSelect
            value={policyRole}
            onChange={(value) => {
              const next = value as PolicyRole;
              setPolicyRole(next);
              if (next === "base") setOrganizationScope(null);
            }}
            options={[
              { label: "Standalone Policy", value: "standalone", hint: "A complete policy with its own scope" },
              { label: "Global Base Policy", value: "base", hint: "Reusable master inherited by customers" },
              { label: "Customer Extension", value: "extension", hint: "Customer facts and explicit deviations" },
            ]}
            ariaLabel="Policy Relationship"
          />
          <ThemedSelect
            value={policyType}
            onChange={(value) => setPolicyType(value as PolicyType)}
            options={[
              { label: "Policy", value: "policy" },
              { label: "AI Acceptable Use Policy", value: "ai_acceptable_use" },
              { label: "Incident Response Plan", value: "incident_response_plan" },
              { label: "System Security Plan", value: "system_security_plan" },
              { label: "Procedure", value: "procedure" },
            ]}
            ariaLabel="Document Type"
          />
          {policyRole === "extension" ? (
            <ThemedSelect
              value={basePolicyId}
              onChange={setBasePolicyId}
              options={policies
                .filter((policy) => policy.policy_role === "base")
                .map((policy) => ({ label: `${policy.name} (v${policy.version ?? "—"})`, value: policy.id }))}
              placeholder="Select a Global Base Policy…"
              ariaLabel="Base Policy"
            />
          ) : null}
          {policyRole === "extension" && basePolicyId && templateId && templateId !== "__blank" ? <div className="cv-callout cv-callout--info"><div className="cv-callout__body">This addendum will copy the selected template. You can fill its customer facts directly in the policy editor.</div></div> : null}
          {policyRole !== "base" ? (
            <OrgScopeField
              id="new-policy-organization-scope"
              value={organizationScope}
              onChange={setOrganizationScope}
              disabled={saving}
            />
          ) : (
            <div className="cv-callout cv-callout--info">
              Global base policies apply to every current and future customer unless excluded.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="new-policy-name"
              style={{
                fontSize: 11,
                letterSpacing: 1.5,
                textTransform: "uppercase",
                color: "var(--cv-fg-3)" }}
            >
              Name *
            </label>
            <Input
              id="new-policy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acceptable Use Policy"
            />
          </div>
        </div>
        <div className="cv-dialog__footer">
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            onClick={() => {
              if (!saving) {
                reset();
                onOpenChange(false);
              }
            }}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cv-btn cv-btn--primary cv-btn--sm"
            onClick={submit}
            disabled={saving || !name.trim()}
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" style={{ marginRight: 6 }} />
                Creating...
              </>
            ) : (
              "Create Policy"
            )}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}

function CreateTemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const tables = useGovernedTables();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [policyType, setPolicyType] = useState<PolicyType>("policy");
  const [defaultRole, setDefaultRole] = useState<PolicyRole>("standalone");
  const [organizationScope, setOrganizationScope] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setName("");
    setDescription("");
    setPolicyType("policy");
    setDefaultRole("standalone");
    setOrganizationScope(null);
  }

  async function submit() {
    if (!name.trim()) return toast.error("Name is required");
    setSaving(true);
    try {
      const created = await tables.insert(TABLE_POLICY_TEMPLATES, {
        name: name.trim(),
        description: description.trim() || null,
        content: "",
        version: "1.0",
        status: "draft",
        policy_type: policyType,
        default_policy_role: defaultRole,
        default_extension_mode: defaultRole === "extension" ? "supplement" : null,
        base_policy_type: defaultRole === "extension" ? policyType : null,
        organization_id: organizationScope?.length === 1 ? organizationScope[0] : null,
        applied_organizations: organizationScope,
        excluded_organizations: [],
      });
      reset();
      onOpenChange(false);
      if (created?.id) navigate(`/policy-templates/${created.id}`);
    } catch (error) {
      console.error(error);
      toast.error("Failed to create template");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <BifrostDialogFrame onDismiss={() => { if (!saving) { reset(); onOpenChange(false); } }} dismissDisabled={saving} labelledBy="new-template-title">
      <div className="cv-dialog__header">
        <h2 id="new-template-title" className="cv-dialog__title">New Policy Template</h2>
        <p className="cv-small" style={{ margin: "4px 0 0" }}>Create an editable starting point. Nothing is assigned to a customer until the template is used.</p>
      </div>
      <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}><label className="cv-section-label" htmlFor="new-template-name">Name *</label><Input id="new-template-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer System Security Plan Addendum" /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}><label className="cv-section-label" htmlFor="new-template-description">Description</label><Input id="new-template-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="When and why someone should use this template" /></div>
        <ThemedSelect value={policyType} onChange={(value) => setPolicyType(value as PolicyType)} options={[
          { label: "Policy", value: "policy" },
          { label: "AI Acceptable Use Policy", value: "ai_acceptable_use" },
          { label: "Incident Response Plan", value: "incident_response_plan" },
          { label: "System Security Plan", value: "system_security_plan" },
          { label: "Procedure", value: "procedure" },
        ]} ariaLabel="Document Type" />
        <ThemedSelect value={defaultRole} onChange={(value) => setDefaultRole(value as PolicyRole)} options={[
          { label: "Standalone Policy", value: "standalone", hint: "Creates a complete policy" },
          { label: "Global Base Policy", value: "base", hint: "Creates a master inherited by customers" },
          { label: "Customer Addendum", value: "extension", hint: "Creates a customer-specific supplement" },
        ]} ariaLabel="Template Creates" />
        <OrgScopeField id="new-template-scope" value={organizationScope} onChange={setOrganizationScope} disabled={saving} />
      </div>
      <div className="cv-dialog__footer">
        <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" disabled={saving} onClick={() => { reset(); onOpenChange(false); }}>Cancel</button>
        <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" disabled={saving || !name.trim()} onClick={submit}>{saving ? <><Loader2 size={14} className="animate-spin" style={{ marginRight: 6 }} />Creating...</> : "Create Template"}</button>
      </div>
    </BifrostDialogFrame>
  );
}
