import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { useWorkflowMutation } from "bifrost";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, Clock3, LoaderCircle, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import EmptyState from "../../components/shared/EmptyState";
import MarkdownEditor from "../../components/shared/MarkdownEditor";
import MarkdownExcerpt from "../../components/shared/MarkdownExcerpt";
import OrgScopeField from "../../components/shared/OrgScopeField";
import PageHeader from "../../components/shared/PageHeader";
import { WF_MANAGE_FACT, WF_RESOLVE_OPEN_ITEM } from "../../lib/grc-tables";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";
import { isCustomerOrganization, useOrgsList } from "../../lib/directory";
import { logicalScopeOrganizations } from "../../lib/effective-facts";
import { titleCase } from "../../lib/display-text";
import {
  OPEN_ITEM_PERSPECTIVE_LABELS,
  isOpenItemComplete,
  normalizeOpenItemsResult,
  openItemPerspectivesForLens,
  sortOpenItems,
  useFactWorkspace,
  useOpenItemsQuery,
  type OpenItemRecord,
  type OpenItemsPerspective,
} from "../../lib/open-items";
import { useOrganizationView } from "../../lib/organization-view";
import { formatFactValue, parseFactValue } from "../../lib/standard-facts";
import type { FactDefinition, FactStatus, GrcFact } from "../../lib/types";

type ContactDraft = { name: string; role: string; email: string; phone: string };
const EMPTY_CONTACT: ContactDraft = { name: "", role: "", email: "", phone: "" };
const INITIAL_BROWSE_LIMIT = 24;
const DEFAULT_PERSPECTIVE: OpenItemsPerspective = "priority";

function sameScope(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return [...left].sort().join("|") === [...right].sort().join("|");
}

function expandsScope(original: string[] | null, next: string[] | null): boolean {
  if (original === null) return next === null;
  if (next === null) return true;
  return original.every((organizationId) => next.includes(organizationId));
}

function inputIsMultiline(type?: FactDefinition["fact_type"] | string | null): boolean {
  return type === "long_text" || type === "list";
}

function isQuickResolveable(item: OpenItemRecord): boolean {
  const kind = String(item.kind ?? item.target_type ?? "").toLowerCase();
  return Boolean(item.action?.kind === "mutate" && item.action.payload && !item.can_quick_review && !["assessment", "assessment_control", "exception", "expiring_exception"].includes(kind));
}

function resolveCurrentFact(item: OpenItemRecord, facts: GrcFact[]): GrcFact | undefined {
  if (item.fact) return item.fact;
  if (item.fact_id) {
    const byId = facts.find((fact) => fact.id === item.fact_id);
    if (byId) return byId;
  }
  if (item.fact_key) {
    return facts.find((fact) => fact.fact_key === item.fact_key && (fact.organization_id ?? null) === (item.organization_id ?? null));
  }
  return undefined;
}

function draftFromItem(item: OpenItemRecord, fact?: GrcFact): { value: string; contact: ContactDraft } {
  const parsed = parseFactValue(fact);
  const valueSource = parsed ?? item.value;
  if (item.fact_type === "contact" && valueSource && typeof valueSource === "object" && !Array.isArray(valueSource)) {
    const contact = valueSource as Record<string, unknown>;
    return {
      value: "",
      contact: {
        name: String(contact.name ?? ""),
        role: String(contact.role ?? ""),
        email: String(contact.email ?? ""),
        phone: String(contact.phone ?? ""),
      },
    };
  }
  return {
    value: Array.isArray(valueSource)
      ? valueSource.map((entry) => `- ${String(entry)}`).join("\n")
      : valueSource == null
        ? ""
        : String(valueSource),
    contact: item.fact_type === "contact" && typeof valueSource === "string"
      ? { ...EMPTY_CONTACT, name: valueSource }
      : EMPTY_CONTACT,
  };
}

function serializeValue(item: OpenItemRecord, draftValue: string, draftContact: ContactDraft): unknown {
  if (item.fact_type === "contact") {
    return Object.fromEntries(
      Object.entries(draftContact)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value),
    );
  }
  if (item.fact_type === "list") {
    return draftValue
      .split("\n")
      .map((entry) => entry.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, ""))
      .filter(Boolean);
  }
  if (item.fact_type === "boolean") return draftValue === "true" ? true : draftValue === "false" ? false : null;
  if (item.fact_type === "number") return draftValue.trim() ? Number(draftValue) : null;
  return draftValue.trim();
}

function hasAnswer(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function itemSearchText(item: OpenItemRecord, organizationName: string | undefined): string {
  const reasonText = [...(item.why_open ?? []), ...(item.usages ?? []).map((usage) => usage.context ?? ""), item.summary ?? "", item.description ?? ""].join(" ");
  return [
    item.title,
    item.summary,
    item.category,
    item.status,
    item.priority,
    item.fact_key,
    item.fact_type,
    item.kind,
    item.target_type,
    organizationName,
    reasonText,
  ].filter(Boolean).join(" ").toLowerCase();
}

function perspectiveLabel(perspective: OpenItemsPerspective, count: number): string {
  return `${OPEN_ITEM_PERSPECTIVE_LABELS[perspective]}${count > 0 ? ` (${count})` : ""}`;
}

function sourceLinkLabel(item: OpenItemRecord): string {
  const href = item.detail_href ?? "";
  if (href.startsWith("/assessments/")) return "Open assessment";
  if (href.startsWith("/evidence/")) return "Open evidence";
  if (href.startsWith("/risks/")) return "Open risk";
  if (href.startsWith("/questionnaires/")) return "Open questionnaire";
  if (href.startsWith("/policies/")) return "Open policy";
  if (href.startsWith("/exceptions/")) return "Open exception";
  if (String(item.kind ?? "").includes("finding")) return "Open finding";
  return "Open source";
}

function itemValueLabel(item: OpenItemRecord): string {
  if (item.can_quick_review && item.fact_type) {
    return formatFactValue(item.fact ? item.fact : {
      id: item.fact_id ?? item.id,
      fact_key: item.fact_key ?? "",
      fact_definition_id: item.fact_key ?? "",
      value_json: typeof item.value === "string" ? JSON.stringify(item.value) : item.value == null ? null : JSON.stringify(item.value),
    } as GrcFact);
  }
  if (typeof item.value === "string") return item.value;
  if (Array.isArray(item.value)) return item.value.map(String).join(", ");
  if (item.value && typeof item.value === "object") return JSON.stringify(item.value);
  return item.summary ?? item.description ?? "";
}

function whyOpenLines(item: OpenItemRecord, organizationNames: Map<string, string>): Array<{ key: string; label: string; href?: string }> {
  const lines = (item.usages ?? []).flatMap((usage, index) => {
    const context = usage.context ?? item.why_open?.[index] ?? "";
    const label = context || (usage.target_type ? `Required by ${titleCase(usage.target_type)}` : "Open item");
    const href = usage.target_type === "policy" && usage.target_id ? `/policies/${usage.target_id}` : usage.target_type === "risk" && usage.target_id ? `/risks/${usage.target_id}` : usage.target_type === "exception" && usage.target_id ? `/exceptions/${usage.target_id}` : usage.target_type === "assessment" && usage.target_id ? `/assessments/${usage.target_id}` : usage.target_type === "evidence" && usage.target_id ? `/evidence/${usage.target_id}` : null;
    return [{ key: usage.requirement_id ?? `${item.id}:${index}`, label, href: href ?? undefined }];
  });

  if (lines.length > 0) return lines;

  const fallback = item.why_open ?? [];
  if (fallback.length > 0) {
    return fallback.map((label, index) => ({
      key: `${item.id}:why:${index}`,
      label,
      href: item.detail_href ?? undefined,
    }));
  }

  const orgName = item.organization_id ? organizationNames.get(item.organization_id) ?? "this customer" : "this portfolio";
  return [{ key: `${item.id}:default`, label: item.can_quick_review ? `Reusable answer for ${orgName}` : `Work pending for ${orgName}` }];
}

export default function OpenItemsPage() {
  const { organizationId } = useOrganizationView();
  const user = useCurrentUser();
  const { canEdit } = useGrcPermissions();
  const { orgs, isLoading: organizationsLoading, isError: organizationsError } = useOrgsList();
  const { facts } = useFactWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [selectedPerspective, setSelectedPerspective] = useState<OpenItemsPerspective>(DEFAULT_PERSPECTIVE);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftItemId, setDraftItemId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [draftContact, setDraftContact] = useState<ContactDraft>(EMPTY_CONTACT);
  const [draftDisposition, setDraftDisposition] = useState<"needs_verification" | "accepted_unknown" | "not_applicable">("needs_verification");
  const [draftNotes, setDraftNotes] = useState("");
  const [draftScope, setDraftScope] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [browseLimit, setBrowseLimit] = useState(INITIAL_BROWSE_LIMIT);
  const flashcardTriggerRef = useRef<HTMLButtonElement | null>(null);
  const primaryInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const primaryEditorFocusRef = useRef<(() => void) | null>(null);
  const manageFact = useWorkflowMutation<{ facts: GrcFact[] }>(WF_MANAGE_FACT);
  const resolveOpenItem = useWorkflowMutation<Record<string, unknown>>(WF_RESOLVE_OPEN_ITEM);
  const providerCanShare = user.isProviderOrg || user.isPlatformAdmin;
  const openItemsQuery = useOpenItemsQuery(true);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const customerOrganizations = useMemo(() => orgs.filter(isCustomerOrganization), [orgs]);
  const organizationNames = useMemo(() => new Map(orgs.map((org) => [org.id, org.name])), [orgs]);
  const responseMatchesLens = Boolean(openItemsQuery.data)
    && (openItemsQuery.data?.bifrost_organization_id ?? null) === organizationId;
  const queryData = useMemo(
    () => normalizeOpenItemsResult(responseMatchesLens ? openItemsQuery.data : undefined, organizationId),
    [openItemsQuery.data, organizationId, responseMatchesLens],
  );
  const data = queryData;
  const counts = data.counts as Record<OpenItemsPerspective, number>;
  const availablePerspectives = useMemo(() => {
    const base = openItemPerspectivesForLens(organizationId);
    return base.filter((perspective) => perspective === "all" || counts[perspective] > 0);
  }, [counts, organizationId]);
  const visiblePerspectives = availablePerspectives.length ? availablePerspectives : openItemPerspectivesForLens(organizationId);

  useEffect(() => {
    if (!visiblePerspectives.includes(selectedPerspective)) {
      setSelectedPerspective(visiblePerspectives[0] ?? DEFAULT_PERSPECTIVE);
      setActiveId(null);
      setDialogOpen(false);
    }
  }, [selectedPerspective, visiblePerspectives]);

  const requestedItemId = searchParams.get("item") ?? searchParams.get("fact");
  const requestedItem = useMemo(
    () => requestedItemId ? data.items.find((item) => item.id === requestedItemId || item.fact_key === requestedItemId) ?? null : null,
    [data.items, requestedItemId],
  );

  useEffect(() => {
    if (!requestedItem) return;
    const candidatePerspective = [requestedItem.perspective, ...(requestedItem.perspectives ?? [])]
      .find((perspective) => visiblePerspectives.includes(perspective as OpenItemsPerspective));
    setActiveId(requestedItem.id);
    setDialogOpen(true);
    setSelectedPerspective((candidatePerspective as OpenItemsPerspective) ?? DEFAULT_PERSPECTIVE);
  }, [requestedItem, visiblePerspectives]);

  const sortedItems = useMemo(
    () => sortOpenItems(data.items, selectedPerspective, organizationId),
    [data.items, organizationId, selectedPerspective],
  );
  const visibleItems = useMemo(() => {
    return sortedItems.filter((item) => {
      if (dismissedIds.has(item.id)) return false;
      const haystack = itemSearchText(item, organizationNames.get(item.organization_id ?? "") ?? undefined);
      return !deferredSearch || haystack.includes(deferredSearch);
    });
  }, [deferredSearch, dismissedIds, organizationNames, sortedItems]);
  const activeItem = visibleItems.find((item) => item.id === activeId) ?? visibleItems[0] ?? null;
  const quickReviewItem = useMemo(
    () => visibleItems.find((item) => item.can_quick_review && item.fact_key)
      ?? data.items.find((item) => item.can_quick_review && item.fact_key)
      ?? null,
    [data.items, visibleItems],
  );
  const loading = organizationsLoading || !responseMatchesLens;
  const error = organizationsError || Boolean(openItemsQuery.error);
  const portfolioHasMissingGaps = organizationId === null && data.hiddenMissingCount > 0;
  const completedCount = counts.completed ?? 0;
  const priorityCount = counts.priority ?? visibleItems.filter((item) => !isOpenItemComplete(item)).length;
  const reviewCount = counts.needs_review ?? 0;
  const expiringCount = counts.expiring ?? 0;
  const hasOpenItems = data.items.some((item) => !isOpenItemComplete(item));

  useEffect(() => {
    setBrowseLimit(INITIAL_BROWSE_LIMIT);
  }, [organizationId, deferredSearch, selectedPerspective]);

  useEffect(() => {
    setDialogOpen(false);
    setActiveId(null);
    setDismissedIds(new Set());
  }, [organizationId]);

  useEffect(() => {
    if (activeItem) setActiveId(activeItem.id);
  }, [activeItem?.id]);

  useEffect(() => {
    if (!activeItem) return;
    const fact = resolveCurrentFact(activeItem, facts);
    const draft = draftFromItem(activeItem, fact);
    setDraftValue(draft.value);
    setDraftContact(draft.contact);
    setDraftDisposition(["accepted_unknown", "not_applicable"].includes(String(fact?.status ?? "").toLowerCase()) ? fact!.status as "accepted_unknown" | "not_applicable" : "needs_verification");
    setDraftNotes(fact?.notes ?? "");
    const fallbackOrgId = activeItem.organization_id ?? organizationId;
    setDraftScope(fact ? logicalScopeOrganizations(facts, fact, fallbackOrgId ?? "") : (fallbackOrgId ? [fallbackOrgId] : null));
    setDraftItemId(activeItem.id);
    const focusTimer = window.setTimeout(() => (primaryEditorFocusRef.current?.() ?? primaryInputRef.current?.focus()), 90);
    return () => window.clearTimeout(focusTimer);
  }, [activeItem?.id, activeItem?.fact_id, activeItem?.fact_key, activeItem?.fact?.id, activeItem?.fact?.notes, activeItem?.fact?.revision, activeItem?.fact?.scope_id, activeItem?.fact?.status, activeItem?.fact?.value_json, activeItem?.status, activeItem?.value, facts, organizationId]);

  useEffect(() => {
    if (!dialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName.toLowerCase();
      const isEditing = target?.isContentEditable || ["input", "textarea", "select"].includes(tagName ?? "");
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      } else if (!isEditing && event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelection(-1);
      } else if (!isEditing && event.key === "ArrowRight") {
        event.preventDefault();
        moveSelection(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function refreshOpenItems() {
    return openItemsQuery.refresh({
      bifrost_organization_id: organizationId,
      include_complete: true,
      perspective: "all",
      page_size: 200,
    });
  }

  function openDetail(item: OpenItemRecord) {
    setActiveId(item.id);
    setDialogOpen(true);
    const next = new URLSearchParams(searchParams);
    next.set("item", item.id);
    next.set("perspective", selectedPerspective);
    setSearchParams(next, { replace: true });
  }

  function openQuickReview() {
    const target = quickReviewItem ?? visibleItems[0] ?? data.items.find((item) => !isOpenItemComplete(item)) ?? null;
    if (target) openDetail(target);
  }

  function closeDialog() {
    setDialogOpen(false);
    const next = new URLSearchParams(searchParams);
    next.delete("item");
    next.delete("fact");
    next.delete("perspective");
    setSearchParams(next, { replace: true });
    window.requestAnimationFrame(() => flashcardTriggerRef.current?.focus());
  }

  function moveSelection(direction: -1 | 1) {
    if (!activeItem || visibleItems.length < 2) return;
    const currentIndex = Math.max(0, visibleItems.findIndex((item) => item.id === activeItem.id));
    const nextIndex = (currentIndex + direction + visibleItems.length) % visibleItems.length;
    openDetail(visibleItems[nextIndex]);
  }

  async function saveFact(item: OpenItemRecord, confirmAndAdvance: boolean) {
    if (!canEdit || saving) return;
    const fact = resolveCurrentFact(item, facts);
    const value = serializeValue(item, draftValue, draftContact);
    if (confirmAndAdvance && !hasAnswer(value)) {
      toast.error("Add an answer before confirming this item.");
      primaryEditorFocusRef.current?.() ?? primaryInputRef.current?.focus();
      return;
    }
    if (draftScope !== null && draftScope.length === 0) {
      toast.error("Choose an organization or select All.");
      return;
    }
    setSaving(true);
    try {
      const originalScope = logicalScopeOrganizations(facts, fact, item.organization_id ?? organizationId ?? "");
      const scope = providerCanShare ? draftScope : [item.organization_id ?? organizationId ?? ""].filter(Boolean) as string[] | null;
      const scopeMode = scope === null ? "all" : scope.length > 1 ? "some" : "one";
      const status: FactStatus = confirmAndAdvance ? "verified" : draftDisposition;
      await manageFact.mutate({
        bifrost_organization_id: item.organization_id ?? organizationId ?? "",
        fact_key: item.fact_key ?? "",
        value,
        status,
        scope_mode: scopeMode,
        organization_ids: scope,
        scope_id: providerCanShare && fact && (sameScope(originalScope, scope) || expandsScope(originalScope, scope))
          ? fact.scope_id || fact.id
          : null,
        verified_by: status === "verified" ? user.id : null,
        notes: draftNotes.trim() || null,
        apply: true,
        confirm_apply: true,
      });
      await refreshOpenItems();
      if (confirmAndAdvance) {
        setDismissedIds((current) => new Set(current).add(item.id));
        const currentIndex = Math.max(0, visibleItems.findIndex((candidate) => candidate.id === item.id));
        const nextItem = visibleItems.find((candidate, index) => index > currentIndex && candidate.id !== item.id)
          ?? visibleItems.find((candidate) => candidate.id !== item.id)
          ?? null;
        setActiveId(nextItem?.id ?? null);
        setDialogOpen(Boolean(nextItem));
        toast.success(nextItem ? "Confirmed — next item ready" : "All caught up");
      } else {
        toast.success("Answer saved for review");
      }
    } catch (mutationError) {
      toast.error("Unable to save: " + ((mutationError as Error)?.message ?? "unknown error"));
    } finally {
      setSaving(false);
    }
  }

  async function resolveItem(item: OpenItemRecord) {
    if (!isQuickResolveable(item) || resolvingId === item.id) return;
    setResolvingId(item.id);
    try {
      await resolveOpenItem.mutate(item.action!.payload!);
      await refreshOpenItems();
      setDismissedIds((current) => new Set(current).add(item.id));
      const nextItem = visibleItems.find((candidate) => candidate.id !== item.id) ?? null;
      setActiveId(nextItem?.id ?? null);
      setDialogOpen(Boolean(nextItem));
      toast.success(item.action?.label ?? "Item resolved");
    } catch (mutationError) {
      toast.error("Unable to resolve item: " + ((mutationError as Error)?.message ?? "unknown error"));
    } finally {
      setResolvingId(null);
    }
  }

  function onPrimaryKeyDown(event: React.KeyboardEvent, item: OpenItemRecord) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (inputIsMultiline(item.fact_type) && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    void saveFact(item, true);
  }

  function renderPrimaryInput(item: OpenItemRecord) {
    const common = { disabled: !canEdit || saving, onKeyDown: (event: React.KeyboardEvent) => onPrimaryKeyDown(event, item) };
    if (item.fact_type === "contact") {
      return (
        <div className="cv-open-item-contact-grid">
          {(["name", "role", "email", "phone"] as const).map((field, index) => (
            <label key={field} className="cv-field-group">
              <span className="cv-field-label">{field[0].toUpperCase() + field.slice(1)}</span>
              <input
                ref={index === 0 ? (node) => { primaryInputRef.current = node; } : undefined}
                autoFocus={index === 0}
                className="cv-field"
                type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
                value={draftContact[field]}
                onChange={(event) => setDraftContact((current) => ({ ...current, [field]: event.target.value }))}
                {...common}
              />
            </label>
          ))}
        </div>
      );
    }
    if (item.fact_type === "boolean") {
      return (
        <label className="cv-field-group">
          <span className="cv-field-label">Answer</span>
          <select ref={(node) => { primaryInputRef.current = node; }} autoFocus className="cv-field" value={draftValue} onChange={(event) => setDraftValue(event.target.value)} {...common}>
            <option value="">Choose yes or no</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      );
    }
    if (inputIsMultiline(item.fact_type)) {
      return (
        <div className="cv-field-group">
          <span className="cv-field-label">Answer</span>
          <MarkdownEditor
            value={draftValue}
            onChange={setDraftValue}
            ariaLabel={`${item.title ?? "Open item"} answer`}
            disabled={!canEdit || saving}
            minHeight={item.fact_type === "list" ? 150 : 132}
            autoFocus
            focusHandleRef={primaryEditorFocusRef}
            onConfirm={() => void saveFact(item, true)}
          />
          <span className="cv-small">{item.fact_type === "list" ? "Use a bullet or numbered list. " : "Markdown formatting is preserved. "}Press {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to confirm.</span>
        </div>
      );
    }
    const inputType = item.fact_type === "date" ? "date" : item.fact_type === "number" ? "number" : "text";
    return (
      <label className="cv-field-group">
        <span className="cv-field-label">Answer</span>
        <input
          ref={(node) => { primaryInputRef.current = node; }}
          autoFocus
          className="cv-field"
          type={inputType}
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
          placeholder="Type an answer and press Enter"
          {...common}
        />
      </label>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Open Items could not be loaded"
        body="The customer directory or open-items workflow is unavailable. Your current customer lens has been preserved; refresh the app or try again shortly."
      />
    );
  }

  const headerSubtitle = organizationId
    ? `Review the queue for ${organizationNames.get(organizationId) ?? "this customer"} and quick-confirm the remaining work.`
    : "Review the portfolio queue by priority, findings, review state, and expiring work.";

  return (
    <div className="cv-open-items-page">
      <PageHeader
        title="Open Items"
        subtitle={headerSubtitle}
        actions={hasOpenItems ? (
          <button ref={flashcardTriggerRef} className="cv-btn cv-btn--primary cv-btn--md" onClick={openQuickReview}>
            <Sparkles size={15} aria-hidden="true" />
            {quickReviewItem ? "Start review" : "View items"}
          </button>
        ) : undefined}
      />

      {loading ? (
        <div className="cv-open-items-lens-status" role="status" aria-live="polite">
          <LoaderCircle className="bds-spin" size={16} aria-hidden="true" />
          Loading {organizationId ? organizationNames.get(organizationId) ?? "customer" : "All Customers"}…
        </div>
      ) : null}

      <div className="cv-open-items-summary" aria-label="Open item totals" aria-busy={loading}>
        <span><strong>{loading ? "—" : priorityCount}</strong> priority</span>
        <span><strong>{loading ? "—" : reviewCount}</strong> need review</span>
        <span><strong>{loading ? "—" : expiringCount}</strong> expiring</span>
        <span><strong>{loading ? "—" : completedCount}</strong> completed</span>
        {!organizationId ? <span><strong>{customerOrganizations.length}</strong> customers</span> : null}
      </div>

      {loading ? (
        <div className="cv-open-items-loading" role="status" aria-label="Loading open items">
          <span className="cv-skeleton cv-skeleton--row" />
          <span className="cv-skeleton cv-skeleton--row" />
          <span className="cv-skeleton cv-skeleton--row" />
        </div>
      ) : !organizationId && customerOrganizations.length === 0 ? (
        <EmptyState
          icon={AlertCircle}
          title="No customer organizations found"
          body="All Customers is selected, but there are no active customer organizations in the directory."
        />
      ) : !hasOpenItems && !deferredSearch ? (
        <EmptyState
          icon={CheckCircle2}
          title="All caught up"
          body={organizationId
            ? "Everything in this customer lens is complete."
            : portfolioHasMissingGaps
              ? "The portfolio has hidden missing fact gaps, but nothing else needs action right now."
              : "Nothing in the portfolio currently needs attention."}
          cta={organizationId ? (
            <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setSelectedPerspective("completed")}>
              Review completed items
            </button>
          ) : undefined}
        />
      ) : (
        <>
          <div className="cv-open-items-toolbar">
            <div className="cv-open-items-search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label="Search open items"
                placeholder="Search work items, customers, or reasons..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="cv-open-items-tabs" aria-label="Open item perspectives">
              {visiblePerspectives.map((perspective) => (
                <button
                  key={perspective}
                  className={selectedPerspective === perspective ? "is-active" : ""}
                  onClick={() => {
                    setSelectedPerspective(perspective);
                    setActiveId(null);
                    const next = new URLSearchParams(searchParams);
                    next.delete("item");
                    next.delete("fact");
                    next.set("perspective", perspective);
                    setSearchParams(next, { replace: true });
                  }}
                >
                  {perspectiveLabel(perspective, counts[perspective] ?? 0)}
                </button>
              ))}
            </div>
          </div>

          {portfolioHasMissingGaps ? (
            <div className="cv-callout cv-callout--note">
              <div className="cv-callout__label">Portfolio lens</div>
              <div className="cv-callout__body">Missing fact gaps stay hidden in All Customers so the portfolio focuses on actionable work.</div>
            </div>
          ) : null}

          {visibleItems.length === 0 ? (
            <EmptyState
              icon={Search}
              title={deferredSearch ? "No matching items" : "Nothing is waiting in this perspective"}
              body={deferredSearch
                ? "Try another search term or switch to a different perspective."
                : "Switch perspectives or clear filters to see more items."}
              cta={deferredSearch ? (
                <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setSearch("")}>Clear search</button>
              ) : (
                <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setSelectedPerspective(DEFAULT_PERSPECTIVE)}>Back to Priority</button>
              )}
            />
          ) : (
            <div className="cv-open-item-sections">
              <div className="cv-open-item-grid">
                {visibleItems.slice(0, browseLimit).map((item) => {
                  const complete = isOpenItemComplete(item);
                  const status = String(item.status ?? "").toLowerCase();
                  const orgName = item.organization_id ? organizationNames.get(item.organization_id) ?? "Customer" : "Portfolio";
                  const actionLabel = item.can_quick_review ? "Quick review" : isQuickResolveable(item) ? item.action?.label ?? "Resolve" : item.action?.label ?? (item.detail_href ? "Open source" : "Open details");
                  const valueSource = itemValueLabel(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`cv-open-item-card ${activeItem?.id === item.id ? "is-active" : ""}`}
                      onClick={() => openDetail(item)}
                    >
                      <span className="cv-open-item-card__top">
                        {complete ? <CheckCircle2 size={17} aria-hidden="true" /> : status === "unanswered" ? <AlertCircle size={17} aria-hidden="true" /> : <Clock3 size={17} aria-hidden="true" />}
                        <span>{orgName}</span>
                        <span className="cv-chip cv-chip--neutral">{titleCase(item.kind ?? item.target_type ?? item.fact_type ?? "Open item")}</span>
                      </span>
                      <strong>{item.title ?? "Open item"}</strong>
                      {valueSource ? <MarkdownExcerpt className="cv-open-item-card__value" source={valueSource} /> : null}
                      {item.why_open?.[0] || item.usages?.[0]?.context ? (
                        <div className="cv-small" style={{ lineHeight: 1.45, color: "var(--bf-muted)" }}>
                          {item.why_open?.[0] ?? item.usages?.[0]?.context}
                        </div>
                      ) : null}
                      <span className="cv-open-item-card__footer">
                        <span>{actionLabel}</span>
                        <ArrowRight size={14} aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
              </div>
              {visibleItems.length > browseLimit ? (
                <button type="button" className="cv-open-item-show-more" onClick={() => setBrowseLimit((current) => current + INITIAL_BROWSE_LIMIT)}>
                  Show more items
                  <span>{visibleItems.length - browseLimit} remaining</span>
                </button>
              ) : null}
            </div>
          )}
        </>
      )}

      {dialogOpen ? createPortal(
        <div className="cv-open-item-flashcards" role="dialog" aria-modal="true" aria-label="Open Items detail">
          <div className="cv-open-item-flashcards__header">
            <div>
              <strong>Open Items</strong>
              <span>{activeItem ? `${Math.max(1, visibleItems.findIndex((item) => item.id === activeItem.id) + 1)} of ${visibleItems.length}` : "Review complete"}</span>
            </div>
            <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={closeDialog}>
              <X size={14} aria-hidden="true" />
              Close
            </button>
          </div>
          <div className="cv-open-item-flashcards__stage">
            {activeItem ? (
              <section className={`cv-open-item-review ${saving || resolvingId === activeItem.id ? "is-completing" : ""}`} aria-labelledby="quick-review-title">
                <div className="cv-open-item-review__eyebrow">
                  <span>{OPEN_ITEM_PERSPECTIVE_LABELS[selectedPerspective]}</span>
                  <span>{activeItem.can_quick_review ? "Fast review" : isQuickResolveable(activeItem) ? "Quick resolve" : "Read details"}</span>
                </div>
                <div className="cv-open-item-review__heading">
                  <div>
                    <h2 id="quick-review-title">{activeItem.title ?? "Open item"}</h2>
                    {activeItem.description || activeItem.summary ? <p>{activeItem.description ?? activeItem.summary}</p> : null}
                  </div>
                  <div className="cv-open-item-review__meta">
                    <span className="cv-chip cv-chip--teal">{activeItem.organization_id ? organizationNames.get(activeItem.organization_id) ?? "Customer" : "Portfolio"}</span>
                    <span className="cv-chip cv-chip--neutral">{titleCase(activeItem.kind ?? activeItem.target_type ?? activeItem.fact_type ?? "Open item")}</span>
                    {activeItem.priority ? <span className="cv-chip cv-chip--gold">{titleCase(activeItem.priority)}</span> : null}
                  </div>
                </div>

                <div className="cv-callout cv-callout--note">
                  <div className="cv-callout__label">Why this is open</div>
                  <div className="cv-callout__body cv-open-item-review__reasons">
                    {whyOpenLines(activeItem, organizationNames).map((reason) => reason.href ? (
                      <Link key={reason.key} to={reason.href}>{reason.label}</Link>
                    ) : (
                      <span key={reason.key}>{reason.label}</span>
                    ))}
                  </div>
                </div>

                {activeItem.can_quick_review ? (
                  <>
                    <div key={activeItem.id} className="cv-open-item-review__form">{draftItemId === activeItem.id ? renderPrimaryInput(activeItem) : <div className="cv-skeleton cv-skeleton--row" role="status" aria-label="Preparing answer editor" />}</div>
                    <details className="cv-open-item-review__details">
                      <summary>More options</summary>
                      <div className="cv-open-item-review__advanced">
                        {providerCanShare ? (
                          <div className="cv-open-item-reuse">
                            <p>This item belongs to <strong>{organizationNames.get(activeItem.organization_id ?? "") ?? "this customer"}</strong>. It applies only there unless you intentionally reuse the answer.</p>
                            <OrgScopeField
                              key={activeItem.id}
                              id="open-item-scope"
                              label="Reuse this answer"
                              value={draftScope}
                              onChange={setDraftScope}
                              disabled={!canEdit || saving}
                              modeLabels={{ one: "This Customer", some: "Selected Customers", all: "Every Customer" }}
                              oneOrganizationId={activeItem.organization_id ?? undefined}
                              hideOnePicker
                            />
                          </div>
                        ) : (
                          <div className="cv-callout cv-callout--note">
                            <div className="cv-callout__body">This answer applies only to your organization.</div>
                          </div>
                        )}
                        <label className="cv-field-group">
                          <span className="cv-field-label">When no answer is available</span>
                          <select className="cv-field" value={draftDisposition} onChange={(event) => setDraftDisposition(event.target.value as typeof draftDisposition)} disabled={!canEdit || saving}>
                            <option value="needs_verification">Keep this item open</option>
                            <option value="accepted_unknown">Confirm that the answer is unknown</option>
                            <option value="not_applicable">Mark as not applicable</option>
                          </select>
                          <span className="cv-small">This only affects “Save for later.” Confirm &amp; next records the answer as verified.</span>
                        </label>
                        <div className="cv-field-group">
                          <span className="cv-field-label">Notes</span>
                          <MarkdownEditor
                            value={draftNotes}
                            onChange={setDraftNotes}
                            ariaLabel="Open item notes"
                            disabled={!canEdit || saving}
                            minHeight={110}
                            onConfirm={() => void saveFact(activeItem, false)}
                          />
                          <span className="cv-small">Markdown formatting is preserved. Press {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to save for later.</span>
                        </div>
                      </div>
                    </details>
                    <div className="cv-open-item-review__actions">
                      <span className="cv-small">Enter confirms one-line answers. Tab moves through fields.</span>
                      <button className="cv-btn cv-btn--secondary cv-btn--md" onClick={() => void saveFact(activeItem, false)} disabled={!canEdit || saving}>{saving ? "Saving…" : "Save for later"}</button>
                      <button className="cv-btn cv-btn--primary cv-btn--md" onClick={() => void saveFact(activeItem, true)} disabled={!canEdit || saving}>{saving ? "Confirming…" : "Confirm & next"}<ArrowRight size={15} aria-hidden="true" /></button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="cv-callout cv-callout--note">
                      <div className="cv-callout__label">Item details</div>
                      <div className="cv-callout__body">{activeItem.summary ?? activeItem.description ?? itemValueLabel(activeItem) ?? "No additional details were supplied."}</div>
                    </div>
                    <div className="cv-open-item-review__advanced">
                      {activeItem.detail_href ? <Link className="cv-btn cv-btn--secondary cv-btn--md" to={activeItem.detail_href}>{sourceLinkLabel(activeItem)}</Link> : null}
                      {isQuickResolveable(activeItem) ? (
                        <button className="cv-btn cv-btn--primary cv-btn--md" onClick={() => void resolveItem(activeItem)} disabled={resolvingId === activeItem.id}>
                          {resolvingId === activeItem.id ? "Resolving…" : activeItem.action?.label ?? "Resolve item"}
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </section>
            ) : loading ? (
              <div className="cv-open-items-loading" role="status" aria-label="Preparing the next open item">
                <span className="cv-skeleton cv-skeleton--row" />
                <span className="cv-skeleton cv-skeleton--row" />
                <span className="cv-skeleton cv-skeleton--row" />
              </div>
            ) : (
              <EmptyState
                icon={CheckCircle2}
                title="All caught up"
                body="There are no more items in this review."
                cta={<button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={closeDialog}>Return to Open Items</button>}
              />
            )}
          </div>
          {activeItem && visibleItems.length > 1 ? (
            <div className="cv-open-item-flashcards__nav" aria-label="Flashcard navigation">
              <button type="button" className="cv-btn cv-btn--secondary cv-btn--md" onClick={() => moveSelection(-1)}>
                <ArrowLeft size={15} aria-hidden="true" />
                Previous
              </button>
              <button type="button" className="cv-btn cv-btn--secondary cv-btn--md" onClick={() => moveSelection(1)}>
                Next
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
