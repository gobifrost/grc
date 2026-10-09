import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { tables, useTable, useWorkflowMutation } from "bifrost";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useParams } from "react-router-dom";
import { ArrowLeft, Check, Info, Link2, Loader2, Pencil, Plus, Sparkles, X, Edit } from "lucide-react";

import QuestionnairePdfPane from "../../components/QuestionnairePdfPane";
import QuestionnaireRecommendations from "../../components/QuestionnaireRecommendations";
import QuestionnaireDropzone from "../../components/QuestionnaireDropzone";
import ThemedSelect from "../../components/shared/ThemedSelect";
import OrgPicker from "../../components/shared/OrgPicker";
import BifrostDialogFrame from "../../components/shared/BifrostDialogFrame";

const WF_CLASSIFY_GAPS = "workflows/grc_v2/grc_recommendations.py::classify_grc_questionnaire_gaps";
type QuestionnaireTab = "questions" | "source" | "recommendations" | "runs";
import {
  TABLE_APPLIED_CONTROLS,
  TABLE_ASSESSMENT_CONTROLS,
  TABLE_CONTROLS,
  TABLE_EVIDENCE,
  TABLE_POLICIES,
  TABLE_QUESTIONNAIRE_CONTROL_LINKS,
  TABLE_QUESTIONNAIRE_ITEMS,
  TABLE_QUESTIONNAIRE_PROPOSALS,
  TABLE_QUESTIONNAIRE_RESPONSES,
  TABLE_QUESTIONNAIRE_RUNS,
  TABLE_QUESTIONNAIRE_SECTIONS,
  TABLE_QUESTIONNAIRES,
  TABLE_SOURCE_DOCUMENTS,
  WF_APPLY_GRC_QUESTIONNAIRE_ANSWERS,
  WF_DRAFT_GRC_QUESTIONNAIRE_ANSWERS,
  WF_EXTRACT_GRC_QUESTIONNAIRE,
} from "../../lib/grc-tables";
import { useOrgNamesMap } from "../../lib/directory";
import { useGrcPermissions } from "../../lib/current-user";
import type {
  AppliedControl,
  AssessmentControl,
  Control,
  Evidence,
  Policy,
  Questionnaire,
  QuestionnaireControlLink,
  QuestionnaireItem,
  QuestionnaireProposal,
  QuestionnaireResponse,
  QuestionnaireResponseStatus,
  QuestionnaireRun,
  QuestionnaireSection,
  QuestionnaireStatus,
  SourceDocument,
} from "../../lib/types";

const QSTATUS_OPTIONS = [
  { label: "Draft", value: "draft" },
  { label: "Extracting", value: "extracting" },
  { label: "Answering", value: "answering" },
  { label: "Needs review", value: "needs_review" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
];

function unwrapRow<T>(raw: unknown): (T & { id: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if ("data" in row && row.data && typeof row.data === "object") {
    return { id: String(row.id ?? ""), ...(row.data as Record<string, unknown>) } as T & { id: string };
  }
  return row as T & { id: string };
}

const SMALL_WORDS = new Set(["to", "for", "of", "in", "on", "at", "by", "the", "a", "an", "and", "or"]);
const ACRONYMS = new Set(["grc", "psa", "msp", "ai", "pdf", "docx", "url", "id", "mfa", "edr", "rmm", "sla", "kpi", "ir", "soc", "iso", "nist", "cis", "csv"]);

function labelize(value?: string | null): string {
  if (!value) return "Unknown";
  const words = value.replace(/_/g, " ").split(/\s+/).filter(Boolean);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "-";
  }
}

function statusTone(status?: string | null): string {
  if (status === "accepted" || status === "applied" || status === "completed") return "cv-chip--green";
  if (status === "needs_review" || status === "draft" || status === "queued" || status === "running") return "cv-chip--gold";
  if (status === "rejected" || status === "failed") return "cv-chip--red";
  return "cv-chip--neutral";
}

// ----- form state derivation -----

type RowState = "accepted" | "draft" | "rejected" | "empty";
type Audience = "msp" | "customer";

const STATUS_FILTER_OPTIONS = [
  { label: "All questions", value: "all" },
  { label: "To do", value: "empty" },
  { label: "Drafted (confirm)", value: "draft" },
  { label: "Accepted", value: "accepted" },
  { label: "Rejected", value: "rejected" },
];
const AUDIENCE_FILTER_OPTIONS = [
  { label: "Any audience", value: "all" },
  { label: "MSP answers", value: "msp" },
  { label: "Customer answers", value: "customer" },
];

function answerText(resp?: QuestionnaireResponse | null): string {
  return (resp?.final_answer ?? resp?.draft_answer ?? "").trim();
}

// AI drafts for unanswerable items come back as prose like "Needs confirmation.
// X is not specified in the provided context." Those are NOT answers — the field
// must read as empty so the reviewer knows it still needs input.
function isNonAnswer(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  return (
    t.startsWith("needs confirmation") ||
    t.startsWith("need confirmation") ||
    t.startsWith("not specified") ||
    t.startsWith("unknown") ||
    t.startsWith("unable to") ||
    t.startsWith("cannot confirm") ||
    t.startsWith("no information")
  );
}

function realAnswer(resp?: QuestionnaireResponse | null): string {
  const a = answerText(resp);
  return a && !isNonAnswer(a) ? a : "";
}

function rowStateOf(resp?: QuestionnaireResponse | null): RowState {
  if (resp?.status === "rejected") return "rejected";
  const real = !!realAnswer(resp);
  if (resp?.status === "accepted" || resp?.status === "applied") return real ? "accepted" : "empty";
  if (real) return "draft";
  return "empty";
}

const STATE_BORDER: Record<RowState, string> = {
  accepted: "var(--bf-success)",
  draft: "var(--bf-warning)",
  rejected: "var(--bf-danger)",
  empty: "transparent",
};

function audienceOf(item: QuestionnaireItem): Audience {
  // Default (null/unknown) leans customer — safer to route a business/legal question to
  // the customer than to have the MSP answer something it can't verify.
  return item.audience === "msp" ? "msp" : "customer";
}

// Group key from the leading question number ("4." / "4.a.i" / "9." all → that number),
// scoped per section. Unnumbered continuation lines inherit the preceding number's group
// so parent + sub-questions stay together; an unnumbered item with no preceding number is
// its own group.
function buildGroupKeys(items: QuestionnaireItem[]): Map<string, string> {
  const map = new Map<string, string>();
  let current = "";
  let currentSection = "__init__";
  for (const item of items) {
    const sec = String(item.section_id ?? "none");
    if (sec !== currentSection) {
      currentSection = sec;
      current = "";
    }
    const m = (item.question_text ?? "").match(/^\s*(\d+)\s*[.)]/);
    if (m) current = `${sec}#${m[1]}`;
    else if (!current) current = `${sec}#solo:${item.id}`;
    map.set(item.id, current);
  }
  return map;
}

interface AnswerCitation {
  target_type?: string;
  target_id?: string;
  label?: string;
  excerpt?: string;
}

function parseCitations(raw?: string | null): AnswerCitation[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function targetHref(targetType?: string, targetId?: string): string | null {
  if (!targetId) return null;
  if (targetType === "applied_control") return `/applied-controls/${targetId}`;
  if (targetType === "evidence") return `/evidence/${targetId}`;
  if (targetType === "policy") return `/policies/${targetId}`;
  if (targetType === "assessment_control") return "/assessments";
  if (targetType === "control") return "/controls";
  return null;
}

function parseJsonObject(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function proposalTarget(proposal: QuestionnaireProposal): { type: string; id?: string; label: string } {
  const draft = parseJsonObject(proposal.draft_payload_json);
  const targetType = proposal.target_type === "link" ? String(draft.target_type ?? "link") : proposal.target_type;
  const targetId = proposal.target_type === "link" ? String(draft.target_id ?? "") : proposal.target_id ?? "";
  const label = String(draft.name ?? draft.title ?? draft.target_label ?? targetId ?? labelize(targetType));
  return { type: targetType, id: targetId || undefined, label };
}

export default function QuestionnaireDetailPage() {
  const { canEdit } = useGrcPermissions();
  const { id = "" } = useParams<{ id: string }>();
  const orgNameById = useOrgNamesMap();

  const [activeTab, setActiveTab] = useState<QuestionnaireTab>("questions");
  const [questionnaire, setQuestionnaire] = useState<Questionnaire | null>(null);
  const [sourceDocument, setSourceDocument] = useState<SourceDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newQuestion, setNewQuestion] = useState("");
  const [addingQuestion, setAddingQuestion] = useState(false);
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});

  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterAudience, setFilterAudience] = useState<string>("all");
  const [openSources, setOpenSources] = useState<Set<string>>(new Set());

  const [editOpen, setEditOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editDraft, setEditDraft] = useState<{ name: string; carrier: string; status: QuestionnaireStatus; organization_id: string | null }>(
    { name: "", carrier: "", status: "draft", organization_id: "" },
  );

  const { mutate: extractQuestionnaire, loading: extracting } = useWorkflowMutation(WF_EXTRACT_GRC_QUESTIONNAIRE);
  const { mutate: draftQuestionnaireAnswers, loading: draftingAnswers } = useWorkflowMutation(WF_DRAFT_GRC_QUESTIONNAIRE_ANSWERS);
  const { mutate: applyQuestionnaireAnswers, loading: applyingAnswers } = useWorkflowMutation(WF_APPLY_GRC_QUESTIONNAIRE_ANSWERS);
  const { mutate: classifyGaps, loading: classifying } = useWorkflowMutation(WF_CLASSIFY_GAPS);

  const busy = extracting || draftingAnswers || classifying || applyingAnswers;

  const load = async (showSpinner = true) => {
    if (!id) return;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const row = unwrapRow<Questionnaire>(await tables.get(TABLE_QUESTIONNAIRES, id));
      if (!row) {
        setError("Questionnaire not found.");
        setQuestionnaire(null);
        setSourceDocument(null);
        return;
      }
      setQuestionnaire(row);
      if (row.source_document_id) {
        const source = unwrapRow<SourceDocument>(await tables.get(TABLE_SOURCE_DOCUMENTS, row.source_document_id));
        setSourceDocument(source);
      } else {
        setSourceDocument(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load questionnaire");
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const { rows: sections } = useTable<QuestionnaireSection>(TABLE_QUESTIONNAIRE_SECTIONS, {
    where: { questionnaire_id: id },
    pageSize: 1000,
    order_by: "sort_order",
    order_dir: "asc",
  });
  const { rows: items } = useTable<QuestionnaireItem>(TABLE_QUESTIONNAIRE_ITEMS, {
    where: { questionnaire_id: id },
    pageSize: 1000,
    order_by: "sort_order",
    order_dir: "asc",
  });
  const { rows: responses } = useTable<QuestionnaireResponse>(TABLE_QUESTIONNAIRE_RESPONSES, {
    where: { questionnaire_id: id },
    pageSize: 1000,
  });
  const { rows: runs } = useTable<QuestionnaireRun>(TABLE_QUESTIONNAIRE_RUNS, {
    where: { questionnaire_id: id },
    pageSize: 100,
    order_by: "created_at",
    order_dir: "desc",
  });
  const { rows: controlLinks } = useTable<QuestionnaireControlLink>(TABLE_QUESTIONNAIRE_CONTROL_LINKS, {
    where: { questionnaire_id: id },
    pageSize: 1000,
  });
  const { rows: proposals } = useTable<QuestionnaireProposal>(TABLE_QUESTIONNAIRE_PROPOSALS, {
    where: { questionnaire_id: id },
    pageSize: 1000,
  });
  const { rows: appliedControls } = useTable<AppliedControl>(TABLE_APPLIED_CONTROLS, { pageSize: 1000 });
  const { rows: controls } = useTable<Control>(TABLE_CONTROLS, { pageSize: 1000 });
  const { rows: assessmentControls } = useTable<AssessmentControl>(TABLE_ASSESSMENT_CONTROLS, { pageSize: 1000 });
  const { rows: evidenceRows } = useTable<Evidence>(TABLE_EVIDENCE, { pageSize: 1000 });
  const { rows: policyRows } = useTable<Policy>(TABLE_POLICIES, { pageSize: 1000 });

  const sectionById = useMemo(() => {
    const map = new Map<string, QuestionnaireSection>();
    (sections ?? []).forEach((row) => map.set(row.id, row));
    return map;
  }, [sections]);

  const responseByItemId = useMemo(() => {
    const map = new Map<string, QuestionnaireResponse>();
    (responses ?? []).forEach((row) => map.set(row.item_id, row));
    return map;
  }, [responses]);

  const linksByItemId = useMemo(() => {
    const map = new Map<string, QuestionnaireControlLink[]>();
    (controlLinks ?? []).forEach((row) => {
      if (!row.item_id) return;
      const next = map.get(row.item_id) ?? [];
      next.push(row);
      map.set(row.item_id, next);
    });
    return map;
  }, [controlLinks]);

  const proposalsByItemId = useMemo(() => {
    const map = new Map<string, QuestionnaireProposal[]>();
    (proposals ?? []).forEach((row) => {
      if (!row.item_id) return;
      const next = map.get(row.item_id) ?? [];
      next.push(row);
      map.set(row.item_id, next);
    });
    return map;
  }, [proposals]);

  const proposalByLinkId = useMemo(() => {
    const map = new Map<string, QuestionnaireProposal>();
    (proposals ?? []).forEach((row) => {
      if (row.action === "use_existing" && row.target_type === "link" && row.target_id) {
        map.set(row.target_id, row);
      }
    });
    return map;
  }, [proposals]);

  const targetLabels = useMemo(() => {
    const labels = new Map<string, { label: string; meta?: string | null; href?: string | null }>();
    (appliedControls ?? []).forEach((row) =>
      labels.set(`applied_control:${row.id}`, {
        label: row.name,
        meta: row.status ? labelize(row.status) : null,
        href: `/applied-controls/${row.id}`,
      }),
    );
    (controls ?? []).forEach((row) =>
      labels.set(`control:${row.id}`, {
        label: `${row.control_id} ${row.title}`.trim(),
        meta: "Reference control",
        href: "/controls",
      }),
    );
    (assessmentControls ?? []).forEach((row) => {
      const control = (controls ?? []).find((ctrl) => ctrl.id === row.control_id);
      labels.set(`assessment_control:${row.id}`, {
        label: control ? `${control.control_id} ${control.title}`.trim() : row.id,
        meta: row.status ? labelize(row.status) : "Assessment control",
        href: row.assessment_id ? `/assessments/${row.assessment_id}` : "/assessments",
      });
    });
    (evidenceRows ?? []).forEach((row) =>
      labels.set(`evidence:${row.id}`, {
        label: row.name,
        meta: row.type ? labelize(row.type) : null,
        href: `/evidence/${row.id}`,
      }),
    );
    (policyRows ?? []).forEach((row) =>
      labels.set(`policy:${row.id}`, {
        label: row.name,
        meta: row.status ? labelize(row.status) : null,
        href: `/policies/${row.id}`,
      }),
    );
    return labels;
  }, [appliedControls, assessmentControls, controls, evidenceRows, policyRows]);

  const stats = useMemo(() => {
    const allItems = items ?? [];
    let accepted = 0;
    let drafted = 0;
    let todo = 0;
    let rejected = 0;
    let customer = 0;
    let acceptedUnapplied = 0;
    for (const item of allItems) {
      const resp = responseByItemId.get(item.id);
      const st = rowStateOf(resp);
      if (st === "accepted") accepted += 1;
      else if (st === "draft") drafted += 1;
      else if (st === "rejected") rejected += 1;
      else todo += 1;
      if (audienceOf(item) === "customer") customer += 1;
      if (resp?.status === "accepted") acceptedUnapplied += 1;
    }
    const acceptedProposals = (proposals ?? []).filter((row) => row.status === "accepted").length;
    return { total: allItems.length, accepted, drafted, todo, rejected, customer, acceptedUnapplied, acceptedProposals };
  }, [items, responseByItemId, proposals]);

  const groupKeys = useMemo(() => buildGroupKeys(items ?? []), [items]);

  const filteredSections = useMemo(() => {
    // Audience filter is group-aware: keep an entire question group (parent + all
    // sub-questions) whenever ANY member matches, so context is never split.
    const audienceGroups: Set<string> | null =
      filterAudience === "all"
        ? null
        : new Set(
            (items ?? [])
              .filter((i) => audienceOf(i) === filterAudience)
              .map((i) => groupKeys.get(i.id)!),
          );
    const order: Array<string | null> = [];
    const bySection = new Map<string | null, QuestionnaireItem[]>();
    for (const item of items ?? []) {
      if (audienceGroups && !audienceGroups.has(groupKeys.get(item.id)!)) continue;
      const resp = responseByItemId.get(item.id);
      if (filterStatus !== "all" && rowStateOf(resp) !== filterStatus) continue;
      const key = item.section_id ?? null;
      if (!bySection.has(key)) {
        bySection.set(key, []);
        order.push(key);
      }
      bySection.get(key)!.push(item);
    }
    return order.map((secId) => ({
      secId,
      title: secId ? sectionById.get(secId)?.title ?? "Unknown section" : "Ungrouped",
      items: bySection.get(secId) ?? [],
    }));
  }, [items, responseByItemId, sectionById, filterStatus, filterAudience, groupKeys]);

  const filteredCount = useMemo(
    () => filteredSections.reduce((n, s) => n + s.items.length, 0),
    [filteredSections],
  );

  const toggleSources = (itemId: string) => {
    setOpenSources((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const addManualQuestion = async () => {
    if (!questionnaire) return;
    const text = newQuestion.trim();
    if (!text) {
      toast.error("Question text is required");
      return;
    }
    setAddingQuestion(true);
    try {
      const sortOrder = ((items ?? []).length + 1) * 10;
      await tables.insert(TABLE_QUESTIONNAIRE_ITEMS, {
        organization_id: questionnaire.organization_id,
        questionnaire_id: questionnaire.id,
        question_text: text,
        answer_type: "unknown",
        audience: "customer",
        sort_order: sortOrder,
        status: "extracted",
        metadata_json: JSON.stringify({ source: "manual" }),
      });
      await tables.update(TABLE_QUESTIONNAIRES, questionnaire.id, { status: "needs_review" });
      setNewQuestion("");
      toast.success("Question added");
      await load(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add question");
    } finally {
      setAddingQuestion(false);
    }
  };

  const openEdit = () => {
    if (!questionnaire) return;
    setEditDraft({
      name: questionnaire.name ?? "",
      carrier: questionnaire.carrier ?? "",
      status: (questionnaire.status ?? "draft") as QuestionnaireStatus,
      organization_id: questionnaire.organization_id ?? "",
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!questionnaire) return;
    const name = editDraft.name.trim();
    if (!name) {
      toast.error("Name is required");
      return;
    }
    if (!editDraft.organization_id) {
      toast.error("Customer is required");
      return;
    }
    setSavingEdit(true);
    try {
      const orgChanged = Boolean(editDraft.organization_id) && editDraft.organization_id !== questionnaire.organization_id;
      await tables.update(TABLE_QUESTIONNAIRES, questionnaire.id, {
        name,
        carrier: editDraft.carrier.trim() || null,
        status: editDraft.status,
        ...(orgChanged ? { organization_id: editDraft.organization_id } : {}),
      });
      if (orgChanged) {
        // Re-scope child rows so the org-member read policy keeps them visible under the new customer.
        const org = editDraft.organization_id;
        const updates: Array<Promise<unknown>> = [];
        (sections ?? []).forEach((r) => updates.push(tables.update(TABLE_QUESTIONNAIRE_SECTIONS, r.id, { organization_id: org })));
        (items ?? []).forEach((r) => updates.push(tables.update(TABLE_QUESTIONNAIRE_ITEMS, r.id, { organization_id: org })));
        (responses ?? []).forEach((r) => updates.push(tables.update(TABLE_QUESTIONNAIRE_RESPONSES, r.id, { organization_id: org })));
        (controlLinks ?? []).forEach((r) => updates.push(tables.update(TABLE_QUESTIONNAIRE_CONTROL_LINKS, r.id, { organization_id: org })));
        (proposals ?? []).forEach((r) => updates.push(tables.update(TABLE_QUESTIONNAIRE_PROPOSALS, r.id, { organization_id: org, applied_organizations: [org], excluded_organizations: [] })));
        (runs ?? []).forEach((r) => updates.push(tables.update(TABLE_QUESTIONNAIRE_RUNS, r.id, { organization_id: org })));
        if (questionnaire.source_document_id) updates.push(tables.update(TABLE_SOURCE_DOCUMENTS, questionnaire.source_document_id, { organization_id: org }));
        await Promise.all(updates);
      }
      toast.success("Questionnaire updated");
      setEditOpen(false);
      await load(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update questionnaire");
    } finally {
      setSavingEdit(false);
    }
  };

  const updateItemAudience = async (item: QuestionnaireItem, audience: Audience) => {
    if (audienceOf(item) === audience) return;
    try {
      await tables.update(TABLE_QUESTIONNAIRE_ITEMS, item.id, { audience });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update audience");
    }
  };

  // Commit an answer. Filling a field = confirming it, so a non-empty value lands
  // as "accepted" (ready to apply); clearing it drops back to needs_review.
  const commitAnswer = async (item: QuestionnaireItem, rawValue: string) => {
    if (!questionnaire) return;
    const value = rawValue.trim();
    const existing = responseByItemId.get(item.id);
    const status: QuestionnaireResponseStatus = value ? "accepted" : "needs_review";
    // Avoid a write when nothing meaningfully changed (e.g. tabbing through an
    // already-empty field that never had a response).
    if (!existing && !value) return;
    if (existing && existing.final_answer === value && existing.status === status) return;
    try {
      if (existing) {
        await tables.update(TABLE_QUESTIONNAIRE_RESPONSES, existing.id, {
          final_answer: value,
          status,
          generated_by: existing.generated_by ?? "user",
        });
      } else {
        await tables.insert(TABLE_QUESTIONNAIRE_RESPONSES, {
          organization_id: questionnaire.organization_id,
          questionnaire_id: questionnaire.id,
          item_id: item.id,
          final_answer: value,
          status,
          generated_by: "user",
        });
      }
      await tables.update(TABLE_QUESTIONNAIRE_ITEMS, item.id, { status: value ? "accepted" : "needs_review" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save answer");
    }
  };

  const updateControlLinkStatus = async (link: QuestionnaireControlLink, status: "accepted" | "rejected") => {
    try {
      await tables.update(TABLE_QUESTIONNAIRE_CONTROL_LINKS, link.id, { status });
      const proposal = proposalByLinkId.get(link.id);
      if (proposal) {
        await tables.update(TABLE_QUESTIONNAIRE_PROPOSALS, proposal.id, { status });
      }
      toast.success(status === "accepted" ? "Link accepted" : "Link rejected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update link");
    }
  };

  const updateProposalStatus = async (proposal: QuestionnaireProposal, status: "accepted" | "rejected") => {
    try {
      await tables.update(TABLE_QUESTIONNAIRE_PROPOSALS, proposal.id, { status });
      if (proposal.action === "use_existing" && proposal.target_type === "link" && proposal.target_id) {
        await tables.update(TABLE_QUESTIONNAIRE_CONTROL_LINKS, proposal.target_id, { status });
      }
      toast.success(status === "accepted" ? "Proposal accepted" : "Proposal rejected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update proposal");
    }
  };

  const runExtraction = async () => {
    if (!questionnaire) return;
    try {
      const result = (await extractQuestionnaire({
        questionnaire_id: questionnaire.id,
        replace_existing: true,
      })) as { items?: number; sections?: number };
      toast.success(`Extracted ${result?.items ?? 0} questions`);
      await load(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Question extraction failed");
      await load(false);
    }
  };

  const runAnswerDrafting = async () => {
    if (!questionnaire) return;
    try {
      const result = (await draftQuestionnaireAnswers({
        questionnaire_id: questionnaire.id,
        replace_existing: false,
      })) as { responses?: number; links?: number };
      toast.success(`Drafted ${result?.responses ?? 0} answers`);
      setDraftAnswers({});
      // Gap recommendations follow drafting automatically; failure here shouldn't
      // bury the successful draft, so swallow its error (re-runnable from the
      // Recommendations tab).
      try {
        await classifyGaps({ questionnaire_id: questionnaire.id });
      } catch (gapErr) {
        toast.error(`Recommendations step failed: ${gapErr instanceof Error ? gapErr.message : String(gapErr)}`);
      }
      await load(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Answer drafting failed");
      await load(false);
    }
  };

  const runApplyAnswers = async () => {
    if (!questionnaire) return;
    try {
      const result = (await applyQuestionnaireAnswers({
        questionnaire_id: questionnaire.id,
      })) as { responses?: number; proposals?: number; created_records?: number; relationship_links?: number; control_mappings?: number };
      toast.success(
        `Applied ${result?.proposals ?? 0} proposals, ${result?.created_records ?? 0} created records, ${result?.control_mappings ?? 0} mappings`,
      );
      await load(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Apply failed");
      await load(false);
    }
  };

  if (loading) {
    return (
      <div className="cv-card" style={{ padding: 32, display: "flex", justifyContent: "center", color: "var(--cv-fg-3)" }}>
        <Loader2 size={18} className="animate-spin" style={{ marginRight: 10 }} />
        Loading questionnaire...
      </div>
    );
  }

  if (error || !questionnaire) {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <Link to="/questionnaires" className="cv-btn cv-btn--secondary cv-btn--sm" style={{ width: "fit-content", textDecoration: "none" }}>
          <ArrowLeft size={14} />
          Back to questionnaires
        </Link>
        <div className="cv-callout cv-callout--danger">{error ?? "Questionnaire not found."}</div>
      </div>
    );
  }

  const hasItems = (items ?? []).length > 0;
  const sourceFileName = (sourceDocument?.file_name ?? "").toLowerCase();
  const sourceMime = (sourceDocument?.mime_type ?? "").toLowerCase();
  const hasRenderableSource = Boolean(
    sourceDocument && (
      sourceMime === "application/pdf" ||
      sourceMime.endsWith("wordprocessingml.document") ||
      sourceFileName.endsWith(".pdf") ||
      sourceFileName.endsWith(".docx")
    )
  );
  const hasAnySource = Boolean(questionnaire.source_document_id && sourceDocument?.file_path);

  return (
    <div className="flex flex-col" style={{ height: "100%", minHeight: 0, gap: 10 }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", flexShrink: 0 }}>
        <Link to="/questionnaires" className="cv-btn cv-btn--secondary cv-btn--sm" style={{ textDecoration: "none" }}>
          <ArrowLeft size={14} /> Back
        </Link>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--cv-fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {questionnaire.name}
            </span>
            {canEdit ? <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={openEdit} title="Edit questionnaire" aria-label="Edit questionnaire" style={{ padding: 4, flexShrink: 0 }}>
              <Pencil size={14} />
            </button> : null}
          </div>
          <div style={{ fontSize: 12, color: "var(--cv-fg-3)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
            <span>{orgNameById.get(questionnaire.organization_id) ?? "Unknown organization"}</span>
            {questionnaire.carrier ? <><span>·</span><span>{questionnaire.carrier}</span></> : null}
            <span className={"cv-chip cv-chip--sm " + statusTone(questionnaire.status)}>{labelize(questionnaire.status)}</span>
          </div>
        </div>
        {canEdit ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={runExtraction} disabled={extracting || !hasAnySource}>
            <Sparkles size={14} /> {extracting ? "Extracting…" : "Extract"}
          </button>
          <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={runAnswerDrafting} disabled={draftingAnswers || classifying || !hasItems}>
            <Sparkles size={14} /> {draftingAnswers ? "Drafting…" : classifying ? "Finishing…" : "Draft"}
          </button>
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={runApplyAnswers} disabled={applyingAnswers || (stats.acceptedUnapplied === 0 && stats.acceptedProposals === 0)}>
            <Check size={14} /> {applyingAnswers ? "Applying…" : "Apply"}
          </button>
        </div> : null}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--cv-border-1)", flexShrink: 0 }}>
        {([
          ["questions", "Questions", hasItems ? stats.total : 0],
          ...(hasRenderableSource ? [["source", "Source", null] as const] : []),
          ["recommendations", "Recommendations", null],
          ["runs", "Run history", (runs ?? []).length],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className="cv-btn grc-tab"
            style={{
              background: "transparent",
              border: "none",
              borderBottom: activeTab === key ? "2px solid var(--cv-cb)" : "2px solid transparent",
              color: activeTab === key ? "var(--cv-fg-1)" : "var(--cv-fg-3)",
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 0,
            }}
          >
            {label}{typeof count === "number" && count > 0 ? <span style={{ marginLeft: 6, color: "var(--cv-fg-3)" }}>{count}</span> : null}
          </button>
        ))}
      </div>

      {/* Active operation progress banner */}
      {busy ? (
        <div
          className="grc-progress-banner"
          style={{
            display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
            padding: "10px 14px", borderRadius: 8,
            background: "var(--cv-bg-3)", border: "1px solid var(--cv-border-1)",
            color: "var(--cv-fg-1)", fontSize: 13,
          }}
        >
          <Loader2 size={16} className="animate-spin" style={{ color: "var(--cv-cb)" }} />
          <span style={{ fontWeight: 500 }}>
            {extracting ? "Extracting questions and tagging audience…"
              : draftingAnswers ? "Drafting answers from your GRC data…"
              : classifying ? "Building gap recommendations…"
              : "Applying accepted answers to GRC…"}
          </span>
          <span style={{ fontSize: 12, color: "var(--cv-fg-3)" }}>This can take up to a minute for large questionnaires.</span>
          <span style={{ flex: 1 }} />
          <span className="grc-progress-dots" aria-hidden />
        </div>
      ) : null}

      {/* Content area */}
      {activeTab === "source" ? (
        <div className="grc-pdf-pane" style={{ flex: 1, minHeight: 0 }}>
          <QuestionnairePdfPane
            sourceDocumentId={questionnaire.source_document_id}
            fileName={sourceDocument?.file_name}
            height="100%"
          />
        </div>
      ) : activeTab === "questions" ? (
        !hasItems ? (
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            <div style={{ maxWidth: 880, margin: "0 auto", width: "100%", padding: "0 2px 16px" }}>
            {canEdit ? <QuestionnaireDropzone questionnaireId={id} onUploaded={() => load(false)} /> : <div className="cv-small">No questions have been extracted yet.</div>}
            </div>
          </div>
        ) : (
          <>
            {/* Progress + filters */}
            <div style={{ flexShrink: 0, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 12, color: "var(--cv-fg-3)" }}>
                <ProgressStat color="var(--bf-success)" label="accepted" value={stats.accepted} />
                <ProgressStat color="var(--bf-warning)" label="to confirm" value={stats.drafted} />
                <ProgressStat color="var(--bf-muted)" label="to do" value={stats.todo} />
                {stats.customer > 0 ? <ProgressStat color="var(--bf-brand-purple)" label="customer" value={stats.customer} /> : null}
              </div>
              <span style={{ flex: 1 }} />
              <div style={{ minWidth: 160 }}>
                <ThemedSelect ariaLabel="Filter by status" value={filterStatus} onChange={setFilterStatus} options={STATUS_FILTER_OPTIONS} />
              </div>
              <div style={{ minWidth: 160 }}>
                <ThemedSelect ariaLabel="Filter by audience" value={filterAudience} onChange={setFilterAudience} options={AUDIENCE_FILTER_OPTIONS} />
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              <div style={{ maxWidth: 1000, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 16, padding: "2px 2px 16px" }}>
                {filteredCount === 0 ? (
                  <div style={{ padding: 32, textAlign: "center", color: "var(--cv-fg-3)", fontSize: 13 }}>
                    No questions match these filters.
                  </div>
                ) : (
                  filteredSections.map((sec) => (
                    <div key={sec.secId ?? "ungrouped"} style={{ display: "flex", flexDirection: "column" }}>
                      <div className="grc-section-head">
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--cv-fg-2)", textTransform: "uppercase", letterSpacing: 0.6 }}>{sec.title}</span>
                        <span style={{ fontSize: 11, color: "var(--cv-fg-3)" }}>{sec.items.length}</span>
                      </div>
                      <div className="cv-card" style={{ padding: 0, overflow: "hidden" }}>
                        {sec.items.map((item, idx) => {
                          const isChild = idx > 0 && groupKeys.get(item.id) === groupKeys.get(sec.items[idx - 1].id);
                          const response = responseByItemId.get(item.id);
                          const real = realAnswer(response);
                          const fieldValue = draftAnswers[item.id] ?? real;
                          const hint = !real && answerText(response) ? answerText(response) : undefined;
                          const itemLinks = linksByItemId.get(item.id) ?? [];
                          const itemProposals = (proposalsByItemId.get(item.id) ?? []).filter(
                            (proposal) => !(proposal.action === "use_existing" && proposal.target_type === "link" && proposal.target_id && itemLinks.some((link) => link.id === proposal.target_id)),
                          );
                          const citations = parseCitations(response?.citations_json);
                          const hasSources = citations.length > 0 || itemLinks.length > 0 || itemProposals.length > 0;
                          const state = rowStateOf(response);
                          const audience = audienceOf(item);
                          const sourcesOpen = openSources.has(item.id);
                          return (
                            <div
                              key={item.id}
                              className="grc-form-row"
                              style={{
                                borderTop: idx === 0 ? "none" : "1px solid var(--cv-border-1)",
                                borderLeft: `3px solid ${STATE_BORDER[state]}`,
                              }}
                            >
                              <div className="grc-q-cell" style={{ paddingLeft: isChild ? 20 : 0 }}>
                                <span className="grc-q-text">{item.question_text}</span>
                                {hasSources ? (
                                  <button
                                    type="button"
                                    className={"grc-src-btn" + (sourcesOpen ? " is-open" : "")}
                                    onClick={() => toggleSources(item.id)}
                                    title={`${citations.length + itemLinks.length + itemProposals.length} source(s)`}
                                    aria-label={sourcesOpen ? "Hide sources" : "Show sources"}
                                    aria-expanded={sourcesOpen}
                                  >
                                    <Info size={13} />
                                  </button>
                                ) : null}
                              </div>

                              <div className="grc-input-cell">
                                <AnswerField
                                  item={item}
                                  value={fieldValue}
                                  placeholder={hint}
                                  disabled={!canEdit || state === "rejected"}
                                  onChange={(v) => setDraftAnswers((current) => ({ ...current, [item.id]: v }))}
                                  onCommit={(v) => commitAnswer(item, v)}
                                />
                              </div>

                              <div className="grc-meta-cell">
                                <AudienceToggle value={audience} onChange={canEdit ? (a) => updateItemAudience(item, a) : undefined} />
                              </div>

                              {sourcesOpen && hasSources ? (
                                <div className="grc-sources">
                                  {citations.length > 0 ? (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                      {citations.slice(0, 6).map((citation, cidx) => {
                                        const href = targetHref(citation.target_type, citation.target_id);
                                        const label = citation.label || labelize(citation.target_type) || "Citation";
                                        return (
                                          <div key={`${citation.target_type}-${citation.target_id}-${cidx}`} style={{ color: "var(--cv-fg-2)", fontSize: 11 }}>
                                            {href ? <Link to={href} style={{ color: "var(--cv-cb)", textDecoration: "none" }}>{label}</Link> : <span>{label}</span>}
                                            {citation.excerpt ? <span style={{ color: "var(--cv-fg-3)" }}> — {citation.excerpt}</span> : null}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : null}
                                  {itemLinks.length > 0 ? (
                                    <LinkReviewList
                                      links={itemLinks}
                                      proposals={itemProposals}
                                      proposalByLinkId={proposalByLinkId}
                                      targetLabels={targetLabels}
                                      onAccept={(link) => updateControlLinkStatus(link, "accepted")}
                                      onReject={(link) => updateControlLinkStatus(link, "rejected")}
                                      onAcceptProposal={(proposal) => updateProposalStatus(proposal, "accepted")}
                                      onRejectProposal={(proposal) => updateProposalStatus(proposal, "rejected")}
                                      readOnly={!canEdit}
                                    />
                                  ) : null}
                                  {itemLinks.length === 0 && itemProposals.length > 0 ? (
                                    <LinkReviewList
                                      links={[]}
                                      proposals={itemProposals}
                                      proposalByLinkId={proposalByLinkId}
                                      targetLabels={targetLabels}
                                      onAccept={(link) => updateControlLinkStatus(link, "accepted")}
                                      onReject={(link) => updateControlLinkStatus(link, "rejected")}
                                      onAcceptProposal={(proposal) => updateProposalStatus(proposal, "accepted")}
                                      onRejectProposal={(proposal) => updateProposalStatus(proposal, "rejected")}
                                      readOnly={!canEdit}
                                    />
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}

                {canEdit ? <details>
                  <summary style={{ fontSize: 12, color: "var(--cv-fg-2)", cursor: "pointer", padding: "6px 2px" }}>
                    <Plus size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} /> Add question manually
                  </summary>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <Textarea
                      aria-label="New questionnaire question"
                      value={newQuestion}
                      onChange={(e) => setNewQuestion(e.target.value)}
                      rows={2}
                      placeholder="Paste a questionnaire question…"
                    />
                    <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={addManualQuestion} disabled={addingQuestion} style={{ alignSelf: "flex-start" }}>
                      <Plus size={14} /> {addingQuestion ? "Adding…" : "Add"}
                    </button>
                  </div>
                </details> : null}
              </div>
            </div>
          </>
        )
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div style={{ maxWidth: 880, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 10, padding: "0 2px 16px" }}>
            {activeTab === "recommendations" ? (
              <QuestionnaireRecommendations questionnaireId={id} readOnly={!canEdit} />
            ) : activeTab === "runs" ? (
              (runs ?? []).length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--cv-fg-3)", fontSize: 13 }}>
                  No runs yet. Drafting, extraction, and apply runs will appear here.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {(runs ?? []).map((run) => (
                    <div key={run.id} className="cv-card cv-card--pad-sm" style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
                      <span className={"cv-chip cv-chip--sm " + statusTone(run.status)}>{labelize(run.status)}</span>
                      <span style={{ fontWeight: 500 }}>{labelize(run.run_type)}</span>
                      <span style={{ color: "var(--cv-fg-3)", fontSize: 12 }}>{run.model ?? "—"}</span>
                      <span style={{ marginLeft: "auto", color: "var(--cv-fg-3)", fontSize: 12 }}>{fmtDate(run.completed_at ?? run.started_at ?? run.created_at)}</span>
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </div>
        </div>
      )}

      {canEdit && editOpen ? (
        <BifrostDialogFrame
          onDismiss={() => setEditOpen(false)}
          dismissDisabled={savingEdit}
          labelledBy="edit-questionnaire-title"
          style={{ width: "min(560px, calc(100vw - 32px))" }}
        >
            <div className="cv-dialog__header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 id="edit-questionnaire-title" className="cv-dialog__title">Edit questionnaire</h2>
              <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={() => setEditOpen(false)} disabled={savingEdit} style={{ padding: 4 }} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="cv-field-group">
                <label className="cv-field-label" htmlFor="edit-questionnaire-name">Name *</label>
                <Input id="edit-questionnaire-name" value={editDraft.name} onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))} autoFocus />
              </div>
              <div className="cv-field-group">
                <label className="cv-field-label" htmlFor="edit-questionnaire-carrier">Carrier</label>
                <Input id="edit-questionnaire-carrier" value={editDraft.carrier} onChange={(e) => setEditDraft((d) => ({ ...d, carrier: e.target.value }))} />
              </div>
              <div className="cv-field-group">
                <label className="cv-field-label">Status</label>
                <ThemedSelect value={editDraft.status} onChange={(v) => setEditDraft((d) => ({ ...d, status: v as QuestionnaireStatus }))} options={QSTATUS_OPTIONS} ariaLabel="Status" />
              </div>
              <OrgPicker
                value={editDraft.organization_id}
                onChange={(organization_id) => setEditDraft((d) => ({ ...d, organization_id }))}
                allowGlobal={false}
                label="Customer"
                required
              />
              {editDraft.organization_id !== questionnaire.organization_id ? (
                <div style={{ fontSize: 12, color: "var(--bf-warning)", background: "var(--bf-warning-soft)", border: "1px solid var(--bf-warning)", borderRadius: "var(--bf-radius-surface)", padding: "8px 10px" }}>
                  Changing the customer re-scopes this questionnaire and all its sections, questions, answers, and links to the new organization.
                </div>
              ) : null}
            </div>
            <div className="cv-dialog__footer" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setEditOpen(false)} disabled={savingEdit}>Cancel</button>
              <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={saveEdit} disabled={savingEdit}>{savingEdit ? "Saving…" : "Save changes"}</button>
            </div>
        </BifrostDialogFrame>
      ) : null}

      <style>{`
        @keyframes grcSlideInRight {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .grc-pdf-pane { animation: grcSlideInRight var(--bf-motion-route) var(--bf-ease-standard) both; }
        .grc-dropzone {
          transition: border-color var(--bf-motion-feedback) var(--bf-ease-standard), background var(--bf-motion-feedback) var(--bf-ease-standard);
        }
        .grc-dropzone:hover { border-color: var(--bf-line-strong); background: var(--bf-cool); }
        .grc-tab { transition: color var(--bf-motion-feedback) var(--bf-ease-standard), border-color var(--bf-motion-feedback) var(--bf-ease-standard); }

        .grc-section-head {
          position: sticky; top: 0; z-index: 2;
          display: flex; align-items: center; gap: 8px;
          padding: 6px 4px; margin-bottom: 6px;
          background: var(--cv-bg-1);
          border-bottom: 1px solid var(--cv-border-1);
        }

        .grc-form-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 340px 116px;
          align-items: start;
          column-gap: 16px;
          row-gap: 0;
          padding: 7px 12px 7px 9px;
        }
        .grc-form-row:hover { background: var(--cv-bg-2); }
        /* full question, wraps to as many lines as needed; first line aligns with the input */
        .grc-q-cell { display: flex; align-items: flex-start; gap: 6px; min-width: 0; padding-top: 6px; }
        .grc-q-text {
          font-size: 13px; color: var(--cv-fg-1); line-height: 1.4;
          min-width: 0; overflow-wrap: anywhere;
        }
        .grc-input-cell { display: flex; min-width: 0; }
        .grc-meta-cell { display: flex; align-items: flex-start; gap: 8px; justify-content: flex-end; padding-top: 3px; }

        /* material-style field: subtle fill + underline, no bubble */
        .grc-field {
          width: 100%;
          background: var(--cv-bg-2);
          border: none;
          border-bottom: 1.5px solid var(--cv-border-1);
          border-radius: 5px 5px 0 0;
          padding: 6px 8px;
          font-size: 13px;
          color: var(--cv-fg-1);
          outline: none;
          transition: border-color var(--bf-motion-feedback) var(--bf-ease-standard), background var(--bf-motion-feedback) var(--bf-ease-standard);
        }
        .grc-field::placeholder { color: var(--cv-fg-3); opacity: .8; font-style: italic; }
        .grc-field:hover { background: var(--cv-bg-3); }
        .grc-field:focus { border-bottom-color: var(--cv-cb); background: var(--cv-bg-3); }
        .grc-field:disabled { opacity: .45; }

        /* yes/no segmented (roving tabindex radiogroup) */
        .grc-seg { display: inline-flex; border: 1px solid var(--cv-border-1); border-radius: 6px; overflow: hidden; }
        .grc-seg button {
          border: none; background: transparent; cursor: pointer;
          padding: 5px 14px; font-size: 12px; color: var(--cv-fg-2);
          border-right: 1px solid var(--cv-border-1);
          transition: background var(--bf-motion-feedback) var(--bf-ease-standard), color var(--bf-motion-feedback) var(--bf-ease-standard);
        }
        .grc-seg button:last-child { border-right: none; }
        .grc-seg button:hover:not(.is-active) { background: var(--cv-bg-3); }
        .grc-seg button.is-active { background: var(--bf-primary); color: var(--bf-primary-foreground); }
        .grc-seg button:focus-visible { outline: 2px solid var(--cv-cb); outline-offset: -2px; }

        /* equal-width MSP / Customer toggle */
        .grc-aud {
          display: inline-grid; grid-template-columns: 1fr 1fr;
          border: 1px solid var(--cv-border-1); border-radius: 6px; overflow: hidden;
          width: 116px; flex-shrink: 0;
        }
        .grc-aud button {
          border: none; background: transparent; cursor: pointer;
          padding: 4px 0; font-size: 10.5px; font-weight: 600; letter-spacing: .3px;
          color: var(--cv-fg-3); text-transform: uppercase;
          transition: background var(--bf-motion-feedback) var(--bf-ease-standard), color var(--bf-motion-feedback) var(--bf-ease-standard);
        }
        .grc-aud button:first-child { border-right: 1px solid var(--cv-border-1); }
        .grc-aud button:hover:not(.is-active) { background: var(--cv-bg-3); }
        .grc-aud button.is-active { background: var(--bf-primary); color: var(--bf-primary-foreground); }

        .grc-src-btn {
          border: none; background: transparent; cursor: pointer;
          color: var(--cv-fg-3); padding: 2px; border-radius: 4px; flex-shrink: 0;
          display: inline-flex; align-items: center;
        }
        .grc-src-btn:hover, .grc-src-btn.is-open { color: var(--cv-cb); }

        .grc-sources {
          grid-column: 1 / -1;
          display: flex; flex-direction: column; gap: 8px;
          margin: 4px 0 8px 0; padding: 8px 10px;
          background: var(--cv-bg-2); border-radius: 6px;
        }

        .grc-progress-banner { animation: grcSlideInRight var(--bf-motion-disclosure) var(--bf-ease-out) both; position: relative; overflow: hidden; }
        .grc-progress-banner::after {
          content: ""; position: absolute; left: 0; bottom: 0; height: 2px; width: 35%;
          background: color-mix(in srgb, var(--bf-primary) 24%, transparent);
          animation: grcSweep var(--bf-motion-progress) var(--bf-ease-standard) infinite;
        }
        @keyframes grcSweep { 0% { transform: translateX(-120%); } 55%, 100% { transform: translateX(390%); } }
        .grc-progress-dots::after {
          content: "•••"; letter-spacing: 2px; color: var(--cv-cb);
          animation: grcBlink var(--bf-motion-progress) steps(4) infinite;
        }
        @keyframes grcBlink { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}

function ProgressStat({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color, display: "inline-block" }} />
      <strong style={{ color: "var(--cv-fg-1)", fontWeight: 600 }}>{value}</strong> {label}
    </span>
  );
}

function AudienceToggle({ value, onChange }: { value: Audience; onChange?: (a: Audience) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: Audience = ["ArrowLeft", "ArrowUp", "Home"].includes(event.key) ? "msp" : "customer";
    onChange?.(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-audience="${next}"]`)
      ?.focus();
  };

  return (
    <div className="grc-aud" role="radiogroup" aria-label="Audience">
      <button type="button" role="radio" data-audience="msp" aria-checked={value === "msp"} tabIndex={onChange && value === "msp" ? 0 : -1} className={value === "msp" ? "is-active" : ""} onKeyDown={onChange ? onKeyDown : undefined} onClick={onChange ? () => onChange("msp") : undefined} disabled={!onChange}>MSP</button>
      <button type="button" role="radio" data-audience="customer" aria-checked={value === "customer"} tabIndex={onChange && value === "customer" ? 0 : -1} className={value === "customer" ? "is-active" : ""} onKeyDown={onChange ? onKeyDown : undefined} onClick={onChange ? () => onChange("customer") : undefined} disabled={!onChange}>Cust</button>
    </div>
  );
}

function AnswerField({
  item,
  value,
  placeholder,
  onChange,
  onCommit,
  disabled,
}: {
  item: QuestionnaireItem;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  disabled?: boolean;
}) {
  const type = (item.answer_type ?? "unknown").toLowerCase();

  if (type === "yes_no") {
    return (
      <YesNoField
        label={`Answer: ${item.question_text}`}
        value={value}
        disabled={disabled}
        onPick={(v) => { onChange(v); onCommit(v); }}
      />
    );
  }

  if (type === "numeric") {
    return (
      <input
        aria-label={`Answer: ${item.question_text}`}
        className="grc-field"
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.,$%\s-]/g, ""))}
        onBlur={() => onCommit(value)}
        placeholder={placeholder ?? "Number…"}
        style={{ maxWidth: 200 }}
      />
    );
  }

  if (type === "date") {
    return (
      <input
        aria-label={`Answer date: ${item.question_text}`}
        className="grc-field"
        type="date"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit(value)}
        style={{ maxWidth: 200 }}
      />
    );
  }

  return (
    <input
      aria-label={`Answer: ${item.question_text}`}
      className="grc-field"
      type="text"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onCommit(value)}
      placeholder={placeholder ?? "Answer…"}
    />
  );
}

// Roving-tabindex radiogroup: one Tab stop per question, arrows move between
// choices, click/Enter selects. Keeps the form fast to fill by keyboard.
function YesNoField({
  label,
  value,
  disabled,
  onPick,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onPick: (v: string) => void;
}) {
  const opts = ["Yes", "No", "N/A"];
  // AI drafts arrive as full sentences ("Yes, the organization uses AutoElevate…").
  // Match by prefix, checking N/A first so "not applicable" doesn't read as "No".
  const cur = value.trim().toLowerCase();
  const activeIdx = (() => {
    if (!cur) return -1;
    if (cur.startsWith("n/a") || cur.startsWith("not applicable") || cur.startsWith("need")) return 2;
    if (cur.startsWith("yes")) return 0;
    if (cur.startsWith("no")) return 1;
    return -1;
  })();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIdx = activeIdx >= 0 ? activeIdx : 0;

  const onKey = (e: { key: string; preventDefault: () => void }, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      refs.current[(i + 1) % opts.length]?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      refs.current[(i - 1 + opts.length) % opts.length]?.focus();
    }
  };

  return (
    <div className="grc-seg" role="radiogroup" aria-label={label}>
      {opts.map((o, i) => {
        const active = i === activeIdx;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={active}
            ref={(el) => { refs.current[i] = el; }}
            tabIndex={i === focusIdx ? 0 : -1}
            disabled={disabled}
            className={active ? "is-active" : ""}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onPick(o)}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function LinkReviewList({
  links,
  proposals,
  proposalByLinkId,
  targetLabels,
  onAccept,
  onReject,
  onAcceptProposal,
  onRejectProposal,
  readOnly = false,
}: {
  links: QuestionnaireControlLink[];
  proposals: QuestionnaireProposal[];
  proposalByLinkId: Map<string, QuestionnaireProposal>;
  targetLabels: Map<string, { label: string; meta?: string | null; href?: string | null }>;
  onAccept: (link: QuestionnaireControlLink) => void;
  onReject: (link: QuestionnaireControlLink) => void;
  onAcceptProposal: (proposal: QuestionnaireProposal) => void;
  onRejectProposal: (proposal: QuestionnaireProposal) => void;
  readOnly?: boolean;
}) {
  if (links.length === 0 && proposals.length === 0) {
    return <span className="cv-small">No suggested links</span>;
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {links.map((link) => {
        const proposal = proposalByLinkId.get(link.id);
        const target = targetLabels.get(`${link.target_type}:${link.target_id}`);
        const href = target?.href ?? targetHref(link.target_type, link.target_id);
        const label = target?.label ?? link.target_id;
        const status = proposal?.status ?? link.status ?? "suggested";
        return (
          <div key={link.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, minWidth: 0 }}>
            <Link2 size={12} style={{ color: "var(--cv-fg-3)", flexShrink: 0 }} />
            {href ? (
              <Link to={href} className="cv-link" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</Link>
            ) : (
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
            )}
            <span className="cv-chip cv-chip--neutral">{labelize(link.target_type)}</span>
            {proposal?.needs_review ? <span className="cv-chip cv-chip--gold">Needs Review</span> : null}
            {status !== "accepted" && status !== "rejected" && status !== "applied" && !readOnly ? (
              <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }}>
                <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => proposal ? onAcceptProposal(proposal) : onAccept(link)}><Check size={12} /></button>
                <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => proposal ? onRejectProposal(proposal) : onReject(link)}><X size={12} /></button>
              </span>
            ) : (
              <span className={"cv-chip " + statusTone(status)} style={{ marginLeft: "auto" }}>{labelize(status)}</span>
            )}
          </div>
        );
      })}
      {proposals.map((proposal) => {
        const target = proposalTarget(proposal);
        const existing = target.id ? targetLabels.get(`${target.type}:${target.id}`) : undefined;
        const href = existing?.href ?? targetHref(target.type, target.id);
        const label = existing?.label ?? target.label;
        const status = proposal.status ?? "proposed";
        return (
          <div key={proposal.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, minWidth: 0 }}>
            <Link2 size={12} style={{ color: "var(--cv-fg-3)", flexShrink: 0 }} />
            {href ? (
              <Link to={href} className="cv-link" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</Link>
            ) : (
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
            )}
            {proposal.action === "create" ? <span className="cv-chip cv-chip--green">Create</span> : null}
            {proposal.needs_review ? <span className="cv-chip cv-chip--gold">Needs Review</span> : null}
            <span className="cv-chip cv-chip--neutral">{labelize(target.type)}</span>
            {status !== "accepted" && status !== "rejected" && status !== "applied" && !readOnly ? (
              <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }}>
                <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => onAcceptProposal(proposal)}><Check size={12} /></button>
                <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => onRejectProposal(proposal)}><X size={12} /></button>
              </span>
            ) : (
              <span className={"cv-chip " + statusTone(status)} style={{ marginLeft: "auto" }}>{labelize(status)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
