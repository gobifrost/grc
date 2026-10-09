import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { useWorkflowMutation } from "bifrost";
import { toast } from "sonner";

import MarkdownEditor from "../shared/MarkdownEditor";
import OrgScopeField from "../shared/OrgScopeField";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";
import { logicalScopeOrganizations, resolveEffectiveFacts } from "../../lib/effective-facts";
import { titleCase } from "../../lib/display-text";
import { WF_MANAGE_FACT } from "../../lib/grc-tables";
import { extractFactKeys } from "../../lib/open-items";
import { parseFactValue } from "../../lib/standard-facts";
import type { FactDefinition, FactStatus, GrcFact, Policy } from "../../lib/types";

type ContactDraft = { name: string; role: string; email: string; phone: string };
const EMPTY_CONTACT: ContactDraft = { name: "", role: "", email: "", phone: "" };

interface PolicyFactsEditorProps {
  policy: Policy;
  content: string;
  definitions: FactDefinition[];
  facts: GrcFact[];
  organizationId: string | null;
  selectedFactKey?: string | null;
  onSelectedFactChange?: (factKey: string | null) => void;
  onInsertFact?: (factKey: string) => void;
  onSaved: () => Promise<unknown> | void;
}

function initialDraft(definition: FactDefinition | undefined, fact: GrcFact | undefined) {
  const parsed = parseFactValue(fact);
  if (definition?.fact_type === "contact" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const value = parsed as Record<string, unknown>;
    return {
      text: "",
      contact: {
        name: String(value.name ?? ""), role: String(value.role ?? ""),
        email: String(value.email ?? ""), phone: String(value.phone ?? ""),
      },
    };
  }
  return {
    text: Array.isArray(parsed) ? parsed.map((item) => `- ${String(item)}`).join("\n") : parsed == null ? "" : String(parsed),
    contact: definition?.fact_type === "contact" && typeof parsed === "string" ? { ...EMPTY_CONTACT, name: parsed } : EMPTY_CONTACT,
  };
}

function serializedValue(definition: FactDefinition, text: string, contact: ContactDraft): unknown {
  if (definition.fact_type === "contact") {
    return Object.fromEntries(Object.entries(contact).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
  }
  if (definition.fact_type === "list") return text.split("\n").map((item) => item.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")).filter(Boolean);
  if (definition.fact_type === "boolean") return text === "true" ? true : text === "false" ? false : null;
  if (definition.fact_type === "number") return text.trim() ? Number(text) : null;
  return text.trim();
}

function hasValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function sameScope(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return [...left].sort().join("|") === [...right].sort().join("|");
}

function expandsScope(original: string[] | null, next: string[] | null): boolean {
  if (original === null) return next === null;
  if (next === null) return true;
  return original.every((organizationId) => next.includes(organizationId));
}

export default function PolicyFactsEditor({
  policy, content, definitions, facts, organizationId, selectedFactKey,
  onSelectedFactChange, onInsertFact, onSaved,
}: PolicyFactsEditorProps) {
  const user = useCurrentUser();
  const { canEdit } = useGrcPermissions();
  const manageFact = useWorkflowMutation<{ facts: GrcFact[] }>(WF_MANAGE_FACT);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const referencedKeys = useMemo(() => extractFactKeys(content), [content]);
  const definitionsByKey = useMemo(() => new Map(definitions.map((item) => [item.key, item])), [definitions]);
  const targetOrganizationId = policy.organization_id || organizationId;
  const policyIsGlobal = policy.applied_organizations === null || (policy.organization_id == null && !Array.isArray(policy.applied_organizations));
  const resolution = useMemo(() => {
    if (targetOrganizationId) return resolveEffectiveFacts(facts, targetOrganizationId);
    const allFacts = facts.filter((fact) => fact.scope_kind === "all" || (fact.organization_id == null && fact.applied_organizations === null));
    return { factsByKey: new Map(allFacts.map((fact) => [fact.fact_key, fact])), conflictsByKey: new Map<string, GrcFact[]>() };
  }, [facts, targetOrganizationId]);
  const [activeKey, setActiveKey] = useState<string | null>(selectedFactKey ?? referencedKeys[0] ?? null);
  const definition = activeKey ? definitionsByKey.get(activeKey) : undefined;
  const fact = activeKey ? resolution.factsByKey.get(activeKey) : undefined;
  const [text, setText] = useState("");
  const [contact, setContact] = useState<ContactDraft>(EMPTY_CONTACT);
  const [scope, setScope] = useState<string[] | null>(policyIsGlobal ? null : targetOrganizationId ? [targetOrganizationId] : null);
  const [saving, setSaving] = useState(false);
  const [insertKey, setInsertKey] = useState("");
  const canShare = user.isProviderOrg || user.isPlatformAdmin;

  useEffect(() => {
    if (!selectedFactKey || !referencedKeys.includes(selectedFactKey)) return;
    setActiveKey(selectedFactKey);
    window.requestAnimationFrame(() => containerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [referencedKeys, selectedFactKey]);

  useEffect(() => {
    if (!activeKey || !referencedKeys.includes(activeKey)) setActiveKey(referencedKeys[0] ?? null);
  }, [activeKey, referencedKeys]);

  useEffect(() => {
    const draft = initialDraft(definition, fact);
    setText(draft.text);
    setContact(draft.contact);
    setScope(fact ? logicalScopeOrganizations(facts, fact, targetOrganizationId || user.organizationId || "") : policyIsGlobal ? null : targetOrganizationId ? [targetOrganizationId] : null);
  }, [definition?.key, fact?.id, fact?.revision, facts, policyIsGlobal, targetOrganizationId, user.organizationId]);

  function selectFact(key: string) {
    setActiveKey(key);
    onSelectedFactChange?.(key);
  }

  async function save(status: FactStatus) {
    if (!definition || !activeKey || !canEdit || saving) return;
    const value = serializedValue(definition, text, contact);
    if (!hasValue(value) && !["accepted_unknown", "not_applicable"].includes(status)) {
      toast.error("Add an answer before saving this fact.");
      return;
    }
    if (scope !== null && scope.length === 0) {
      toast.error("Choose an organization or select All.");
      return;
    }
    const bindingOrganizationId = targetOrganizationId || user.organizationId;
    if (!bindingOrganizationId) {
      toast.error("Your organization context could not be resolved.");
      return;
    }
    setSaving(true);
    try {
      const scopeMode = scope === null ? "all" : scope.length > 1 ? "some" : "one";
      const originalScope = fact ? logicalScopeOrganizations(facts, fact, targetOrganizationId || bindingOrganizationId) : scope;
      await manageFact.mutate({
        bifrost_organization_id: bindingOrganizationId,
        fact_key: activeKey,
        value,
        status,
        scope_mode: scopeMode,
        organization_ids: scope,
        scope_id: fact && (sameScope(originalScope, scope) || expandsScope(originalScope, scope))
          ? fact.scope_id || fact.id
          : null,
        verified_by: status === "verified" ? user.id : null,
        apply: true,
        confirm_apply: true,
      });
      await onSaved();
      toast.success(status === "verified" ? "Fact saved and verified" : "Fact saved for review");
    } catch (error) {
      toast.error("Unable to save fact: " + ((error as Error)?.message ?? "unknown error"));
    } finally {
      setSaving(false);
    }
  }

  function renderInput() {
    if (!definition) return null;
    if (definition.fact_type === "contact") {
      return <div className="cv-open-item-contact-grid">{(["name", "role", "email", "phone"] as const).map((field) => <label key={field} className="cv-field-group"><span className="cv-field-label">{titleCase(field)}</span><input className="cv-field" type={field === "email" ? "email" : field === "phone" ? "tel" : "text"} value={contact[field]} onChange={(event) => setContact((current) => ({ ...current, [field]: event.target.value }))} disabled={!canEdit || saving} /></label>)}</div>;
    }
    if (definition.fact_type === "boolean") {
      return <label className="cv-field-group"><span className="cv-field-label">Answer</span><select className="cv-field" value={text} onChange={(event) => setText(event.target.value)} disabled={!canEdit || saving}><option value="">Choose yes or no</option><option value="true">Yes</option><option value="false">No</option></select></label>;
    }
    if (definition.fact_type === "long_text" || definition.fact_type === "list") {
      return <div className="cv-field-group"><span className="cv-field-label">Answer</span><MarkdownEditor value={text} onChange={setText} ariaLabel={`${definition.title} answer`} disabled={!canEdit || saving} minHeight={132} /></div>;
    }
    return <label className="cv-field-group"><span className="cv-field-label">Answer</span><input className="cv-field" type={definition.fact_type === "date" ? "date" : definition.fact_type === "number" ? "number" : "text"} value={text} onChange={(event) => setText(event.target.value)} disabled={!canEdit || saving} /></label>;
  }

  return <div ref={containerRef} className="cv-policy-facts-editor">
    {referencedKeys.length ? <>
      <div className="cv-policy-facts-editor__types" role="tablist" aria-label="Facts referenced by this document">
        {referencedKeys.map((key) => {
          const current = resolution.factsByKey.get(key);
          return <button key={key} type="button" className={`cv-chip ${key === activeKey ? "cv-chip--teal" : "cv-chip--neutral"}`} onClick={() => selectFact(key)} role="tab" aria-selected={key === activeKey}>{current?.value_json ? <Check size={12} /> : null}{definitionsByKey.get(key)?.title ?? key}</button>;
        })}
      </div>
      {definition ? <div className="cv-policy-facts-editor__panel">
        <div className="cv-policy-facts-editor__heading"><strong>{definition.title}</strong><p>{definition.description}</p></div>
        {resolution.conflictsByKey.has(definition.key) ? <div className="cv-callout cv-callout--warning"><div className="cv-callout__body">Multiple equally specific values apply. Saving here resolves the conflict at the selected scope.</div></div> : null}
        <div className="cv-policy-facts-editor__answer">{renderInput()}</div>
        {canShare ? <OrgScopeField id={`policy-fact-${definition.key}`} label="Reuse this answer" value={scope} onChange={setScope} disabled={!canEdit || saving} oneOrganizationId={targetOrganizationId || undefined} modeLabels={{ one: "This Customer", some: "Selected Customers", all: "Every Customer" }} hideOnePicker={Boolean(targetOrganizationId)} /> : null}
        {policyIsGlobal && scope !== null ? <div className="cv-callout cv-callout--warning"><div className="cv-callout__body">This global policy uses a scoped answer. Organizations outside this fact’s scope will still need their own value.</div></div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => void save("needs_verification")} disabled={!canEdit || saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : null}Save for review</button>
          <button type="button" className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => void save("verified")} disabled={!canEdit || saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Save &amp; verify</button>
        </div>
      </div> : null}
    </> : <div className="cv-small">This document does not reference any reusable facts yet.</div>}

    {onInsertFact && canEdit ? <div className="cv-policy-facts-editor__insert">
      <label className="cv-field-group" style={{ flex: "1 1 260px" }}><span className="cv-field-label">Add a fact placeholder</span><select className="cv-field" value={insertKey} onChange={(event) => setInsertKey(event.target.value)}><option value="">Choose a reusable fact…</option>{definitions.filter((item) => !referencedKeys.includes(item.key)).map((item) => <option key={item.key} value={item.key}>{item.title}</option>)}</select></label>
      <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" disabled={!insertKey} onClick={() => { onInsertFact(insertKey); setInsertKey(""); }}><Plus size={14} />Insert</button>
    </div> : null}
  </div>;
}
