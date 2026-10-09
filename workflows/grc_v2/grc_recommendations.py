"""Gap classifier + recommendation lifecycle for Bifrost GRC questionnaires.

After draft_grc_questionnaire_answers writes responses, classify_questionnaire_gaps
groups them into actionable buckets:

- gap_kind: already_covered | evidence_gap | control_gap | policy_gap | low_confidence | needs_review
- who_acts: msp_action | customer_action | vendor_purchase | customer_decides | already_covered

Recommendations are persisted to grc-questionnaire-recommendations and survive re-runs
via a content_hash (item_id + gap_kind + title) — existing 'open' rows are reused, new
ones inserted, and 'done'/'dismissed' rows stay as-is even if the same gap surfaces again.
"""
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from bifrost import UserError, config, integrations, tables, workflow

from functions.grc_attribution import attributed_payload
from functions.grc_auth import bind_organization_scope, require_row_access


TABLE_QUESTIONNAIRES = "grc-questionnaires"
TABLE_QUESTIONNAIRE_ITEMS = "grc-questionnaire-items"
TABLE_QUESTIONNAIRE_RESPONSES = "grc-questionnaire-responses"
TABLE_RECOMMENDATIONS = "grc-questionnaire-recommendations"

GAP_KINDS = {"already_covered", "evidence_gap", "control_gap", "policy_gap", "low_confidence", "needs_review"}
WHO_ACTS = {"msp_action", "customer_action", "vendor_purchase", "customer_decides", "already_covered"}
SEVERITIES = {"low", "medium", "high", "critical"}

GRC_REC_MODEL_CONFIG_KEY = "GRC_RECOMMENDATION_MODEL"
LOW_CONFIDENCE_THRESHOLD = 0.6

logger = logging.getLogger(__name__)


CLASSIFY_SYSTEM_PROMPT = """You classify Bifrost GRC questionnaire answers into actionable recommendations for an MSP and its customers.

For each item, output a recommendation card. Use these enum values exactly:

gap_kind: already_covered | evidence_gap | control_gap | policy_gap | low_confidence | needs_review
  - already_covered: a control/policy demonstrably covers this; cite it. Severity = low.
  - evidence_gap: the answer is plausible but no evidence is on file. We need to document what exists.
  - control_gap: no control is in place. Something needs to be deployed or purchased.
  - policy_gap: a policy document is missing.
  - low_confidence: the draft is uncertain and a human needs to verify.
  - needs_review: explicitly flagged needs_review=true by the drafter.

who_acts: msp_action | customer_action | vendor_purchase | customer_decides | already_covered
  - msp_action: the service provider should do this (add to its documented baseline, write a customer template, document existing evidence).
  - customer_action: the customer org's own staff needs to do this (write their own policy, change their config).
  - vendor_purchase: a product/service needs to be purchased (and by whom — MSP or customer — clarify in body).
  - customer_decides: requires a customer decision the MSP can't make alone.
  - already_covered: no action needed.

severity: low | medium | high | critical (use medium as the default)

Anchor your classification on CIS Critical Security Controls IG1 — the appropriate baseline for small MSPs serving small customers. Don't recommend enterprise controls.

Be specific in the body. Keep language professional and suitable for customer review. Never claim a control exists unless it's in the provided context.
"""

CLASSIFY_USER_SCHEMA = """Return this exact JSON shape (one recommendation per item):
{
  "recommendations": [
    {
      "item_id": "...",
      "response_id": "...",
      "gap_kind": "...",
      "who_acts": "...",
      "severity": "low|medium|high|critical",
      "title": "Short headline (max 100 chars)",
      "body": "1-3 sentences explaining what is needed and why.",
      "cited_target_ids": ["applied_control_id_1", "..."]
    }
  ]
}
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _docs(result: Any) -> list[dict]:
    docs = getattr(result, "documents", None) or []
    out: list[dict] = []
    for d in docs:
        data = getattr(d, "data", None)
        if data is None and isinstance(d, dict):
            data = d.get("data", d)
        if isinstance(data, dict):
            row = dict(data)
            row["id"] = getattr(d, "id", None) or (d.get("id") if isinstance(d, dict) else row.get("id"))
            out.append(row)
    return out


def _content_hash(item_id: str | None, gap_kind: str, title: str) -> str:
    payload = f"{item_id or ''}|{gap_kind}|{title}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


async def _resolve_openrouter() -> tuple[str, str]:
    integ = await integrations.get("OpenRouter", scope="global") or await integrations.get("OpenRouter")
    if not integ or not integ.config:
        raise UserError("OpenRouter integration not configured")
    api_key = integ.config.get("api_key")
    if not api_key:
        raise UserError("OpenRouter integration is missing api_key")
    model = await config.get(GRC_REC_MODEL_CONFIG_KEY) or integ.config.get("default_model")
    if not model:
        raise UserError("OpenRouter integration is missing default_model")
    return api_key, model


async def _classify_with_ai(items_payload: list[dict]) -> list[dict]:
    try:
        from openrouter import OpenRouter
    except ModuleNotFoundError as exc:
        raise UserError("Gap classifier requires the openrouter workflow dependency.") from exc

    api_key, model = await _resolve_openrouter()
    user_prompt = (
        f"{CLASSIFY_USER_SCHEMA}\n\nItems to classify (each has the questionnaire question, the draft answer, "
        f"confidence, needs_review flag, and the cited link targets from the draft):\n"
        f"{json.dumps(items_payload, ensure_ascii=False)}"
    )
    async with OpenRouter(api_key=api_key) as client:
        resp = await client.chat.send_async(
            model=model,
            messages=[
                {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=6000,
        )
    raw = resp.choices[0].message.content or "{}"
    # Be permissive — strip code fences if present
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        parsed = json.loads(cleaned)
    except Exception as exc:
        raise UserError(f"classifier returned non-JSON: {exc}; raw[:200]={cleaned[:200]!r}") from exc
    recs = parsed.get("recommendations")
    return recs if isinstance(recs, list) else []


@workflow(
    name="classify_grc_questionnaire_gaps",
    description="Generate Bifrost GRC questionnaire recommendations (gaps + who-acts classification) from drafted answers.",
    category="grc",
)
async def classify_grc_questionnaire_gaps(
    questionnaire_id: str,
    replace_open: bool = True,
) -> dict:
    """Run after draft_grc_questionnaire_answers. Idempotent on content_hash.

    Args:
      questionnaire_id: questionnaire to classify
      replace_open: if true (default), open recommendations not regenerated this run are
        marked dismissed (the gap no longer applies). done/dismissed rows are never touched.
    """
    q = await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id)
    if q is None:
        raise UserError(f"questionnaire {questionnaire_id} not found")
    q_data = getattr(q, "data", None) or (q.get("data") if isinstance(q, dict) else None) or {}
    org_id = bind_organization_scope(
        require_row_access(q_data, resource="questionnaire"),
        resource="questionnaire",
    )

    items_result = await tables.query(
        TABLE_QUESTIONNAIRE_ITEMS,
        where={"questionnaire_id": questionnaire_id, "organization_id": org_id},
        limit=1000,
    )
    items = _docs(items_result)
    if not items:
        return {"questionnaire_id": questionnaire_id, "status": "no_items", "created": 0, "reused": 0, "dismissed": 0}

    responses_result = await tables.query(
        TABLE_QUESTIONNAIRE_RESPONSES,
        where={"questionnaire_id": questionnaire_id, "organization_id": org_id},
        limit=1000,
    )
    responses = _docs(responses_result)
    response_by_item: dict[str, dict] = {r.get("item_id"): r for r in responses if r.get("item_id")}

    items_payload: list[dict] = []
    for item in items:
        item_id = item.get("id")
        if not item_id:
            continue
        resp = response_by_item.get(item_id) or {}
        citations = []
        try:
            citations = json.loads(resp.get("citations_json") or "[]")
        except Exception:
            citations = []
        items_payload.append({
            "item_id": item_id,
            "response_id": resp.get("id"),
            "question_text": item.get("question_text"),
            "answer_type": item.get("answer_type"),
            "draft_answer": resp.get("draft_answer"),
            "confidence": resp.get("confidence"),
            "needs_review": resp.get("status") == "needs_review",
            "citations": citations,
        })

    raw_recs = await _classify_with_ai(items_payload)

    # Fetch existing recs for this questionnaire so we can dedupe by content_hash.
    existing_result = await tables.query(
        TABLE_RECOMMENDATIONS,
        where={"questionnaire_id": questionnaire_id, "organization_id": org_id},
        limit=1000,
    )
    existing = _docs(existing_result)
    existing_by_hash: dict[str, dict] = {r.get("content_hash"): r for r in existing if r.get("content_hash")}

    created = 0
    reused = 0
    dismissed = 0
    touched_hashes: set[str] = set()

    for rec in raw_recs:
        gap_kind = rec.get("gap_kind")
        who_acts = rec.get("who_acts")
        title = (rec.get("title") or "").strip()[:160]
        body = (rec.get("body") or "").strip()
        severity = rec.get("severity") or "medium"

        if gap_kind not in GAP_KINDS or who_acts not in WHO_ACTS or not title or not body:
            continue
        if severity not in SEVERITIES:
            severity = "medium"

        item_id = rec.get("item_id")
        response_id = rec.get("response_id")
        content_hash = _content_hash(item_id, gap_kind, title)
        touched_hashes.add(content_hash)

        payload = {
            "organization_id": org_id,
            "questionnaire_id": questionnaire_id,
            "item_id": item_id,
            "response_id": response_id,
            "gap_kind": gap_kind,
            "who_acts": who_acts,
            "severity": severity,
            "title": title,
            "body": body,
            "content_hash": content_hash,
            "metadata_json": json.dumps({"cited_target_ids": rec.get("cited_target_ids") or []}),
        }

        prior = existing_by_hash.get(content_hash)
        if prior:
            # Existing — only re-set body/severity/title if it's still open.
            if prior.get("status") == "open":
                await tables.update(TABLE_RECOMMENDATIONS, prior.get("id"), {
                    "body": body,
                    "severity": severity,
                    "title": title,
                    "metadata_json": payload["metadata_json"],
                })
            reused += 1
        else:
            payload["status"] = "open"
            await tables.insert(TABLE_RECOMMENDATIONS, payload)
            created += 1

    if replace_open:
        for rec in existing:
            if rec.get("status") == "open" and rec.get("content_hash") not in touched_hashes:
                await tables.update(TABLE_RECOMMENDATIONS, rec.get("id"), {
                    "status": "dismissed",
                    "completion_notes": "Auto-dismissed: classifier re-run no longer surfaces this gap.",
                    "completed_at": _now(),
                })
                dismissed += 1

    return {
        "questionnaire_id": questionnaire_id,
        "organization_id": org_id,
        "status": "ok",
        "created": created,
        "reused": reused,
        "dismissed": dismissed,
        "total_items": len(items_payload),
    }


@workflow(
    name="mark_grc_recommendation_done",
    description="Mark a Bifrost GRC questionnaire recommendation as done (with optional notes).",
    category="grc",
)
async def mark_grc_recommendation_done(recommendation_id: str, completion_notes: str | None = None, status: str = "done") -> dict:
    if status not in {"open", "done", "dismissed"}:
        raise UserError(f"invalid status: {status}")
    payload = {"status": status}
    if completion_notes:
        payload["completion_notes"] = completion_notes
    recommendation = await tables.get(TABLE_RECOMMENDATIONS, recommendation_id)
    recommendation_data = (
        getattr(recommendation, "data", None)
        or (recommendation.get("data") if isinstance(recommendation, dict) else None)
        or {}
    )
    bind_organization_scope(
        require_row_access(recommendation_data, resource="questionnaire recommendation"),
        resource="questionnaire recommendation",
    )
    payload = attributed_payload(TABLE_RECOMMENDATIONS, payload, recommendation_data)
    await tables.update(TABLE_RECOMMENDATIONS, recommendation_id, payload)
    return {"id": recommendation_id, "status": status}


@workflow(
    name="list_grc_questionnaire_recommendations",
    description="List recommendations for a Bifrost GRC questionnaire (defaults to open only).",
    category="grc",
)
async def list_grc_questionnaire_recommendations(questionnaire_id: str, include_completed: bool = False) -> dict:
    questionnaire = await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id)
    questionnaire_data = (
        getattr(questionnaire, "data", None)
        or (questionnaire.get("data") if isinstance(questionnaire, dict) else None)
        or {}
    )
    org_id = bind_organization_scope(
        require_row_access(questionnaire_data, resource="questionnaire"),
        resource="questionnaire",
    )
    result = await tables.query(
        TABLE_RECOMMENDATIONS,
        where={"questionnaire_id": questionnaire_id, "organization_id": org_id},
        limit=1000,
    )
    rows = _docs(result)
    if not include_completed:
        rows = [r for r in rows if r.get("status") == "open"]
    # Sort: open first, then by severity desc, then by gap_kind
    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    who_order = {"msp_action": 0, "vendor_purchase": 1, "customer_action": 2, "customer_decides": 3, "already_covered": 4}
    rows.sort(key=lambda r: (
        0 if r.get("status") == "open" else 1,
        sev_order.get(r.get("severity"), 5),
        who_order.get(r.get("who_acts"), 5),
    ))
    return {"questionnaire_id": questionnaire_id, "count": len(rows), "recommendations": rows}
