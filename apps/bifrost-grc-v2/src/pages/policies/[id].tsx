import { useGovernedTables } from "../../lib/governed-tables";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useTable, useWorkflowMutation } from "bifrost";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, AlertCircle, AlertTriangle, ArrowLeft, Trash2, Save, Edit2, Eye, FilePenLine, Link2, GitBranch, Paperclip, Upload, Download, ListChecks } from "lucide-react";
import PdfExportButton from "../../components/shared/PdfExportButton";
import PageHeader from "../../components/shared/PageHeader";
import SectionHeader from "../../components/shared/SectionHeader";
import ScopeBadge from "../../components/shared/ScopeBadge";
import OrgScopeField from "../../components/shared/OrgScopeField";
import MarkdownEditor from "../../components/shared/MarkdownEditor";
import { confirm } from "../../components/shared/ConfirmDialog";
import MarkdownPreview from "../../components/policy-builder/MarkdownPreview";
import LinkedControlsPicker from "../../components/policy-builder/LinkedControlsPicker";
import PolicySideRail from "../../components/policy-builder/PolicySideRail";
import PolicyFactsEditor from "../../components/policy-builder/PolicyFactsEditor";
import PolicySignoffTab from "../../components/policy-signoff/PolicySignoffTab";
import { nextPolicyMinorVersion } from "../../lib/policy-signoff";
import BasePolicyOrganizationsTab from "../../components/policy-signoff/BasePolicyOrganizationsTab";
import {
  TABLE_POLICIES,
  TABLE_POLICY_LINKS,
  TABLE_CONTROLS,
  TABLE_FRAMEWORKS,
  TABLE_POLICY_FACT_SNAPSHOTS,
  WF_GET_POLICY_UPLOAD_URL,
  WF_GET_POLICY_DOWNLOAD_URL,
  WF_EXPORT_POLICY_PDF } from "../../lib/grc-tables";
import { getRow } from "../../lib/table-helpers";
import { scopeOrgIds } from "../../lib/scope";
import { composeEffectivePolicy } from "../../lib/effective-policy";
import { resolveEffectiveFacts } from "../../lib/effective-facts";
import { extractFactKeys } from "../../lib/fact-markers";
import { useOrganizationView } from "../../lib/organization-view";
import { useFactWorkspace } from "../../lib/open-items";
import { STANDARD_FACT_DEFINITIONS } from "../../lib/standard-facts";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";
import type {
  Policy,
  PolicyAttachment,
  PolicyLink,
  Control,
  Framework,
  FactDefinition,
  GrcFact } from "../../lib/types";
import type { PolicyFactSnapshot } from "../../lib/types";

export default function PolicyDetailPage() {
  const tables = useGovernedTables();
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const policyId = params.id || "";
  const { organizationId: viewedOrganizationId } = useOrganizationView();
  const { canEdit } = useGrcPermissions();
  const currentUser = useCurrentUser();
  const canReissueBasePolicy = currentUser.isProviderOrg || currentUser.isPlatformAdmin;

  const [policy, setPolicy] = useState<Policy | null>(null);
  const [basePolicy, setBasePolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [contentDirty, setContentDirty] = useState(false);
  const [savingContent, setSavingContent] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [activeTab, setActiveTab] = useState(() => searchParams.get("tab") || "preview");
  const [deleting, setDeleting] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [selectedFactKey, setSelectedFactKey] = useState<string | null>(null);
  const { mutate: getPolicyUploadUrl } = useWorkflowMutation(WF_GET_POLICY_UPLOAD_URL);
  const { mutate: getPolicyDownloadUrl } = useWorkflowMutation(WF_GET_POLICY_DOWNLOAD_URL);

  const attachments = useMemo<PolicyAttachment[]>(() => {
    try {
      const parsed = JSON.parse(policy?.attachments_json ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [policy?.attachments_json]);

  async function uploadPolicyFile(
    file: File,
    options?: { textRange?: { start: number; end: number }; insertIntoEditor?: boolean },
  ): Promise<string | null> {
    if (!policy || !canEdit) return null;
    setUploadingFile(true);
    try {
      const signed = await getPolicyUploadUrl({
        policy_id: policy.id,
        filename: file.name,
        content_type: file.type || "application/octet-stream",
      }) as { url?: string; path?: string };
      if (!signed?.url || !signed?.path) throw new Error("Upload URL response missing url/path");
      const response = await fetch(signed.url, {
        method: "PUT",
        headers: file.type ? { "Content-Type": file.type } : undefined,
        body: file,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
      const attachment: PolicyAttachment = {
        id: crypto.randomUUID(),
        path: signed.path,
        name: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        kind: file.type.startsWith("image/") ? "image" : "file",
      };
      const nextAttachments = [...attachments, attachment];
      const patch: Partial<Policy> = { attachments_json: JSON.stringify(nextAttachments) };
      const markdown = attachment.kind === "image"
        ? `![${attachment.name.replace(/[\[\]]/g, "")}](bifrost-policy-file://${policy.id}/${encodeURIComponent(attachment.path)})`
        : null;
      if (options?.textRange && markdown) {
        const nextContent = `${content.slice(0, options.textRange.start)}${markdown}${content.slice(options.textRange.end)}`;
        patch.content = nextContent;
        setContent(nextContent);
        setContentDirty(false);
      }
      await tables.update(TABLE_POLICIES, policy.id, patch);
      setPolicy({ ...policy, ...patch });
      toast.success(options?.textRange || options?.insertIntoEditor ? "Image uploaded and inserted" : "File attached to policy");
      return markdown;
    } catch (err) {
      console.error(err);
      toast.error("Policy file upload failed: " + ((err as Error)?.message ?? "unknown error"));
      return null;
    } finally {
      setUploadingFile(false);
    }
  }

  async function openPolicyFile(attachment: PolicyAttachment) {
    if (!policy) return;
    try {
      const result = await getPolicyDownloadUrl({ policy_id: policy.id, path: attachment.path }) as { url?: string };
      if (!result?.url) throw new Error("Download URL was not returned");
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error("Unable to open file: " + ((err as Error)?.message ?? "unknown error"));
    }
  }

  // Load the single policy via tables.get (useTable can't filter by id).
  const loadPolicy = useMemo(
    () => async () => {
      if (!policyId) return;
      setLoadError(null);
      try {
        const row = await getRow<Policy>(TABLE_POLICIES, policyId);
        if (!row) {
          setLoadError("Policy not found");
          setPolicy(null);
        } else {
          setPolicy(row);
          if (row.base_policy_id) {
            setBasePolicy(await getRow<Policy>(TABLE_POLICIES, row.base_policy_id));
          } else {
            setBasePolicy(null);
          }
          setName(row.name ?? "");
          setContent(row.content ?? "");
          setContentDirty(false);
        }
      } catch (err) {
        console.error(err);
        setLoadError("Failed to load policy");
      } finally {
        setLoading(false);
      }
    },
    [policyId],
  );

  useEffect(() => {
    setLoading(true);
    loadPolicy();
  }, [loadPolicy]);

  // Linked control rows for this policy.
  const {
    rows: linksRaw,
    loading: linksLoading } = useTable<PolicyLink>(TABLE_POLICY_LINKS, {
    where: { policy_id: policyId },
    pageSize: 1000 });

  // All controls + frameworks (used to resolve names client-side; the
  // linked-controls picker also reuses these).
  const { rows: controlRowsRaw } = useTable<Control>(TABLE_CONTROLS, {
    pageSize: 1000 });
  const { rows: frameworkRowsRaw } = useTable<Framework>(TABLE_FRAMEWORKS, {
    pageSize: 200,
    order_by: "name",
    order_dir: "asc" });
  const { definitions: factDefinitionRows, facts: factRows, refresh: refreshFactWorkspace } = useFactWorkspace();
  const { rows: policyFactSnapshots = [] } = useTable<PolicyFactSnapshot>(TABLE_POLICY_FACT_SNAPSHOTS, { pageSize: 1000 });
  const effectiveFactDefinitions = useMemo(() => {
    const map = new Map(STANDARD_FACT_DEFINITIONS.map((item) => [item.key, item as FactDefinition]));
    factDefinitionRows.forEach((item) => map.set(item.key, item));
    return Array.from(map.values());
  }, [factDefinitionRows]);
  const effectiveOrganizationId = policy?.organization_id || viewedOrganizationId;
  const effectiveFactResolution = useMemo(() => {
    if (effectiveOrganizationId) return resolveEffectiveFacts(factRows, effectiveOrganizationId);
    const global = factRows.filter((item) => item.scope_kind === "all" || item.organization_id == null);
    return { factsByKey: new Map(global.map((item) => [item.fact_key, item])), conflictsByKey: new Map<string, GrcFact[]>() };
  }, [effectiveOrganizationId, factRows]);
  const effectiveFacts = useMemo(() => Array.from(effectiveFactResolution.factsByKey.values()), [effectiveFactResolution]);
  const links = useMemo(() => linksRaw ?? [], [linksRaw]);
  const controlLinks = useMemo(
    () => links.filter((link) => link.target_type === "control"),
    [links],
  );
  const controls = useMemo(() => controlRowsRaw ?? [], [controlRowsRaw]);
  const frameworks = useMemo(() => frameworkRowsRaw ?? [], [frameworkRowsRaw]);
  const effectiveContent = useMemo(
    () => basePolicy && policy ? composeEffectivePolicy(basePolicy, { ...policy, content }) : content,
    [basePolicy, content, policy],
  );
  const policyFactState = useMemo(() => {
    const referenced = extractFactKeys(effectiveContent);
    const factsByKey = new Map(effectiveFacts.map((item) => [item.fact_key, item]));
    const unresolved = Array.from(new Set(referenced.filter((key) => effectiveFactResolution.conflictsByKey.has(key) || !factsByKey.get(key)?.value_json)));
    let snapshot: Record<string, { revision?: number }> = {};
    const snapshotRow = policyFactSnapshots.find((item) => item.organization_id === effectiveOrganizationId && item.policy_id === policyId);
    try { snapshot = JSON.parse(snapshotRow?.snapshot_json ?? policy?.fact_snapshot_json ?? "{}"); } catch { snapshot = {}; }
    const changed = Object.entries(snapshot)
      .filter(([key, value]) => (factsByKey.get(key)?.revision ?? 0) !== (value?.revision ?? 0))
      .map(([key]) => key);
    return { unresolved, changed, conflicts: Array.from(effectiveFactResolution.conflictsByKey.keys()) };
  }, [effectiveContent, effectiveFactResolution, effectiveFacts, effectiveOrganizationId, policy?.fact_snapshot_json, policyFactSnapshots, policyId]);
  const baseChangedSinceReview = Boolean(
    basePolicy && policy?.reviewed_base_version
      && policy.reviewed_base_version !== basePolicy.version,
  );

  async function saveName() {
    if (!policy || !canEdit) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name can't be empty");
      setName(policy.name ?? "");
      setEditingName(false);
      return;
    }
    if (trimmed === policy.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await tables.update(TABLE_POLICIES, policy.id, { name: trimmed });
      setEditingName(false);
      await loadPolicy();
    } catch (err) {
      toast.error("Failed to update name");
      console.error(err);
    } finally {
      setSavingName(false);
    }
  }

  async function saveContent() {
    if (!policy || !canEdit) return;
    if (!contentDirty) return;
    setSavingContent(true);
    try {
      const version = policy.policy_role === "base" && content !== (policy.content ?? "")
        ? nextPolicyMinorVersion(policy.version)
        : policy.version;
      await tables.update(TABLE_POLICIES, policy.id, policy.policy_role === "base" ? { content, version } : { content });
      setContentDirty(false);
      // Update locally instead of refetching — a read-after-write can return a
      // stale row and clobber the editor.
      setPolicy({ ...policy, content, version });
    } catch (err) {
      toast.error("Failed to save content");
      console.error(err);
    } finally {
      setSavingContent(false);
    }
  }

  async function deletePolicy() {
    if (!policy || !canEdit) return;
    const ok = await confirm({
      title: "Delete policy?",
      body: `"${policy.name}" and its ${links.length} policy link${
        links.length === 1 ? "" : "s"
      } will be permanently removed. This can't be undone.`,
      confirmLabel: "Delete",
      destructive: true });
    if (!ok) return;
    setDeleting(true);
    try {
      // Cascade-delete the link rows first.
      for (const link of links) {
        try {
          await tables.delete(TABLE_POLICY_LINKS, link.id);
        } catch (err) {
          console.error("Failed to delete link row", link.id, err);
        }
      }
      await tables.delete(TABLE_POLICIES, policy.id);
      navigate("/policies");
    } catch (err) {
      toast.error("Failed to delete policy");
      console.error(err);
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: 64,
          color: "var(--cv-fg-3)" }}
      >
        <Loader2 size={20} className="animate-spin" />
        Loading policy...
      </div>
    );
  }

  if (loadError || !policy) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          onClick={() => navigate("/policies")}
          style={{ alignSelf: "flex-start" }}
        >
          <ArrowLeft size={14} style={{ marginRight: 6 }} />
          Back to Policies
        </button>
        <div
          className="cv-card"
          style={{
            border: "1px solid var(--cv-rS-bd)",
            background: "var(--cv-rS)",
            padding: 16,
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--cv-red)" }}
        >
          <AlertCircle size={16} />
          <span>{loadError ?? "Policy not found"}</span>
          <button
            type="button"
            className="cv-btn cv-btn--secondary cv-btn--sm"
            onClick={() => {
              setLoading(true);
              loadPolicy();
            }}
            style={{ marginLeft: "auto" }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <button
        type="button"
        className="cv-btn cv-btn--ghost cv-btn--sm"
        onClick={() => navigate("/policies")}
        style={{ alignSelf: "flex-start" }}
      >
        <ArrowLeft size={14} style={{ marginRight: 6 }} />
        Back to Policies
      </button>

      <PageHeader
        crumb="Policy"
        title={
          basePolicy ? basePolicy.name : editingName && canEdit ? (
            <span className="cv-editable-title">
              <input
                autoFocus
                aria-label="Policy Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveName();
                  if (event.key === "Escape") {
                    setName(policy.name ?? "");
                    setEditingName(false);
                  }
                }}
                onBlur={saveName}
                className="cv-editable-title__input"
              />
              {savingName ? <Loader2 size={16} className="animate-spin" /> : null}
            </span>
          ) : canEdit ? (
            <button
              type="button"
              className="cv-editable-title__button"
              onClick={() => setEditingName(true)}
              aria-label={`Rename ${policy.name}`}
            >
              <span>{policy.name}</span>
              <Edit2 size={15} aria-hidden="true" />
            </button>
          ) : policy.name
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <PdfExportButton workflow={WF_EXPORT_POLICY_PDF} params={{ policy_id: policy.id, organization_id: viewedOrganizationId || (scopeOrgIds(policy)?.length === 1 ? scopeOrgIds(policy)?.[0] : undefined) }} disabled={contentDirty || savingContent || uploadingFile} title={contentDirty ? "Save your changes before exporting." : undefined} />
            <ScopeBadge row={policy} />
            {policy.version ? (
              <span
                className="cv-chip cv-chip--neutral cv-chip--mono"
                title="Version"
              >
                v{policy.version}
              </span>
            ) : null}
            {canEdit && contentDirty ? (
              <button
                type="button"
                className="cv-btn cv-btn--primary cv-btn--sm"
                onClick={saveContent}
                disabled={savingContent}
              >
                {savingContent ? (
                  <Loader2
                    size={14}
                    className="animate-spin"
                    style={{ marginRight: 6 }}
                  />
                ) : (
                  <Save size={14} style={{ marginRight: 6 }} />
                )}
                Save
              </button>
            ) : null}
            {canEdit ? <button
              type="button"
              className="cv-btn cv-btn--destructive cv-btn--sm"
              onClick={deletePolicy}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2
                  size={14}
                  className="animate-spin"
                  style={{ marginRight: 6 }}
                />
              ) : (
                <Trash2 size={14} style={{ marginRight: 6 }} />
              )}
              Delete
            </button> : null}
          </div>
        }
      />

      {basePolicy ? (
        <div className={`cv-callout ${baseChangedSinceReview ? "cv-callout--warning" : "cv-callout--info"}`}>
          <div className="cv-callout__label">
            {baseChangedSinceReview ? <AlertTriangle size={14} /> : <GitBranch size={14} />}
            Customer Extension
          </div>
          <div className="cv-callout__body">
            Extends <strong>{basePolicy.name}</strong> v{basePolicy.version ?? "—"}.
            {baseChangedSinceReview
              ? ` This extension was reviewed against v${policy.reviewed_base_version}; review it before relying on the updated master.`
              : " The effective view combines the protected master with this customer-specific supplement."}
          </div>
        </div>
      ) : null}

      {effectiveOrganizationId && (policyFactState.unresolved.length || policyFactState.changed.length) ? (
        <div className="cv-callout cv-callout--warning">
          <div className="cv-callout__label"><AlertTriangle size={14} />Fact Review Needed</div>
          <div className="cv-callout__body">
            {policyFactState.unresolved.length ? `${policyFactState.unresolved.length} referenced fact${policyFactState.unresolved.length === 1 ? " is" : "s are"} unanswered. ` : ""}
            {policyFactState.changed.length ? `${policyFactState.changed.length} fact${policyFactState.changed.length === 1 ? " has" : "s have"} changed since the approval snapshot. ` : ""}
            <button type="button" onClick={() => setActiveTab("facts")} style={{ background: "none", border: 0, padding: 0, color: "var(--cv-accent)", textDecoration: "underline", cursor: "pointer" }}>Review Facts Here</button>
          </div>
        </div>
      ) : null}

      <div className="cv-record-layout">
        {/* Main column */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            minWidth: 0 }}
        >
          {/* Policy content */}
          <div className={activeTab === "signoff" ? "cv-policy-signoff-surface" : "cv-card"} style={activeTab === "signoff" ? undefined : { padding: 18 }}>
            <SectionHeader
              label="Policy Content"
              action={
                contentDirty ? (
                  <span style={{ fontSize: 11, color: "var(--cv-cg)" }}>
                    Unsaved changes
                  </span>
                ) : null
              }
            />
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="preview">
                  <Eye size={13} style={{ marginRight: 6 }} />
                  {basePolicy ? "Effective Plan" : "Preview"}
                </TabsTrigger>
                {basePolicy ? (
                  <TabsTrigger value="master">
                    <GitBranch size={13} style={{ marginRight: 6 }} />
                    Master
                  </TabsTrigger>
                ) : null}
                <TabsTrigger value="markdown">
                  <FilePenLine size={13} style={{ marginRight: 6 }} />
                  {basePolicy ? "Extension" : "Editor"}
                </TabsTrigger>
                <TabsTrigger value="facts">
                  <ListChecks size={13} style={{ marginRight: 6 }} />
                  Facts
                </TabsTrigger>
                <TabsTrigger value="signoff">
                  <FilePenLine size={13} style={{ marginRight: 6 }} />
                  Sign-Off
                </TabsTrigger>
                {policy.policy_role === "base" ? <TabsTrigger value="organizations">
                  <GitBranch size={13} style={{ marginRight: 6 }} />
                  Organizations
                </TabsTrigger> : null}
              </TabsList>
              <TabsContent value="preview" style={{ marginTop: 14 }}>
                <div
                  style={{
                    background: "var(--cv-bg-1)",
                    border: "1px solid var(--cv-border)",
                    borderRadius: 10,
                    padding: 24,
                    minHeight: "60vh",
                    overflow: "auto" }}
                >
                  <MarkdownPreview source={effectiveContent} factDefinitions={effectiveFactDefinitions} facts={effectiveFacts} onFactClick={(factKey) => { setSelectedFactKey(factKey); setActiveTab("facts"); }} />
                </div>
              </TabsContent>
              {basePolicy ? (
                <TabsContent value="master" style={{ marginTop: 14 }}>
                  <div
                    style={{
                      background: "var(--cv-bg-1)",
                      border: "1px solid var(--cv-border)",
                      borderRadius: 10,
                      padding: 24,
                      minHeight: "60vh",
                      overflow: "auto" }}
                  >
                    <MarkdownPreview source={basePolicy.content ?? ""} factDefinitions={effectiveFactDefinitions} facts={effectiveFacts} onFactClick={(factKey) => { setSelectedFactKey(factKey); setActiveTab("facts"); }} />
                  </div>
                </TabsContent>
              ) : null}
              <TabsContent value="markdown" style={{ marginTop: 14 }}>
                <MarkdownEditor
                  value={content}
                  onChange={(nextContent) => {
                    setContent(nextContent);
                    setContentDirty(true);
                  }}
                  ariaLabel={basePolicy ? "Customer Extension Content" : "Policy Content"}
                  disabled={!canEdit || savingContent}
                  minHeight={560}
                  onPasteImage={canEdit ? (file) => uploadPolicyFile(file, { insertIntoEditor: true }) : undefined}
                />
              </TabsContent>
              <TabsContent value="facts" style={{ marginTop: 14 }}>
                <div style={{ background: "var(--cv-bg-1)", border: "1px solid var(--cv-border)", borderRadius: 10, padding: 18 }}>
                  <div style={{ marginBottom: 14 }}><strong>Document Facts</strong><p className="cv-small" style={{ margin: "4px 0 0" }}>Fill reusable values without leaving this policy. The fact’s scope is independent of the document’s scope.</p></div>
                  <PolicyFactsEditor
                    policy={policy}
                    content={content}
                    definitions={effectiveFactDefinitions}
                    facts={factRows}
                    organizationId={effectiveOrganizationId ?? null}
                    selectedFactKey={selectedFactKey}
                    onSelectedFactChange={setSelectedFactKey}
                    onInsertFact={(factKey) => {
                      const nextContent = `${content.trimEnd()}\n\n{{fact:${factKey}|Open Item}}\n`;
                      setContent(nextContent);
                      setContentDirty(true);
                      setSelectedFactKey(factKey);
                      setActiveTab("markdown");
                    }}
                    onSaved={refreshFactWorkspace}
                  />
                </div>
              </TabsContent>
              <TabsContent value="signoff" style={{ marginTop: 14 }}>
                <PolicySignoffTab policy={policy} organizationId={effectiveOrganizationId ?? null} canEdit={canEdit} />
              </TabsContent>
              {policy.policy_role === "base" ? <TabsContent value="organizations" style={{ marginTop: 14 }}>
                <BasePolicyOrganizationsTab basePolicyId={policy.id} canReissue={canReissueBasePolicy} />
              </TabsContent> : null}
            </Tabs>
          </div>

          {/* Linked controls */}
          <div className="cv-card" style={{ padding: 18 }}>
            <SectionHeader
              label="Linked Controls"
              action={
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    color: "var(--cv-fg-3)",
                    fontSize: 11 }}
                >
                  <Link2 size={11} />
                  {linksLoading ? "Loading..." : `${controlLinks.length} linked`}
                </span>
              }
            />
            <LinkedControlsPicker
              policyId={policy.id}
              policyOrganizationId={policy.organization_id ?? null}
              appliedOrganizations={policy.applied_organizations ?? null}
              excludedOrganizations={policy.excluded_organizations ?? []}
              links={links}
              allControls={controls}
              frameworks={frameworks}
              disabled={!canEdit}
              onChanged={() => {
                // useTable is live; we still refetch the parent to refresh
                // any meta we display from the policy row.
                loadPolicy();
              }}
            />
          </div>

          <div className="cv-card" style={{ padding: 18 }}>
            <SectionHeader
              label="Policy Files"
              action={<span className="cv-small">{attachments.length} attached</span>}
            />
            {canEdit ? <label className="cv-btn cv-btn--secondary cv-btn--sm" style={{ display: "inline-flex", cursor: uploadingFile ? "wait" : "pointer" }}>
              {uploadingFile ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              <span style={{ marginLeft: 6 }}>Attach File</span>
              <input
                type="file"
                hidden
                disabled={uploadingFile}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) uploadPolicyFile(file);
                  event.target.value = "";
                }}
              />
            </label> : null}
            <p className="cv-small" style={{ margin: "8px 0 12px" }}>
              Paste an image directly into the policy editor, or attach any supporting file here.
            </p>
            {attachments.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {attachments.map((attachment) => (
                  <button
                    type="button"
                    key={attachment.id}
                    className="cv-btn cv-btn--ghost cv-btn--sm"
                    onClick={() => openPolicyFile(attachment)}
                    style={{ justifyContent: "flex-start" }}
                  >
                    {attachment.kind === "image" ? <Paperclip size={14} /> : <Download size={14} />}
                    <span style={{ marginLeft: 7 }}>{attachment.name}</span>
                  </button>
                ))}
              </div>
            ) : <div className="cv-small">No managed files attached.</div>}
          </div>
        </div>

        {/* Side rail */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, position: "sticky", top: 12 }}>
          <div className="cv-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeader label="Scope" />
            <OrgScopeField
              id="policy-organization-scope"
              value={scopeOrgIds(policy)}
              onChange={async (organizationScope) => {
                try {
                  await tables.update(TABLE_POLICIES, policy.id, {
                    applied_organizations: organizationScope,
                    excluded_organizations: [],
                  });
                  loadPolicy();
                } catch (err) {
                  toast.error("Update failed: " + ((err as Error)?.message ?? "unknown"));
                }
              }}
              disabled={!canEdit}
            />
          </div>
          <div className="cv-card" style={{ padding: 18 }}>
            <SectionHeader label="Metadata" />
            <PolicySideRail policy={policy} onUpdated={loadPolicy} disabled={!canEdit} />
          </div>
        </div>
      </div>
    </div>
  );
}
