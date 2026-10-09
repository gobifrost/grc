import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { useWorkflowQuery } from "bifrost";

import { WF_COUNT_OPEN_ITEMS, WF_GET_FACT_WORKSPACE, WF_GET_OPEN_ITEMS } from "./grc-tables";
import { isCustomerOrganization, useOrgsList } from "./directory";
import { resolveEffectiveFacts } from "./effective-facts";
import { extractFactKeys } from "./fact-markers";
import { useOrganizationView } from "./organization-view";
import { appliesToOrg } from "./scope";
import { STANDARD_FACT_DEFINITIONS } from "./standard-facts";
import type { FactDefinition, FactRequirement, FactStatus, GrcFact, Policy } from "./types";

export const COMPLETE_FACT_STATUSES: FactStatus[] = ["verified", "not_applicable", "accepted_unknown"];

export type OpenItemsPerspective =
  | "priority"
  | "missing_information"
  | "findings_issues"
  | "risks_concerns"
  | "needs_review"
  | "expiring"
  | "completed"
  | "all";

export const OPEN_ITEM_PERSPECTIVE_ORDER: OpenItemsPerspective[] = [
  "priority",
  "missing_information",
  "findings_issues",
  "risks_concerns",
  "needs_review",
  "expiring",
  "completed",
  "all",
];

export const OPEN_ITEM_PERSPECTIVE_LABELS: Record<OpenItemsPerspective, string> = {
  priority: "Priority",
  missing_information: "Missing Information",
  findings_issues: "Findings / Issues",
  risks_concerns: "Risks & Concerns",
  needs_review: "Needs Review",
  expiring: "Expiring",
  completed: "Completed",
  all: "All",
};

export interface OpenItemUsage {
  requirement_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  target_source_id?: string | null;
  context?: string | null;
}

export interface OpenItemAction {
  label: string;
  href?: string | null;
  type?: string | null;
  kind?: "link" | "flashcard" | "mutate";
  payload?: Record<string, unknown> | null;
}

export interface OpenItemRecord {
  id: string;
  organization_id?: string | null;
  organization_name?: string | null;
  perspective?: OpenItemsPerspective | string | null;
  perspectives?: Array<OpenItemsPerspective | string | null>;
  kind?: string | null;
  title?: string | null;
  description?: string | null;
  summary?: string | null;
  category?: string | null;
  status?: string | null;
  priority?: string | number | null;
  due_at?: string | null;
  review_due?: string | null;
  completed_at?: string | null;
  fact_key?: string | null;
  fact_type?: string | null;
  fact_id?: string | null;
  value?: unknown;
  source_system?: string | null;
  source_url?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  target_source_id?: string | null;
  why_open?: string[] | null;
  usages?: OpenItemUsage[] | null;
  action?: OpenItemAction | null;
  detail_href?: string | null;
  can_quick_review?: boolean | null;
  requires_attention?: boolean | null;
  fact?: GrcFact | null;
  requirement?: FactRequirement | null;
  requirements?: FactRequirement[] | null;
  conflicts?: GrcFact[] | null;
  contexts?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface OpenItemsResult {
  mode?: string;
  bifrost_organization_id?: string | null;
  count?: number;
  total_count?: number;
  open_items?: OpenItemRecord[];
  items?: OpenItemRecord[];
  counts?: Partial<Record<OpenItemsPerspective, number>> | Record<string, number>;
  perspective_counts?: Partial<Record<OpenItemsPerspective, number>> | Record<string, number>;
}

export interface ResolvedOpenItem {
  id: string;
  organizationId: string;
  definition: FactDefinition;
  requirement: FactRequirement;
  requirements: FactRequirement[];
  contexts: string[];
  fact?: GrcFact;
  conflicts?: GrcFact[];
}

interface FactWorkspaceResult {
  bifrost_organization_id?: string | null;
  definitions: FactDefinition[];
  requirements: FactRequirement[];
  facts: GrcFact[];
  policies: Policy[];
}

interface FactWorkspaceContextValue extends FactWorkspaceResult {
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<FactWorkspaceResult>;
}

const FactWorkspaceContext = createContext<FactWorkspaceContextValue | null>(null);

export function FactWorkspaceProvider({ children }: { children: ReactNode }) {
  const { organizationId } = useOrganizationView();
  const params = useMemo(() => ({ bifrost_organization_id: organizationId }), [organizationId]);
  const query = useWorkflowQuery<FactWorkspaceResult>(WF_GET_FACT_WORKSPACE, params);
  const responseMatchesLens = Boolean(query.data)
    && (query.data?.bifrost_organization_id ?? null) === organizationId;
  const value = useMemo<FactWorkspaceContextValue>(() => ({
    definitions: responseMatchesLens ? query.data?.definitions ?? [] : [],
    requirements: responseMatchesLens ? query.data?.requirements ?? [] : [],
    facts: responseMatchesLens ? query.data?.facts ?? [] : [],
    policies: responseMatchesLens ? query.data?.policies ?? [] : [],
    loading: query.loading || !responseMatchesLens,
    error: query.error,
    refresh: () => query.refresh(params),
  }), [params, query.data, query.error, query.loading, query.refresh, responseMatchesLens]);
  return createElement(FactWorkspaceContext.Provider, { value }, children);
}

export { extractFactKeys } from "./fact-markers";

function policyRequirementsForOrganization(
  organizationId: string,
  policies: Policy[],
  definitions: Map<string, FactDefinition>,
  storedRequirements: FactRequirement[],
): FactRequirement[] {
  const templateMetadata = new Map<string, FactRequirement>();
  storedRequirements
    .filter((requirement) => requirement.target_type === "policy_template")
    .forEach((requirement) => templateMetadata.set(requirement.fact_key, requirement));

  return policies
    .filter((policy) => policy.status !== "archived" && appliesToOrg(policy, organizationId))
    .flatMap((policy) => extractFactKeys(policy.content).map((factKey) => {
      const metadata = templateMetadata.get(factKey);
      return {
        id: `policy:${policy.id}:${factKey}`,
        organization_id: organizationId,
        fact_definition_id: definitions.get(factKey)?.id ?? metadata?.fact_definition_id ?? `fact:${factKey}`,
        fact_key: factKey,
        target_type: "policy" as const,
        target_id: policy.id,
        target_source_id: policy.source_id ?? null,
        context: `${policy.status === "draft" ? "Needed to publish" : "Required by"} ${policy.name}`,
        required: true,
        priority: metadata?.priority ?? "high",
        responsible_party: metadata?.responsible_party ?? definitions.get(factKey)?.expected_from ?? "shared",
        status: "active" as const,
      };
    }));
}

export function useFactWorkspace(): FactWorkspaceContextValue {
  const workspace = useContext(FactWorkspaceContext);
  if (!workspace) throw new Error("useFactWorkspace must be used inside FactWorkspaceProvider");
  return workspace;
}

export function isResolvedOpenItemComplete(item: ResolvedOpenItem): boolean {
  return !item.conflicts?.length && COMPLETE_FACT_STATUSES.includes(item.fact?.status ?? "unanswered");
}

/** Portfolio attention is a submitted/conflicting answer, not every missing customer fact. */
export function isResolvedOpenItemReadyForReview(item: ResolvedOpenItem): boolean {
  return Boolean(item.conflicts?.length) || ["proposed", "needs_verification", "stale"].includes(item.fact?.status ?? "");
}

/** Build the same effective queue for one customer or a whole provider portfolio. */
export function buildOpenItems(
  organizationIds: string[],
  storedDefinitions: FactDefinition[],
  storedRequirements: FactRequirement[],
  facts: GrcFact[],
  policies: Policy[],
): ResolvedOpenItem[] {
  const definitions = new Map<string, FactDefinition>(STANDARD_FACT_DEFINITIONS.map((item) => [item.key, item]));
  storedDefinitions.forEach((item) => definitions.set(item.key, item));

  return organizationIds.flatMap((organizationId) => {
    const requirements = new Map<string, FactRequirement>();
    storedRequirements
      // A policy_template row is dormant authoring metadata. Only an actual document
      // reference activates a policy requirement for an organization.
      .filter((item) => item.target_type !== "policy_template")
      .filter((item) => !item.organization_id || item.organization_id === organizationId)
      .forEach((item) => requirements.set(`${item.target_id || item.target_source_id}:${item.fact_key}`, item));
    policyRequirementsForOrganization(organizationId, policies, definitions, storedRequirements)
      .forEach((item) => requirements.set(`${item.target_id}:${item.fact_key}`, item));

    const resolution = resolveEffectiveFacts(facts, organizationId);
    const combined = new Map<string, ResolvedOpenItem>();
    Array.from(requirements.values())
      .filter((requirement) => requirement.status !== "waived")
      .forEach((requirement) => {
        const definition = definitions.get(requirement.fact_key);
        if (!definition) return;
        const prior = combined.get(definition.key);
        const contexts = Array.from(new Set([...(prior?.contexts ?? []), requirement.context].filter(Boolean) as string[]));
        combined.set(definition.key, {
          id: `${organizationId}:${definition.key}`,
          organizationId,
          definition,
          requirement: prior?.requirement ?? requirement,
          requirements: [...(prior?.requirements ?? []), requirement],
          contexts,
          fact: resolution.factsByKey.get(requirement.fact_key),
          conflicts: resolution.conflictsByKey.get(requirement.fact_key),
        });
      });
    return Array.from(combined.values());
  }).sort((a, b) => {
    const reviewRank = (item: ResolvedOpenItem) => item.conflicts?.length ? 0 : ["proposed", "needs_verification", "stale"].includes(item.fact?.status ?? "") ? 1 : item.fact?.status === "unanswered" || !item.fact ? 2 : 3;
    return reviewRank(a) - reviewRank(b)
    || (a.definition.category ?? "Other").localeCompare(b.definition.category ?? "Other")
    || a.definition.title.localeCompare(b.definition.title)
    || a.organizationId.localeCompare(b.organizationId);
  });
}

function compactText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function compactTextList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return Array.from(new Set(value.map((entry) => compactText(entry)).filter((entry): entry is string => Boolean(entry))));
  if (typeof value === "string") return value.split(/\n+/).map((entry) => compactText(entry)).filter((entry): entry is string => Boolean(entry));
  return [];
}

function priorityRank(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && value.trim() !== "") return parsed;
  }
  switch (String(value ?? "").toLowerCase()) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    default: return 4;
  }
}

function normalizePerspective(value: unknown): OpenItemsPerspective | string | null {
  const text = compactText(value)?.toLowerCase().replace(/\s+/g, "_").replace(/[/-]+/g, "_");
  if (!text) return null;
  switch (text) {
    case "finding":
    case "assessment_finding":
    case "questionnaire_finding":
    case "issue":
    case "recommendation":
      return "findings_issues";
    case "risk":
    case "concern":
      return "risks_concerns";
    case "review":
    case "needs_review":
    case "review_required":
      return "needs_review";
    case "expiring_exception":
      return "expiring";
  }
  const known = new Set<OpenItemsPerspective>(OPEN_ITEM_PERSPECTIVE_ORDER);
  return known.has(text as OpenItemsPerspective) ? (text as OpenItemsPerspective) : text;
}

function routeForTarget(targetType: string | null | undefined, targetId: string | null | undefined, metadata?: Record<string, unknown> | null): string | null {
  const id = compactText(metadata?.assessment_id) ?? compactText(metadata?.source_id) ?? targetId;
  switch ((targetType ?? "").toLowerCase()) {
    case "policy":
      return targetId ? `/policies/${targetId}` : null;
    case "risk":
      return targetId ? `/risks/${targetId}` : null;
    case "exception":
      return targetId ? `/exceptions/${targetId}` : null;
    case "assessment":
      return targetId ? `/assessments/${targetId}` : null;
    case "assessment_control":
      return id ? `/assessments/${id}` : null;
    case "control":
      return targetId ? `/controls/${targetId}` : null;
    case "evidence":
      return targetId ? `/evidence/${targetId}` : null;
    case "questionnaire":
    case "questionnaire_item":
    case "questionnaire_response":
      return targetId ? `/questionnaires/${targetId}` : null;
    case "source_document":
      return targetId ? `/source-documents/${targetId}` : null;
    default:
      return null;
  }
}

function derivePerspectives(item: OpenItemRecord): OpenItemsPerspective[] {
  const explicit = [item.perspective, ...(item.perspectives ?? [])]
    .flatMap((entry) => {
      const normalized = normalizePerspective(entry);
      return normalized ? [normalized] : [];
    })
    .filter((entry): entry is OpenItemsPerspective => OPEN_ITEM_PERSPECTIVE_ORDER.includes(entry as OpenItemsPerspective));
  if (explicit.length) return Array.from(new Set(explicit));

  const status = String(item.status ?? "").toLowerCase();
  const kind = String(item.kind ?? item.target_type ?? "").toLowerCase();
  const perspectives = new Set<OpenItemsPerspective>();

  if (status === "unanswered" || !status) perspectives.add("missing_information");
  if (["proposed", "needs_verification", "stale", "pending_review"].includes(status) || item.requires_attention || kind === "review" || kind === "needs_review" || kind === "assessment_finding" || kind === "questionnaire_finding") perspectives.add("needs_review");
  if ((item.review_due ?? item.due_at) && String(item.status ?? "").toLowerCase() !== "completed") perspectives.add("expiring");
  if (["risk", "exception", "concern"].includes(kind) || ["risk", "exception", "concern"].includes(String(item.target_type ?? "").toLowerCase())) perspectives.add("risks_concerns");
  if (["finding", "assessment_finding", "questionnaire_finding", "issue", "recommendation", "assessment_control", "manual_finding", "questionnaire_recommendation"].includes(kind) || ["assessment_control", "questionnaire_recommendation"].includes(String(item.target_type ?? "").toLowerCase())) perspectives.add("findings_issues");
  if (status === "verified" || status === "completed" || status === "not_applicable" || status === "accepted_unknown" || Boolean(item.completed_at)) perspectives.add("completed");
  if (priorityRank(item.priority) <= 1 || perspectives.has("needs_review") || perspectives.has("expiring")) perspectives.add("priority");
  if (perspectives.size === 0) perspectives.add("priority");
  return Array.from(perspectives);
}

function normalizeOpenItem(item: OpenItemRecord, index: number): OpenItemRecord {
  const metadata = item.metadata ?? null;
  const whyOpen = compactTextList(item.why_open ?? item.summary ?? item.description ?? item.category ?? item.status);
  const usages = (item.usages ?? [])
    .map((usage) => ({
      requirement_id: compactText(usage.requirement_id),
      target_type: compactText(usage.target_type),
      target_id: compactText(usage.target_id),
      target_source_id: compactText(usage.target_source_id),
      context: compactText(usage.context),
    }))
    .filter((usage) => Boolean(usage.context || usage.target_id || usage.target_source_id || usage.requirement_id));
  const targetType = compactText(item.target_type);
  const targetId = compactText(item.target_id);
  const factKey = compactText(item.fact_key);
  const kind = compactText(item.kind) ?? (factKey ? "fact" : null);
  const title = compactText(item.title) ?? compactText(item.summary) ?? factKey ?? `Open item ${index + 1}`;
  const summary = compactText(item.summary) ?? compactText(item.description) ?? usages[0]?.context ?? null;
  const detailHref = compactText(item.detail_href) ?? routeForTarget(targetType, targetId, metadata);
  const inferredQuickReview = Boolean(factKey);
  const canQuickReview = item.can_quick_review ?? inferredQuickReview;
  const action = item.action ? {
    label: item.action.label,
    href: compactText(item.action.href),
    kind: item.action.kind ?? (item.action.type === "open_source" ? "link" : undefined),
    type: item.action.type,
    payload: typeof item.action.payload === "object" && item.action.payload ? item.action.payload : null,
  } : canQuickReview && factKey ? { label: "Quick review", kind: "flashcard" as const } : detailHref ? { label: "Open details", href: detailHref, kind: "link" as const } : null;

  return {
    ...item,
    id: compactText(item.id) ?? factKey ?? `open-item-${index}`,
    organization_id: item.organization_id ?? null,
    organization_name: item.organization_name ?? null,
    perspective: item.perspective ?? null,
    perspectives: item.perspectives ?? undefined,
    kind,
    title,
    summary,
    why_open: whyOpen.length ? whyOpen : usages.map((usage) => usage.context).filter((entry): entry is string => Boolean(entry)),
    status: compactText(item.status),
    priority: typeof item.priority === "number" ? item.priority : compactText(item.priority),
    due_at: compactText(item.due_at),
    review_due: compactText(item.review_due),
    completed_at: compactText(item.completed_at),
    fact_key: factKey,
    fact_type: compactText(item.fact_type),
    fact_id: compactText(item.fact_id),
    source_system: compactText(item.source_system),
    source_url: compactText(item.source_url),
    target_type: targetType,
    target_id: targetId,
    target_source_id: compactText(item.target_source_id),
    usages,
    action,
    detail_href: detailHref,
    can_quick_review: canQuickReview,
    requires_attention: item.requires_attention ?? (["proposed", "needs_verification", "stale"].includes(String(item.status ?? "").toLowerCase()) || usages.length > 0),
    metadata,
  };
}

export function normalizeOpenItemsResult(data: OpenItemsResult | null | undefined, organizationId: string | null) {
  const rawItems = (data?.items ?? data?.open_items ?? []).map((item, index) => normalizeOpenItem(item, index));
  const visibleItems = organizationId === null
    ? rawItems.filter((item) => !derivePerspectives(item).includes("missing_information"))
    : rawItems;
  const computedCounts = Object.fromEntries(OPEN_ITEM_PERSPECTIVE_ORDER.map((perspective) => [
    perspective,
    perspective === "all"
      ? visibleItems.length
      : perspective === "completed"
        ? visibleItems.filter((item) => derivePerspectives(item).includes("completed")).length
        : visibleItems.filter((item) => derivePerspectives(item).includes(perspective)).length,
  ])) as Record<OpenItemsPerspective, number>;
  const serverCounts = data?.counts ?? data?.perspective_counts ?? {};
  const counts = Object.fromEntries(OPEN_ITEM_PERSPECTIVE_ORDER.map((perspective) => [
    perspective,
    Number(serverCounts[perspective] ?? computedCounts[perspective] ?? 0),
  ])) as Record<OpenItemsPerspective, number>;
  const hiddenMissingCount = organizationId === null
    ? rawItems.filter((item) => derivePerspectives(item).includes("missing_information")).length
    : 0;
  return {
    items: visibleItems,
    allItems: rawItems,
    count: data?.total_count ?? data?.count ?? counts.all,
    counts: {
      ...counts,
      all: Number(serverCounts.all ?? counts.all),
      priority: Number(serverCounts.priority ?? counts.priority),
      missing_information: organizationId === null ? 0 : counts.missing_information,
    },
    hiddenMissingCount,
  };
}

export function isOpenItemComplete(item: OpenItemRecord): boolean {
  const status = String(item.status ?? "").toLowerCase();
  return status === "verified" || status === "not_applicable" || status === "accepted_unknown" || status === "completed";
}

export function isOpenItemReadyForReview(item: OpenItemRecord): boolean {
  return derivePerspectives(item).some((perspective) => ["needs_review", "findings_issues", "risks_concerns", "expiring"].includes(perspective));
}

export function sortOpenItems(items: OpenItemRecord[], perspective: OpenItemsPerspective, organizationId: string | null): OpenItemRecord[] {
  const filtered = items.filter((item) => {
    const itemPerspectives = derivePerspectives(item);
    if (organizationId === null && itemPerspectives.includes("missing_information")) return false;
    if (perspective === "all") return true;
    if (perspective === "priority") return !isOpenItemComplete(item) && itemPerspectives.includes("priority");
    return itemPerspectives.includes(perspective);
  });

  return [...filtered].sort((left, right) => {
    if (perspective === "completed") {
      return String(right.completed_at ?? right.review_due ?? right.due_at ?? "").localeCompare(String(left.completed_at ?? left.review_due ?? left.due_at ?? ""));
    }
    const leftPriority = priorityRank(left.priority);
    const rightPriority = priorityRank(right.priority);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftDue = String(left.review_due ?? left.due_at ?? "");
    const rightDue = String(right.review_due ?? right.due_at ?? "");
    if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
    const leftOrg = String(left.organization_name ?? left.organization_id ?? "");
    const rightOrg = String(right.organization_name ?? right.organization_id ?? "");
    if (leftOrg !== rightOrg) return leftOrg.localeCompare(rightOrg);
    if (String(left.category ?? "") !== String(right.category ?? "")) return String(left.category ?? "").localeCompare(String(right.category ?? ""));
    return String(left.title ?? "").localeCompare(String(right.title ?? ""));
  });
}

export function openItemBadgeLabel(organizationId: string | null): string {
  return organizationId ? "open" : "ready for review";
}

export function openItemPerspectivesForLens(organizationId: string | null): OpenItemsPerspective[] {
  return organizationId
    ? OPEN_ITEM_PERSPECTIVE_ORDER
    : OPEN_ITEM_PERSPECTIVE_ORDER.filter((perspective) => perspective !== "missing_information");
}

export function useOpenItemsQuery(includeComplete = true) {
  const { organizationId } = useOrganizationView();
  const params = useMemo(() => ({
    bifrost_organization_id: organizationId,
    include_complete: includeComplete,
    perspective: "all",
    page_size: 200,
  }), [includeComplete, organizationId]);
  return useWorkflowQuery<OpenItemsResult>(WF_GET_OPEN_ITEMS, params);
}

export function useOpenItemsSummary() {
  const { organizationId } = useOrganizationView();
  const params = useMemo(() => ({ bifrost_organization_id: organizationId }), [organizationId]);
  const query = useWorkflowQuery<{ counts?: Record<string, number>; total_count?: number }>(WF_COUNT_OPEN_ITEMS, params);

  return {
    openCount: query.data?.counts?.all ?? query.data?.total_count ?? 0,
    loading: query.loading,
    error: query.error,
  };
}
