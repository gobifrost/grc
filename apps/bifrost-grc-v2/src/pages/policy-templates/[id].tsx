import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { tables } from "bifrost";
import { toast } from "sonner";
import { ArrowLeft, Eye, FilePenLine, LayoutTemplate, Loader2, Save, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import PageHeader from "../../components/shared/PageHeader";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import MarkdownEditor from "../../components/shared/MarkdownEditor";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ScopeBadge from "../../components/shared/ScopeBadge";
import ThemedSelect from "../../components/shared/ThemedSelect";
import MarkdownPreview from "../../components/policy-builder/MarkdownPreview";
import { confirm } from "../../components/shared/ConfirmDialog";
import { useGrcPermissions } from "../../lib/current-user";
import { extractFactKeys } from "../../lib/fact-markers";
import { TABLE_POLICY_TEMPLATES } from "../../lib/grc-tables";
import { STANDARD_FACT_DEFINITIONS } from "../../lib/standard-facts";
import { getRow } from "../../lib/table-helpers";
import { scopeOrgIds } from "../../lib/scope";
import type { PolicyRole, PolicyStatus, PolicyTemplate, PolicyType } from "../../lib/types";

export default function PolicyTemplateDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canEdit } = useGrcPermissions();
  const [template, setTemplate] = useState<PolicyTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [version, setVersion] = useState("1.0");
  const [status, setStatus] = useState<PolicyStatus>("draft");
  const [policyType, setPolicyType] = useState<PolicyType>("policy");
  const [defaultRole, setDefaultRole] = useState<PolicyRole>("standalone");
  const [defaultName, setDefaultName] = useState("");

  async function load() {
    setLoading(true);
    try {
      const row = await getRow<PolicyTemplate>(TABLE_POLICY_TEMPLATES, id);
      setTemplate(row);
      if (row) {
        setName(row.name ?? "");
        setDescription(row.description ?? "");
        setContent(row.content ?? "");
        setVersion(row.version ?? "1.0");
        setStatus(row.status ?? "draft");
        setPolicyType(row.policy_type ?? "policy");
        setDefaultRole(row.default_policy_role ?? "standalone");
        setDefaultName(row.default_name ?? "");
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to load policy template");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [id]);

  const referencedFacts = useMemo(() => extractFactKeys(content), [content]);

  async function save(patch?: Partial<PolicyTemplate>) {
    if (!template || !canEdit) return;
    setSaving(true);
    try {
      const next: Partial<PolicyTemplate> = patch ?? {
        name: name.trim(),
        description: description.trim() || null,
        content,
        version: version.trim() || "1.0",
        status,
        policy_type: policyType,
        default_policy_role: defaultRole,
        default_extension_mode: defaultRole === "extension" ? "supplement" : null,
        default_name: defaultName.trim() || null,
        base_policy_type: defaultRole === "extension" ? policyType : null,
      };
      await tables.update(TABLE_POLICY_TEMPLATES, template.id, next);
      setTemplate({ ...template, ...next });
      toast.success("Template saved");
    } catch (error) {
      console.error(error);
      toast.error("Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSkeleton rows={7} label="Loading policy template" />;
  if (!template) return <div className="cv-card" style={{ padding: 24 }}>Policy template not found.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, minHeight: 0 }}>
      <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/policies?view=templates")}><ArrowLeft size={14} style={{ marginRight: 6 }} />Policy Templates</button>
      <PageHeader
        crumb="Policy Template"
        title={<span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}><LayoutTemplate size={21} />{template.name}</span>}
        subtitle={<span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}><ScopeBadge row={template} /><span>This is a reusable starting point, not an effective customer policy.</span></span>}
        actions={canEdit ? <><button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" disabled={deleting} onClick={async () => {
          const approved = await confirm({ title: "Delete This Template?", body: "Existing policies created from it will remain unchanged.", confirmLabel: "Delete Template", destructive: true });
          if (!approved) return;
          setDeleting(true);
          try { await tables.delete(TABLE_POLICY_TEMPLATES, template.id); navigate("/policies?view=templates"); toast.success("Template deleted"); }
          catch (error) { console.error(error); toast.error("Failed to delete template"); setDeleting(false); }
        }}><Trash2 size={14} style={{ marginRight: 6 }} />Delete</button><button type="button" className="cv-btn cv-btn--primary cv-btn--sm" disabled={saving || !name.trim()} onClick={() => save()}>{saving ? <Loader2 size={14} className="animate-spin" style={{ marginRight: 6 }} /> : <Save size={14} style={{ marginRight: 6 }} />}Save</button></> : undefined}
      />

      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview"><Eye size={13} style={{ marginRight: 6 }} />Preview</TabsTrigger>
          <TabsTrigger value="editor"><FilePenLine size={13} style={{ marginRight: 6 }} />Editor</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="preview" style={{ marginTop: 14 }}>
          <div className="cv-card" style={{ padding: 24, minHeight: "60vh", overflow: "auto" }}><MarkdownPreview source={content} factDefinitions={STANDARD_FACT_DEFINITIONS} /></div>
        </TabsContent>
        <TabsContent value="editor" style={{ marginTop: 14 }}>
          <MarkdownEditor value={content} onChange={setContent} ariaLabel="Policy Template Content" disabled={!canEdit || saving} minHeight={560} />
        </TabsContent>
        <TabsContent value="settings" style={{ marginTop: 14 }}>
          <div className="cv-template-settings">
            <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
              <div><label className="cv-section-label" htmlFor="template-name">Template Name</label><Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} disabled={!canEdit} /></div>
              <div><label className="cv-section-label" htmlFor="template-description">Description</label><Input id="template-description" value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canEdit} /></div>
              <div><label className="cv-section-label" htmlFor="template-default-name">Default Policy Name</label><Input id="template-default-name" value={defaultName} onChange={(event) => setDefaultName(event.target.value)} disabled={!canEdit} placeholder="Uses the template name when blank" /></div>
              <div><label className="cv-section-label" htmlFor="template-version">Version</label><Input id="template-version" value={version} onChange={(event) => setVersion(event.target.value)} disabled={!canEdit} /></div>
              <ThemedSelect value={status} onChange={(value) => setStatus(value as PolicyStatus)} options={[{ label: "Draft", value: "draft" }, { label: "Active", value: "active" }, { label: "Archived", value: "archived" }]} ariaLabel="Template Status" disabled={!canEdit} />
              <ThemedSelect value={policyType} onChange={(value) => setPolicyType(value as PolicyType)} options={[{ label: "Policy", value: "policy" }, { label: "AI Acceptable Use Policy", value: "ai_acceptable_use" }, { label: "Incident Response Plan", value: "incident_response_plan" }, { label: "System Security Plan", value: "system_security_plan" }, { label: "Procedure", value: "procedure" }]} ariaLabel="Document Type" disabled={!canEdit} />
              <ThemedSelect value={defaultRole} onChange={(value) => setDefaultRole(value as PolicyRole)} options={[{ label: "Standalone Policy", value: "standalone" }, { label: "Global Base Policy", value: "base" }, { label: "Customer Addendum", value: "extension" }]} ariaLabel="Template Creates" disabled={!canEdit} />
              <OrgScopeField id="template-scope" value={scopeOrgIds(template)} onChange={async (organizationScope) => {
                await save({ organization_id: organizationScope?.length === 1 ? organizationScope[0] : null, applied_organizations: organizationScope, excluded_organizations: [] });
              }} disabled={!canEdit || saving} />
            </div>
            <aside className="cv-card" style={{ padding: 18, alignSelf: "start" }}>
              <div className="cv-section-label">Referenced Facts</div>
              <p className="cv-small" style={{ margin: "6px 0 12px" }}>These become required only after a policy is created from this template.</p>
              {referencedFacts.length ? <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>{referencedFacts.map((key) => <code key={key} className="cv-chip cv-chip--neutral">{key}</code>)}</div> : <div className="cv-small">No reusable facts in this template.</div>}
            </aside>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
