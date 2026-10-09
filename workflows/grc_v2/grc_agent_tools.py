"""MCP-friendly Bifrost GRC agent tools.

These workflows intentionally wrap lower-level GRC workflows with discoverable
`bifrost_grc_*` names and conservative safety defaults for agent use.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from bifrost import UserError, context, tables, workflow

from functions.grc_attribution import EDITABLE_FIELDS, PROTECTED_FIELDS, authenticated_actor_id, attributed_payload
from functions.grc_auth import bind_organization_scope, caller_organization_id, is_platform_scope, require_provider
from functions.grc_scope import applies_to_organization, resolve_effective_facts


FACT_MARKER_RE = re.compile(r"\{\{fact:((?:[a-z0-9_.-]|\\[_.-])+)(?:\|([^}]+))?\}\}", flags=re.I)


def _fact_marker_key(raw_key: str) -> str:
    return re.sub(r"\\([_.-])", r"\1", raw_key)


def _fact_marker_keys(content: str | None) -> list[str]:
    return sorted({_fact_marker_key(match.group(1)) for match in FACT_MARKER_RE.finditer(content or "")})


TABLE_FRAMEWORKS = "grc-frameworks"
TABLE_DOMAINS = "grc-domains"
TABLE_CONTROLS = "grc-controls"
TABLE_ASSESSMENTS = "grc-assessments"
TABLE_ASSESSMENT_CONTROLS = "grc-assessment-controls"
TABLE_APPLIED_CONTROLS = "grc-applied-controls"
TABLE_CONTROL_MAPPINGS = "grc-control-mappings"
TABLE_FINDINGS = "grc-findings"
TABLE_EVIDENCE = "grc-evidence"
TABLE_EVIDENCE_LINKS = "grc-evidence-links"
TABLE_POLICIES = "grc-policies"
TABLE_POLICY_CAMPAIGNS = "grc-policy-campaigns"
TABLE_POLICY_CAMPAIGN_ASSIGNMENTS = "grc-policy-campaign-assignments"
TABLE_POLICY_ACCEPTANCES = "grc-policy-acceptances"
TABLE_POLICY_TEMPLATES = "grc-policy-templates"
TABLE_POLICY_LINKS = "grc-policy-links"
TABLE_EXCEPTIONS = "grc-exceptions"
TABLE_EXCEPTION_LINKS = "grc-exception-links"
TABLE_RISKS = "grc-risks"
TABLE_RISK_LINKS = "grc-risk-links"
TABLE_CHANGE_HISTORY = "grc-change-history"
TABLE_QUESTIONNAIRES = "grc-questionnaires"
TABLE_QUESTIONNAIRE_RECOMMENDATIONS = "grc-questionnaire-recommendations"
TABLE_SOURCE_DOCUMENTS = "grc-source-documents"
TABLE_IMPORT_MAPPINGS = "grc-import-mappings"
TABLE_FACT_DEFINITIONS = "grc-fact-definitions"
TABLE_FACTS = "grc-facts"
TABLE_FACT_REQUIREMENTS = "grc-fact-requirements"
TABLE_POLICY_FACT_SNAPSHOTS = "grc-policy-fact-snapshots"

APP_GRC_TABLES = {
    "grc-assessment-controls", "grc-assessments", "grc-controls", "grc-domains",
    "grc-change-history", "grc-evidence", "grc-exceptions", "grc-findings", "grc-frameworks", "grc-policies", "grc-policy-templates",
    "grc-policy-campaigns", "grc-policy-campaign-assignments", "grc-policy-acceptances",
    "grc-policy-controls", "grc-risk-controls", "grc-risks", "grc-service-plan-controls",
    "grc-service-plan-organizations", "grc-service-plans", "grc-applied-control-history",
    "grc-applied-controls", "grc-assessment-control-overrides", "grc-ciso-org-mappings",
    "grc-control-crosswalks", "grc-control-mappings", "grc-evidence-links",
    "grc-exception-links", "grc-import-mappings", "grc-policy-links",
    "grc-questionnaire-control-links", "grc-questionnaire-items",
    "grc-questionnaire-proposals", "grc-questionnaire-recommendations",
    "grc-questionnaire-responses", "grc-questionnaire-runs",
    "grc-questionnaire-sections", "grc-questionnaires", "grc-risk-links",
    "grc-source-documents", "grc-user-org-access",
    "grc-fact-definitions", "grc-facts", "grc-fact-requirements", "grc-policy-fact-snapshots",
}


TARGET_TABLES = {
    "applied_control": TABLE_APPLIED_CONTROLS,
    "control": TABLE_CONTROLS,
    "assessment": TABLE_ASSESSMENTS,
    "assessment_control": TABLE_ASSESSMENT_CONTROLS,
    "evidence": TABLE_EVIDENCE,
    "policy": TABLE_POLICIES,
    "exception": TABLE_EXCEPTIONS,
    "risk": TABLE_RISKS,
    "source_document": TABLE_SOURCE_DOCUMENTS,
}

REFERENCE_TARGET_TYPES = {"control"}
SINGLE_CUSTOMER_TARGET_TYPES = {"questionnaire", "source_document"}

EVIDENCE_TYPES = {"document", "url", "screenshot", "note"}
EXCEPTION_STATUSES = {"pending", "approved", "denied", "expired"}
MAPPING_RELATIONSHIPS = {"satisfies", "partially_satisfies", "supports", "conflicts", "informational"}
MAPPING_STATUSES = {"suggested", "accepted", "rejected", "imported", "applied"}
APPLIED_CONTROL_STATUSES = {"active", "planned", "partial", "retired", "unknown"}
APPLIED_CONTROL_MATURITIES = {"informal", "documented", "implemented", "measured", "optimized", "unknown"}
REVIEW_STATUSES = {"draft", "needs_review", "approved", "rejected"}
FILL_MAPPING_STATUSES = {"accepted", "imported", "applied"}
ASSESSMENT_FILL_STATUSES = {"compliant", "partially_compliant", "non_compliant", "not_assessed"}
POLICY_TYPES = {"policy", "ai_acceptable_use", "incident_response_plan", "system_security_plan", "procedure"}
POLICY_ROLES = {"standalone", "base", "extension"}
POLICY_EXTENSION_MODES = {"supplement", "deviation"}
POLICY_STATUSES = {"draft", "active", "archived"}
FACT_STATUSES = {"unanswered", "proposed", "needs_verification", "verified", "stale", "not_applicable", "accepted_unknown"}
OPEN_ITEM_PERSPECTIVES = {
    "all",
    "priority",
    "missing_information",
    "findings_issues",
    "risks_concerns",
    "needs_review",
    "expiring",
    "completed",
}
OPEN_ITEM_KINDS = {
    "missing_information",
    "assessment_finding",
    "questionnaire_finding",
    "manual_finding",
    "risk",
    "policy_review",
    "evidence_review",
    "applied_control_review",
    "exception",
    "assessment_needs_review",
}
OPEN_FACT_STATUSES = {"unanswered", "proposed", "needs_verification", "stale"}
OPEN_RISK_STATUSES = {"open", "active", "mitigating", "needs_mitigation", "pending"}
OPEN_REVIEW_STATUSES = {"needs_review", "draft", "rejected"}
OPEN_FINDING_STATUSES = {"open", "draft", "needs_review", "proposed"}
EXCEPTION_EXPIRY_DAYS = 30
APPLIED_CONTROL_REVIEW_DUE_AFTER_DAYS = 365

STANDARD_FACTS = [
    ("organization.legal_name", "Legal organization name", "short_text", "customer", "Organization", "Confirm the legal name used in contracts and governed documents."),
    ("security.accountable_owner", "Security accountable owner", "contact", "customer", "Governance", "Person accountable for accepting security risk and approving the plan."),
    ("incident.primary_contact", "Primary incident contact", "contact", "customer", "Incident response", "First customer contact the service provider should notify during a security incident."),
    ("incident.alternate_contact", "Alternate incident contact", "contact", "customer", "Incident response", "Backup customer contact when the primary contact is unavailable."),
    ("incident.reporting_channel", "Incident reporting channel", "short_text", "shared", "Incident response", "Channel employees and responders use to report a suspected incident."),
    ("incident.cyber_insurer", "Cyber insurance contact", "contact", "customer", "Incident response", "Current carrier or broker, policy reference, and 24/7 breach hotline."),
    ("incident.privacy_legal_contact", "Privacy or legal contact", "contact", "customer", "Incident response", "Person or firm responsible for privacy and legal notification decisions."),
    ("system.name", "Covered system name", "short_text", "customer", "System boundary", "Name used for the environment covered by this plan."),
    ("system.boundary", "System boundary", "long_text", "shared", "System boundary", "Systems, identities, data, locations, and exclusions covered by the plan."),
    ("system.data_types", "Sensitive data types", "list", "customer", "Data", "Categories of confidential, regulated, financial, employee, donor, or participant data."),
    ("system.data_retention", "Data retention and disposal", "long_text", "customer", "Data", "How long important data is kept and how electronic and physical records are disposed of."),
    ("system.critical_services", "Critical systems and services", "list", "shared", "System boundary", "Technology and business services whose loss would materially interrupt operations."),
    ("system.locations", "Operating and data locations", "list", "customer", "System boundary", "Offices, remote-work locations, physical records, cloud regions, and other places covered data resides."),
    ("identity.primary_platform", "Identity platform", "system_reference", "msp", "Technology", "Primary directory and authentication platform for workforce access."),
    ("endpoint.management", "Endpoint management coverage", "system_reference", "msp", "Technology", "Devices covered by management tooling and any known exclusions."),
    ("backup.recovery", "Backup and recovery arrangement", "long_text", "shared", "Resilience", "What is backed up, where recovery copies are kept, and how restoration is tested."),
    ("vendor.critical", "Critical service providers", "list", "shared", "Vendors", "Providers that host sensitive data or deliver services essential to operations."),
    ("recovery.priority", "Recovery priorities", "long_text", "customer", "Resilience", "Business-approved recovery order, objectives, owners, escalation paths, and workarounds."),
]
STANDARD_REQUIREMENTS = {
    "template:incident-response-addendum": ["organization.legal_name", "incident.primary_contact", "incident.alternate_contact", "incident.reporting_channel", "incident.cyber_insurer", "incident.privacy_legal_contact"],
    "template:system-security-plan-addendum": ["organization.legal_name", "security.accountable_owner", "system.name", "system.boundary", "system.data_types", "system.data_retention", "system.critical_services", "system.locations", "identity.primary_platform", "endpoint.management", "backup.recovery", "vendor.critical", "recovery.priority"],
}
LEGACY_STANDARD_REQUIREMENT_SOURCES = {
    "template:incident-response-addendum": "outline:incident-response",
    "template:system-security-plan-addendum": "baseline:system-security-plan-v1",
}
DIRECT_SCOPED_TABLES = (
    TABLE_ASSESSMENTS,
    TABLE_APPLIED_CONTROLS,
    TABLE_CONTROL_MAPPINGS,
    TABLE_EVIDENCE,
    TABLE_EVIDENCE_LINKS,
    TABLE_POLICIES,
    TABLE_POLICY_CAMPAIGNS,
    TABLE_POLICY_CAMPAIGN_ASSIGNMENTS,
    TABLE_POLICY_TEMPLATES,
    TABLE_POLICY_LINKS,
    TABLE_EXCEPTIONS,
    TABLE_EXCEPTION_LINKS,
    TABLE_RISKS,
    TABLE_RISK_LINKS,
)


def _doc_to_row(doc: Any) -> dict[str, Any]:
    if doc is None:
        return {}
    if isinstance(doc, dict):
        if isinstance(doc.get("data"), dict):
            return {
                "id": str(doc.get("id", doc["data"].get("id", ""))),
                "created_at": doc.get("created_at"),
                "updated_at": doc.get("updated_at"),
                **doc["data"],
            }
        return dict(doc)
    data = dict(getattr(doc, "data", None) or {})
    data["id"] = str(getattr(doc, "id", data.get("id", "")))
    data["created_at"] = getattr(doc, "created_at", data.get("created_at"))
    data["updated_at"] = getattr(doc, "updated_at", data.get("updated_at"))
    return data


async def _query_rows(table: str, where: dict[str, Any] | None = None, limit: int = 1000) -> list[dict[str, Any]]:
    result = await tables.query(table, where=where or {}, limit=limit)
    return [_doc_to_row(doc) for doc in getattr(result, "documents", [])]


async def _query_all_rows(
    table: str, where: dict[str, Any] | None = None, *, page_size: int = 1000, max_rows: int = 10000,
) -> list[dict[str, Any]]:
    """Read bounded pages without exceeding the table API's 1,000-row limit."""
    rows: list[dict[str, Any]] = []
    offset = 0
    while len(rows) < max_rows:
        result = await tables.query(table, where=where or {}, limit=page_size, offset=offset)
        page = [_doc_to_row(doc) for doc in getattr(result, "documents", [])]
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += len(page)
    if len(rows) >= max_rows:
        raise UserError(f"{table} exceeded the safe {max_rows}-row agent read limit; narrow the query.")
    return rows


async def _get_row(table: str, row_id: str | None) -> dict[str, Any] | None:
    if not row_id:
        return None
    try:
        row = _doc_to_row(await tables.get(table, row_id))
    except Exception:  # noqa: BLE001 - agent context should tolerate stale links.
        return None
    return row or None


async def _safe_count(table: str, where: dict[str, Any] | None = None) -> int:
    try:
        return int(await tables.count(table, where=where or {}))
    except Exception:  # noqa: BLE001 - keep posture summaries resilient.
        return 0


def _fact_value_text(value_json: Any) -> str:
    value = _json_loads(value_json, value_json)
    if value in (None, ""):
        return "Not answered"
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    if isinstance(value, dict):
        parts = [value.get(field) for field in ("name", "role", "email", "phone")]
        return " · ".join(str(item) for item in parts if item) or _stable_json(value)
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return str(value)


def _policy_fact_requirements(
    policies: list[dict[str, Any]],
    organization_id: str,
    definitions: dict[str, dict[str, Any]],
    stored_requirements: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Activate fact requirements only when an actual applicable policy references them."""
    metadata = {
        str(requirement.get("fact_key")): requirement
        for requirement in stored_requirements
        if requirement.get("target_type") == "policy_template" and requirement.get("fact_key")
    }
    activated: list[dict[str, Any]] = []
    for policy in policies:
        if policy.get("status") == "archived" or not applies_to_organization(policy, organization_id):
            continue
        keys = _fact_marker_keys(str(policy.get("content") or ""))
        for key in keys:
            definition = definitions.get(key, {})
            template = metadata.get(key, {})
            policy_id = str(policy.get("id") or "")
            activated.append({
                "id": f"policy:{policy_id}:{key}",
                "organization_id": organization_id,
                "fact_definition_id": definition.get("id") or template.get("fact_definition_id") or f"fact:{key}",
                "fact_key": key,
                "target_type": "policy",
                "target_id": policy_id,
                "target_source_id": policy.get("source_id"),
                "context": f"{'Needed to publish' if policy.get('status') == 'draft' else 'Required by'} {policy.get('name') or 'policy'}",
                "required": True,
                "priority": template.get("priority") or "high",
                "responsible_party": template.get("responsible_party") or definition.get("expected_from") or "shared",
                "status": "active",
            })
    return activated


async def _resolved_facts(
    organization_id: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    definitions = await _query_rows(TABLE_FACT_DEFINITIONS, {}, limit=1000)
    facts = await _query_all_rows(TABLE_FACTS, {})
    resolved, conflicts = resolve_effective_facts(facts, organization_id)
    return (
        {str(row.get("key")): row for row in definitions if row.get("key")},
        resolved,
        conflicts,
    )


def _resolve_fact_markers(content: str, definitions: dict[str, dict[str, Any]], facts: dict[str, dict[str, Any]]) -> tuple[str, list[str]]:
    unresolved: list[str] = []
    def replace(match: re.Match[str]) -> str:
        key = _fact_marker_key(match.group(1))
        fallback = (match.group(2) or "").strip()
        fact = facts.get(key)
        value = _fact_value_text(fact.get("value_json")) if fact else "Not answered"
        if not fact or value == "Not answered":
            unresolved.append(key)
            return fallback or str(definitions.get(key, {}).get("title") or f"Open item: {key}")
        return value
    return FACT_MARKER_RE.sub(replace, content or ""), sorted(set(unresolved))


def _tokens(*values: Any) -> set[str]:
    text = " ".join(str(value or "") for value in values)
    return {part for part in re.split(r"[^a-z0-9]+", text.lower()) if len(part) >= 3}


def _json_loads(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return default


def _tag_text(value: Any) -> str:
    tags = _json_loads(value, [])
    if not isinstance(tags, list):
        return str(tags or "")
    parts: list[str] = []
    for tag in tags:
        if isinstance(tag, dict):
            parts.extend(str(item or "") for item in tag.values())
        else:
            parts.append(str(tag or ""))
    return " ".join(parts)


def _summarize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    summary = plan.get("summary")
    if isinstance(summary, dict):
        return summary
    sections = plan.get("sections")
    if not isinstance(sections, dict):
        return {}
    output: dict[str, dict[str, int]] = {}
    for section, rows in sections.items():
        if not isinstance(rows, list):
            continue
        bucket = {"create": 0, "update": 0, "skip": 0, "conflict": 0, "error": 0}
        for row in rows:
            action = row.get("action") if isinstance(row, dict) else None
            if action in bucket:
                bucket[action] += 1
        output[section] = bucket
    return output


def _stable_json(value: Any) -> str:
    return json.dumps(value or {}, sort_keys=True, separators=(",", ":"), default=str)


def _clean_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _require_confirm(apply: bool, confirm_apply: bool, action: str) -> None:
    if apply and not confirm_apply:
        raise UserError(f"confirm_apply=true is required before {action}.")


def _assessment_fill_status(applied_control: dict[str, Any], mapping: dict[str, Any]) -> tuple[str, int, str]:
    applied_status = str(applied_control.get("status") or "unknown")
    relationship = str(mapping.get("relationship") or "supports")
    if relationship == "conflicts":
        return "non_compliant", 0, "mapping relationship is conflicts"
    if applied_status == "active" and relationship == "satisfies":
        return "compliant", 100, "active applied control satisfies the reference control"
    if applied_status in {"active", "partial"} and relationship in {"partially_satisfies", "supports"}:
        return "partially_compliant", 50, f"{applied_status} applied control {relationship.replace('_', ' ')} the reference control"
    if applied_status == "active":
        return "partially_compliant", 50, "active applied control has a non-satisfies mapping"
    return "not_assessed", 0, f"applied control status is {applied_status}"


def _mapping_rank(mapping: dict[str, Any], applied_control: dict[str, Any]) -> tuple[int, float]:
    status_score = {
        "applied": 4,
        "accepted": 3,
        "imported": 2,
        "suggested": 1,
    }.get(str(mapping.get("status") or ""), 0)
    relationship_score = {
        "satisfies": 5,
        "partially_satisfies": 4,
        "supports": 3,
        "informational": 1,
        "conflicts": 0,
    }.get(str(mapping.get("relationship") or ""), 0)
    applied_score = {
        "active": 4,
        "partial": 3,
        "planned": 2,
        "unknown": 1,
        "retired": 0,
    }.get(str(applied_control.get("status") or "unknown"), 0)
    try:
        confidence = float(mapping.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    return (status_score * 100 + relationship_score * 10 + applied_score, confidence)


async def _validate_target(organization_id: str, target_type: str, target_id: str) -> dict[str, Any]:
    table = TARGET_TABLES.get(target_type)
    if not table:
        raise UserError(f"Unsupported target_type: {target_type}")
    row = await _get_row(table, target_id)
    if not row:
        raise UserError(f"Target not found: {target_type}:{target_id}")
    if target_type in SINGLE_CUSTOMER_TARGET_TYPES:
        if row.get("organization_id") != organization_id:
            raise UserError(f"Target {target_type}:{target_id} belongs to a different customer.")
    elif target_type not in REFERENCE_TARGET_TYPES and not applies_to_organization(row, organization_id):
        raise UserError(f"Target {target_type}:{target_id} does not apply to this customer.")
    return row


async def _find_existing_link(
    table: str,
    organization_id: str,
    link_id_key: str,
    link_id: str,
    target_type: str,
    target_id: str,
) -> dict[str, Any] | None:
    rows = await _query_rows(
        table,
        {
            link_id_key: link_id,
            "target_type": target_type,
            "target_id": target_id,
        },
        limit=10,
    )
    return next((row for row in rows if applies_to_organization(row, organization_id)), None)


def _provider_owner_id() -> str:
    require_provider("Provider access is required for shared GRC records.")
    owner_id = caller_organization_id()
    if not owner_id:
        raise UserError("The provider organization could not be resolved.")
    return owner_id


def _customer_scope(organization_id: str) -> dict[str, Any]:
    return {"applied_organizations": [organization_id], "excluded_organizations": []}


def _effective_policy_content(base: dict[str, Any], extension: dict[str, Any]) -> str:
    base_content = str(base.get("content") or "").strip()
    extension_content = str(extension.get("content") or "").strip()
    extension_content = re.sub(r"^\s*#\s+[^\n]+\n+", "", extension_content)
    parts = [
        base_content,
        "---",
        "## Customer addendum",
        extension_content,
    ]
    return "\n\n".join(part for part in parts if part)


def _normalized_scope_owner(row: dict[str, Any], provider_organization_id: str) -> tuple[str | None, str]:
    if row.get("organization_id") != provider_organization_id:
        return row.get("organization_id"), "already_normalized"
    applied = row.get("applied_organizations")
    excluded = row.get("excluded_organizations") or []
    if applied is None and not excluded:
        return None, "global"
    if isinstance(applied, list) and len(applied) == 1 and not excluded:
        target = str(applied[0])
        if target == provider_organization_id:
            return provider_organization_id, "already_normalized"
        return target, "single_customer"
    return provider_organization_id, "ambiguous_scope"


def _requested_scope(primary_organization_id: str, additional: list[str] | None, apply_to_all: bool) -> dict[str, Any]:
    if apply_to_all:
        return {"applied_organizations": None, "excluded_organizations": []}
    selected = sorted({primary_organization_id, *(additional or [])})
    if len(selected) != 1:
        raise UserError("GRC records must be global or scoped to exactly one customer.")
    return {"applied_organizations": selected, "excluded_organizations": []}


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _context_actor() -> tuple[str | None, str | None]:
    actor = getattr(context, "user", None)
    candidate_id = None
    candidate_label = None
    for source in (
        getattr(context, "user_id", None),
        getattr(context, "actor_id", None),
        getattr(actor, "id", None),
        getattr(actor, "user_id", None),
        getattr(actor, "email", None),
    ):
        if source:
            candidate_id = str(source)
            break
    for source in (
        getattr(context, "user_name", None),
        getattr(context, "actor_label", None),
        getattr(context, "display_name", None),
        getattr(actor, "name", None),
        getattr(actor, "display_name", None),
        getattr(actor, "email", None),
    ):
        if source:
            candidate_label = str(source)
            break
    return candidate_id, candidate_label


def _diff_fields(before: dict[str, Any] | None, after: dict[str, Any] | None) -> list[str]:
    before_row = before or {}
    after_row = after or {}
    changed = {
        key
        for key in set(before_row) | set(after_row)
        if key not in {"created_at", "updated_at"} and before_row.get(key) != after_row.get(key)
    }
    return sorted(changed)


async def _record_change(
    *,
    entity_type: str,
    entity_id: str | None,
    event_type: str,
    organization_id: str | None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    reason: str | None = None,
    source_system: str | None = None,
    strict: bool = False,
) -> None:
    if not entity_id:
        return
    actor_id, actor_label = _context_actor()
    if strict:
        actor_id = authenticated_actor_id(context)
    payload = {
        "organization_id": organization_id,
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "event_type": event_type,
        "actor_id": actor_id,
        "actor_label": actor_label,
        "event_at": datetime.now(UTC).isoformat(),
        "summary": f"{event_type} {entity_type}:{entity_id}",
        "changed_fields_json": _json_dumps(_diff_fields(before, after)),
        "before_json": _json_dumps(before or {}),
        "after_json": _json_dumps(after or {}),
        "reason": reason,
        "source_system": source_system,
    }
    try:
        await tables.insert(TABLE_CHANGE_HISTORY, payload)
    except Exception as exc:  # Legacy callers keep their existing best-effort behavior.
        if strict:
            raise UserError("The record changed, but its audit entry could not be recorded.") from exc
        return


def _detail_href(table: str, row_id: str | None, metadata: dict[str, Any] | None = None) -> str | None:
    if not row_id:
        return None
    metadata = metadata or {}
    if table == TABLE_POLICIES:
        return f"/policies/{row_id}"
    if table == TABLE_RISKS:
        return f"/risks/{row_id}"
    if table == TABLE_EVIDENCE:
        return f"/evidence/{row_id}"
    if table == TABLE_ASSESSMENT_CONTROLS:
        assessment_id = metadata.get("assessment_id")
        return f"/assessments/{assessment_id}" if assessment_id else "/assessments"
    if table == TABLE_ASSESSMENTS:
        return f"/assessments/{row_id}"
    if table == TABLE_APPLIED_CONTROLS:
        return f"/applied-controls/{row_id}"
    if table == TABLE_EXCEPTIONS:
        return f"/exceptions/{row_id}"
    if table == TABLE_QUESTIONNAIRE_RECOMMENDATIONS:
        questionnaire_id = metadata.get("questionnaire_id")
        return f"/questionnaires/{questionnaire_id}" if questionnaire_id else "/questionnaires"
    if table == TABLE_FINDINGS:
        organization_id = metadata.get("organization_id") or ""
        return f"/open-items?perspective=findings_issues&item=findings_issues:manual_finding:{organization_id}:{row_id}"
    if table in {TABLE_FACTS, TABLE_FACT_REQUIREMENTS}:
        fact_key = metadata.get("fact_key")
        organization_id = metadata.get("organization_id")
        if fact_key:
            suffix = f"?fact={fact_key}"
            if organization_id:
                suffix = f"?organization={organization_id}&fact={fact_key}"
            return f"/open-items{suffix}"
        return "/open-items"
    return f"/open-items"


def _open_item_action(
    label: str,
    table: str | None = None,
    row_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "label": label,
        "type": "open_source",
        "table": table,
        "id": row_id,
        "href": _detail_href(table or "", row_id, metadata),
    }


def _open_item(
    *,
    organization_id: str,
    perspective: str,
    kind: str,
    title: str,
    why_open: str,
    source_table: str,
    source_id: str | None,
    priority: int = 50,
    due_at: str | None = None,
    summary: str | None = None,
    status: str | None = None,
    source_system: str | None = None,
    source_url: str | None = None,
    action_label: str | None = None,
    action_table: str | None = None,
    action_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = {**(metadata or {}), "organization_id": organization_id}
    detail_href = _detail_href(source_table, source_id, metadata)
    item_id = f"{perspective}:{kind}:{organization_id}:{source_id or title}"
    item = {
        "id": item_id,
        "organization_id": organization_id,
        "perspective": perspective,
        "perspectives": [perspective, "priority"] if priority <= 20 and perspective != "priority" else [perspective],
        "kind": kind,
        "title": title,
        "summary": summary or title,
        "why_open": why_open,
        "priority": priority,
        "due_at": due_at,
        "status": status,
        "source_table": source_table,
        "source_id": source_id,
        "source_href": detail_href,
        "detail_href": detail_href,
        "source_system": source_system,
        "source_url": source_url,
        "action": _open_item_action(action_label or "Open source record", action_table or source_table, action_id or source_id, metadata),
        "metadata": metadata,
    }
    quick_resolutions = {
        "manual_finding": ("Mark resolved", "resolved"),
        "questionnaire_finding": ("Mark done", "resolved"),
        "policy_review": ("Confirm reviewed", "reviewed"),
        "evidence_review": ("Confirm reviewed", "reviewed"),
        "applied_control_review": ("Confirm reviewed", "reviewed"),
    }
    if kind in quick_resolutions and source_id:
        quick_label, resolution = quick_resolutions[kind]
        item["action"] = {
            "label": quick_label,
            "kind": "mutate",
            "href": None,
            "payload": {
                "bifrost_organization_id": organization_id or None,
                "item_kind": kind,
                "source_id": source_id,
                "resolution": resolution,
                "apply": True,
                "confirm_apply": True,
            },
        }
    return item


def _parse_date(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed
        except ValueError:
            return None
    return None


def _days_until(value: Any) -> int | None:
    parsed = _parse_date(value)
    if not parsed:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    now = datetime.now(UTC)
    return round((parsed - now).total_seconds() / 86400)


async def _portfolio_customer_organization_ids() -> list[str]:
    from workflows.grc_v2.grc_directory import list_organizations

    response = await list_organizations(include_inactive=False)
    orgs = response.get("organizations") if isinstance(response, dict) else []
    return [
        str(row.get("id"))
        for row in orgs or []
        if row and row.get("id") and not row.get("is_provider")
    ]


def _policy_fact_open_item(
    organization_id: str,
    requirement: dict[str, Any],
    fact: dict[str, Any] | None,
    conflicts: list[dict[str, Any]] | None,
    definition: dict[str, Any] | None,
) -> dict[str, Any] | None:
    status = "needs_verification" if conflicts else str(fact.get("status") if fact else "unanswered")
    if not fact and status not in OPEN_FACT_STATUSES:
        return None
    if fact and status not in OPEN_FACT_STATUSES and status not in {"verified", "not_applicable", "accepted_unknown"}:
        return None
    if not fact and status == "unanswered":
        why_open = "The required fact has not been answered."
    elif conflicts:
        why_open = "The same fact is answered differently across overlapping scopes."
    else:
        why_open = f"Fact status is {status.replace('_', ' ')}."
    if status in {"verified", "not_applicable", "accepted_unknown"}:
        return None
    if not fact and not conflicts and status == "unanswered":
        perspective = "missing_information"
    else:
        perspective = "missing_information"
    source_id = str(requirement.get("id") or requirement.get("fact_key") or "")
    metadata = {
        "fact_key": requirement.get("fact_key"),
        "requirement_id": requirement.get("id"),
        "target_type": requirement.get("target_type"),
        "target_id": requirement.get("target_id"),
        "target_source_id": requirement.get("target_source_id"),
        "fact_id": fact.get("id") if fact else None,
        "conflict_count": len(conflicts or []),
        "status": status,
    }
    item = _open_item(
        organization_id=organization_id,
        perspective=perspective,
        kind="missing_information",
        title=definition.get("title") if definition else str(requirement.get("fact_key") or "Open fact"),
        summary=definition.get("description") if definition else None,
        why_open=why_open,
        source_table=TABLE_FACT_REQUIREMENTS if not fact else TABLE_FACTS,
        source_id=str(fact.get("id") if fact else requirement.get("id") or requirement.get("fact_key") or ""),
        # Ordinary unanswered facts belong in Missing Information, not Priority.
        # Conflicting answers remain priority because they can produce the wrong
        # effective policy text until a reviewer resolves them.
        priority=10 if conflicts else 60,
        due_at=str(requirement.get("due_date") or "") or None,
        status=status,
        source_system=fact.get("source_system") if fact else requirement.get("source_system"),
        source_url=fact.get("source_url") if fact else None,
        action_label="Review fact",
        action_table=TABLE_FACTS if fact else TABLE_FACT_REQUIREMENTS,
        action_id=str(fact.get("id") if fact else requirement.get("id") or ""),
        metadata=metadata,
    )
    item.update({
        "id": f"missing_information:fact:{organization_id}:{requirement.get('fact_key') or source_id}",
        "fact_key": requirement.get("fact_key"),
        "fact_type": definition.get("fact_type") if definition else None,
        "fact_id": fact.get("id") if fact else None,
        "value": _json_loads(fact.get("value_json"), None) if fact else None,
        "can_quick_review": True,
        "action": {"label": "Quick review", "kind": "flashcard", "payload": None, "href": None},
        "usages": [{
            "requirement_id": requirement.get("id"),
            "target_type": requirement.get("target_type"),
            "target_id": requirement.get("target_id"),
            "target_source_id": requirement.get("target_source_id"),
            "context": requirement.get("context"),
        }],
    })
    return item


def _findings_open_items(
    organization_id: str,
    assessments_by_id: dict[str, dict[str, Any]],
    controls_by_id: dict[str, dict[str, Any]],
    assessment_controls: list[dict[str, Any]],
    recommendations: list[dict[str, Any]],
    findings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    by_assessment: dict[str, list[dict[str, Any]]] = {}
    for row in assessment_controls:
        assessment_id = str(row.get("assessment_id") or "")
        if assessment_id:
            by_assessment.setdefault(assessment_id, []).append(row)
    for row in assessment_controls:
        status = str(row.get("status") or "not_assessed")
        if status in {"compliant", "not_assessed"}:
            continue
        assessment = assessments_by_id.get(str(row.get("assessment_id") or ""))
        control = controls_by_id.get(str(row.get("control_id") or ""))
        title = f"{assessment.get('name') if assessment else 'Assessment'} · {control.get('title') if control else row.get('control_id') or 'Control'}"
        why_open = f"Assessment control status is {status.replace('_', ' ')}."
        if row.get("implementation_percentage") not in (None, ""):
            why_open = f"{why_open} Implementation is {row.get('implementation_percentage')}%."
        items.append(_open_item(
            organization_id=organization_id,
            perspective="findings_issues",
            kind="assessment_finding",
            title=title,
            summary=row.get("notes") or why_open,
            why_open=why_open,
            source_table=TABLE_ASSESSMENT_CONTROLS,
            source_id=str(row.get("id") or ""),
            priority=20 if status == "non_compliant" else 40,
            status=status,
            action_label="Review assessment finding",
            action_table=TABLE_ASSESSMENT_CONTROLS,
            action_id=str(row.get("id") or ""),
            metadata={
                "assessment_id": row.get("assessment_id"),
                "control_id": row.get("control_id"),
                "assessment_name": assessment.get("name") if assessment else None,
                "control_title": control.get("title") if control else None,
            },
        ))
    for assessment_id, rows in by_assessment.items():
        assessment = assessments_by_id.get(assessment_id)
        if not assessment or str(assessment.get("status") or "draft") not in {"in_progress", "completed"}:
            continue
        pending = [row for row in rows if str(row.get("status") or "not_assessed") == "not_assessed"]
        if not pending:
            continue
        title = assessment.get("name") or "Assessment review needed"
        items.append(_open_item(
            organization_id=organization_id,
            perspective="needs_review",
            kind="assessment_needs_review",
            title=title,
            summary=f"{len(pending)} control{'s' if len(pending) != 1 else ''} are not assessed yet.",
            why_open=f"{len(pending)} assessment control{'s' if len(pending) != 1 else ''} still need review.",
            source_table=TABLE_ASSESSMENTS,
            source_id=assessment_id,
            priority=55,
            status=assessment.get("status"),
            action_label="Review assessment",
            action_table=TABLE_ASSESSMENTS,
            action_id=assessment_id,
            metadata={
                "assessment_id": assessment_id,
                "pending_control_count": len(pending),
            },
        ))
    for row in recommendations:
        if row.get("status") != "open":
            continue
        questionnaire_id = str(row.get("questionnaire_id") or "")
        title = row.get("title") or "Questionnaire recommendation"
        why_open = f"Questionnaire recommendation is open with gap kind {row.get('gap_kind') or 'needs_review'}."
        items.append(_open_item(
            organization_id=organization_id,
            perspective="findings_issues",
            kind="questionnaire_finding",
            title=title,
            summary=row.get("body") or why_open,
            why_open=why_open,
            source_table=TABLE_QUESTIONNAIRE_RECOMMENDATIONS,
            source_id=str(row.get("id") or ""),
            priority=20 if row.get("severity") in {"high", "critical"} else 45,
            status="open",
            action_label="Review questionnaire recommendation",
            action_table=TABLE_QUESTIONNAIRE_RECOMMENDATIONS,
            action_id=str(row.get("id") or ""),
            metadata={
                "questionnaire_id": questionnaire_id,
                "item_id": row.get("item_id"),
                "response_id": row.get("response_id"),
                "gap_kind": row.get("gap_kind"),
                "who_acts": row.get("who_acts"),
                "severity": row.get("severity"),
                "completion_notes": row.get("completion_notes"),
            },
        ))
    for row in findings:
        if row.get("status") != "open":
            continue
        title = row.get("title") or "Manual finding"
        why_open = row.get("body") or "Manual finding remains open."
        items.append(_open_item(
            organization_id=organization_id,
            perspective="findings_issues",
            kind="manual_finding",
            title=title,
            summary=row.get("body") or why_open,
            why_open=why_open,
            source_table=TABLE_FINDINGS,
            source_id=str(row.get("id") or ""),
            priority=20 if row.get("severity") in {"critical", "high"} else 50,
            status="open",
            source_system=row.get("source_system"),
            source_url=row.get("source_url"),
            action_label="Review finding",
            action_table=TABLE_FINDINGS,
            action_id=str(row.get("id") or ""),
            metadata={
                "related_record_type": row.get("related_record_type"),
                "related_record_id": row.get("related_record_id"),
                "owner": row.get("owner"),
            },
        ))
    return items


def _review_open_items(
    organization_id: str,
    policies: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    applied_controls: list[dict[str, Any]],
    policy_catalog: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    today = datetime.now(UTC).date()
    items: list[dict[str, Any]] = []
    policies_by_id = {str(row.get("id")): row for row in (policy_catalog or policies) if row.get("id")}
    for row in policies:
        review_date = row.get("review_date")
        if row.get("status") == "archived":
            continue
        base = policies_by_id.get(str(row.get("base_policy_id") or ""))
        reviewed_base_version = str(row.get("reviewed_base_version") or "")
        base_version = str(base.get("version") or "") if base else ""
        if reviewed_base_version and base_version and reviewed_base_version != base_version:
            items.append(_open_item(
                organization_id=organization_id,
                perspective="needs_review",
                kind="policy_review",
                title=row.get("name") or "Policy extension review needed",
                summary=row.get("description") or "The global base changed after this customer extension was reviewed.",
                why_open=f"The base policy changed from version {reviewed_base_version} to {base_version}.",
                source_table=TABLE_POLICIES,
                source_id=str(row.get("id") or ""),
                priority=15,
                due_at=str(review_date) if review_date else None,
                status="base_changed",
                source_system=row.get("source_system"),
                source_url=row.get("source_url"),
                action_label="Review updated base",
                action_table=TABLE_POLICIES,
                action_id=str(row.get("id") or ""),
                metadata={
                    "review_date": review_date,
                    "policy_role": row.get("policy_role"),
                    "policy_type": row.get("policy_type"),
                    "reviewed_base_version": reviewed_base_version,
                    "base_version": base_version,
                },
            ))
            continue
        if not review_date:
            continue
        try:
            due = datetime.fromisoformat(str(review_date)).date()
        except ValueError:
            continue
        if due > today:
            continue
        items.append(_open_item(
            organization_id=organization_id,
            perspective="needs_review",
            kind="policy_review",
            title=row.get("name") or "Policy review due",
            summary=row.get("description") or row.get("content") or "Policy review due.",
            why_open=f"Policy review date was {review_date}.",
            source_table=TABLE_POLICIES,
            source_id=str(row.get("id") or ""),
            priority=15 if due <= today else 35,
            due_at=str(review_date),
            status=row.get("status"),
            source_system=row.get("source_system"),
            source_url=row.get("source_url"),
            action_label="Review policy",
            action_table=TABLE_POLICIES,
            action_id=str(row.get("id") or ""),
            metadata={"review_date": review_date, "policy_role": row.get("policy_role"), "policy_type": row.get("policy_type")},
        ))
    for row in evidence_rows:
        due_days = _days_until(row.get("review_due"))
        review_status = str(row.get("review_status") or "")
        if due_days is None and review_status not in {"needs_review", "rejected"}:
            continue
        if due_days is not None and due_days > 30 and review_status not in {"needs_review", "rejected"}:
            continue
        items.append(_open_item(
            organization_id=organization_id,
            perspective="needs_review",
            kind="evidence_review",
            title=row.get("name") or "Evidence review due",
            summary=row.get("notes") or "Evidence review due.",
            why_open=(
                f"Evidence review status is {review_status.replace('_', ' ')}."
                if due_days is None
                else "Evidence review date has passed."
                if due_days < 0
                else f"Evidence review is due in {due_days} day{'s' if due_days != 1 else ''}."
            ),
            source_table=TABLE_EVIDENCE,
            source_id=str(row.get("id") or ""),
            priority=10 if due_days is not None and due_days < 0 else 20,
            due_at=str(row.get("review_due") or "") or None,
            status=row.get("review_status"),
            source_system=row.get("source_system"),
            source_url=row.get("source_url"),
            action_label="Review evidence",
            action_table=TABLE_EVIDENCE,
            action_id=str(row.get("id") or ""),
            metadata={"review_due": row.get("review_due"), "last_reviewed_at": row.get("last_reviewed_at")},
        ))
    for row in applied_controls:
        review_status = str(row.get("review_status") or "")
        last_reviewed = row.get("last_reviewed_at")
        reviewed_at = _parse_date(last_reviewed)
        is_stale_approval = bool(
            review_status == "approved"
            and reviewed_at
            and (datetime.now(UTC) - (reviewed_at if reviewed_at.tzinfo else reviewed_at.replace(tzinfo=UTC))).days >= APPLIED_CONTROL_REVIEW_DUE_AFTER_DAYS
        )
        if review_status not in OPEN_REVIEW_STATUSES and not is_stale_approval:
            continue
        why_open = "Applied control review is more than one year old." if is_stale_approval else f"Applied control review status is {review_status or 'unspecified'}."
        if last_reviewed:
            why_open = f"{why_open} Last reviewed at {last_reviewed}."
        items.append(_open_item(
            organization_id=organization_id,
            perspective="needs_review",
            kind="applied_control_review",
            title=row.get("name") or "Applied control review due",
            summary=row.get("description") or why_open,
            why_open=why_open,
            source_table=TABLE_APPLIED_CONTROLS,
            source_id=str(row.get("id") or ""),
            priority=25 if review_status in {"needs_review", "draft"} or is_stale_approval else 45,
            status=review_status or None,
            source_system=row.get("source_system"),
            source_url=row.get("source_url"),
            action_label="Review applied control",
            action_table=TABLE_APPLIED_CONTROLS,
            action_id=str(row.get("id") or ""),
            metadata={"review_status": review_status, "last_reviewed_at": last_reviewed, "control_type": row.get("control_type")},
        ))
    return items


def _risk_open_items(organization_id: str, risks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for row in risks:
        status = str(row.get("status") or "").lower()
        if status in {"closed", "resolved", "accepted", "retired", "dismissed"}:
            continue
        items.append(_open_item(
            organization_id=organization_id,
            perspective="risks_concerns",
            kind="risk",
            title=row.get("name") or "Open risk",
            summary=row.get("description") or row.get("mitigation_plan") or "Risk remains open.",
            why_open=f"Risk status is {status or 'unspecified'}.",
            source_table=TABLE_RISKS,
            source_id=str(row.get("id") or ""),
            priority=20 if row.get("risk_level") in {"critical", "very_high", "high"} else 40,
            status=row.get("status"),
            action_label="Review risk",
            action_table=TABLE_RISKS,
            action_id=str(row.get("id") or ""),
            metadata={"risk_level": row.get("risk_level"), "category": row.get("category"), "owner": row.get("owner")},
        ))
    return items


def _exception_open_items(organization_id: str, exceptions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    today = datetime.now(UTC).date()
    for row in exceptions:
        status = str(row.get("status") or "pending")
        expires_at = row.get("expires_at")
        days = _days_until(expires_at)
        if days is None or days > EXCEPTION_EXPIRY_DAYS:
            continue
        if status == "denied":
            continue
        why_open = (
            f"Exception expires in {days} day{'s' if days != 1 else ''}."
            if days >= 0
            else f"Exception expired {abs(days)} day{'s' if abs(days) != 1 else ''} ago."
        )
        items.append(_open_item(
            organization_id=organization_id,
            perspective="expiring",
            kind="exception",
            title=row.get("name") or "Expiring exception",
            summary=row.get("reason") or row.get("compensating_controls") or why_open,
            why_open=why_open,
            source_table=TABLE_EXCEPTIONS,
            source_id=str(row.get("id") or ""),
            priority=10 if days is not None and days <= 0 else 20,
            due_at=str(expires_at) if expires_at else None,
            status=status,
            action_label="Review exception",
            action_table=TABLE_EXCEPTIONS,
            action_id=str(row.get("id") or ""),
            metadata={"expires_at": expires_at, "control_id": row.get("control_id"), "approved_by": row.get("approved_by")},
        ))
    return items


def _sort_open_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {
        "priority": 0,
        "missing_information": 1,
        "findings_issues": 2,
        "risks_concerns": 3,
        "needs_review": 4,
        "expiring": 5,
        "completed": 6,
    }
    return sorted(
        items,
        key=lambda row: (
            order.get(str(row.get("perspective") or ""), 99),
            int(row.get("priority") or 50),
            str(row.get("due_at") or "9999-12-31"),
            str(row.get("organization_id") or ""),
            str(row.get("title") or "").lower(),
        ),
    )


def _page_items(items: list[dict[str, Any]], cursor: str | None, page_size: int) -> tuple[list[dict[str, Any]], str | None]:
    start = 0
    if cursor:
        try:
            start = max(0, int(cursor))
        except (TypeError, ValueError):
            raise UserError("cursor must be an integer offset")
    end = start + page_size
    page = items[start:end]
    next_cursor = str(end) if end < len(items) else None
    return page, next_cursor


def _count_by_perspective(items: list[dict[str, Any]]) -> dict[str, int]:
    counts = {perspective: 0 for perspective in OPEN_ITEM_PERSPECTIVES if perspective != "all"}
    for item in items:
        perspectives = {
            str(value)
            for value in (item.get("perspectives") or [item.get("perspective")])
            if value
        }
        for perspective in perspectives:
            if perspective in counts:
                counts[perspective] += 1
    counts["all"] = len(items)
    return counts


async def _build_open_items_feed(
    bifrost_organization_id: str | None,
    *,
    perspective: str | None = None,
    cursor: str | None = None,
    page_size: int = 50,
    include_complete: bool = False,
) -> dict[str, Any]:
    portfolio_mode = bifrost_organization_id is None
    if portfolio_mode:
        require_provider("Provider access is required for GRC portfolio open items.")
        organization_ids = await _portfolio_customer_organization_ids()
        if not organization_ids:
            return {
                "mode": "read_only",
                "bifrost_organization_id": None,
                "portfolio_mode": True,
                "perspective": (perspective or "all").strip().lower(),
                "cursor": cursor or "0",
                "page_size": max(1, min(int(page_size or 50), 200)),
                "count": 0,
                "total_count": 0,
                "next_cursor": None,
                "counts": _count_by_perspective([]),
                "items": [],
                "open_items": [],
                "organization_ids": [],
            }
    else:
        organization_ids = [bind_organization_scope(bifrost_organization_id, resource="GRC open items")]
    selected = (perspective or "all").strip().lower()
    if selected not in OPEN_ITEM_PERSPECTIVES:
        raise UserError(f"perspective must be one of: {', '.join(sorted(OPEN_ITEM_PERSPECTIVES))}")
    page_size = max(1, min(int(page_size or 50), 200))

    fact_definitions, facts, fact_conflicts = await _resolved_facts(bifrost_organization_id or organization_ids[0])
    all_requirements, all_policies = await asyncio.gather(
        _query_all_rows(TABLE_FACT_REQUIREMENTS, {}),
        _query_all_rows(TABLE_POLICIES, {}),
    )

    assessments, assessment_controls, controls, recommendations, risks, evidence_rows, applied_controls, exceptions, findings = await asyncio.gather(
        _query_all_rows(TABLE_ASSESSMENTS, {}),
        _query_all_rows(TABLE_ASSESSMENT_CONTROLS, {}),
        _query_all_rows(TABLE_CONTROLS, {}),
        _query_all_rows(TABLE_QUESTIONNAIRE_RECOMMENDATIONS, {}),
        _query_all_rows(TABLE_RISKS, {}),
        _query_all_rows(TABLE_EVIDENCE, {}),
        _query_all_rows(TABLE_APPLIED_CONTROLS, {}),
        _query_all_rows(TABLE_EXCEPTIONS, {}),
        _query_all_rows(TABLE_FINDINGS, {}),
    )
    assessments_by_id = {str(row.get("id")): row for row in assessments if row.get("id")}
    controls_by_id = {str(row.get("id")): row for row in controls if row.get("id")}
    org_items: list[dict[str, Any]] = []
    legacy_open_items: list[dict[str, Any]] = []
    customer_ids = set(organization_ids)

    def rows_owned_by(rows: list[dict[str, Any]], organization_id: str) -> list[dict[str, Any]]:
        return [row for row in rows if str(row.get("organization_id") or "") == organization_id]

    def append_source_items(organization_id: str, *, shared: bool = False) -> None:
        if shared:
            scoped_assessments = [row for row in assessments if str(row.get("organization_id") or "") not in customer_ids]
            scoped_recommendations = [row for row in recommendations if str(row.get("organization_id") or "") not in customer_ids]
            scoped_findings = [row for row in findings if str(row.get("organization_id") or "") not in customer_ids]
            scoped_risks = [row for row in risks if str(row.get("organization_id") or "") not in customer_ids]
            scoped_policies = [row for row in all_policies if str(row.get("organization_id") or "") not in customer_ids]
            scoped_evidence = [row for row in evidence_rows if str(row.get("organization_id") or "") not in customer_ids]
            scoped_applied = [row for row in applied_controls if str(row.get("organization_id") or "") not in customer_ids]
            scoped_exceptions = [row for row in exceptions if str(row.get("organization_id") or "") not in customer_ids]
        else:
            scoped_assessments = rows_owned_by(assessments, organization_id)
            scoped_recommendations = rows_owned_by(recommendations, organization_id)
            scoped_findings = rows_owned_by(findings, organization_id)
            scoped_risks = rows_owned_by(risks, organization_id)
            scoped_policies = rows_owned_by(all_policies, organization_id)
            scoped_evidence = rows_owned_by(evidence_rows, organization_id)
            scoped_applied = rows_owned_by(applied_controls, organization_id)
            scoped_exceptions = rows_owned_by(exceptions, organization_id)
        scoped_assessment_ids = {str(row.get("id")) for row in scoped_assessments if row.get("id")}
        scoped_assessment_controls = [
            row for row in assessment_controls
            if str(row.get("assessment_id") or "") in scoped_assessment_ids
        ]
        scoped_assessments_by_id = {
            key: value for key, value in assessments_by_id.items() if key in scoped_assessment_ids
        }
        org_items.extend(_findings_open_items(
            organization_id,
            scoped_assessments_by_id,
            controls_by_id,
            scoped_assessment_controls,
            scoped_recommendations,
            scoped_findings,
        ))
        org_items.extend(_risk_open_items(organization_id, scoped_risks))
        org_items.extend(_review_open_items(organization_id, scoped_policies, scoped_evidence, scoped_applied, all_policies))
        org_items.extend(_exception_open_items(organization_id, scoped_exceptions))

    for organization_id in organization_ids:
        requirements = [
            requirement for requirement in all_requirements
            if requirement.get("target_type") != "policy_template"
            and requirement.get("organization_id") in (None, "", organization_id)
            and requirement.get("status") != "waived"
        ]
        requirements.extend(_policy_fact_requirements(all_policies, organization_id, fact_definitions, all_requirements))

        if not portfolio_mode or selected in {"all", "missing_information"}:
            if not portfolio_mode:
                complete_statuses = {"verified", "not_applicable", "accepted_unknown"}
                combined: dict[str, dict[str, Any]] = {}
                for requirement in requirements:
                    key = str(requirement.get("fact_key") or "")
                    fact = facts.get(key)
                    conflict_rows = fact_conflicts.get(key, [])
                    status = "needs_verification" if conflict_rows else str(fact.get("status") if fact else "unanswered")
                    if not include_complete and status in complete_statuses:
                        continue
                    definition = fact_definitions.get(key, {})
                    item = {
                        "fact_key": key,
                        "title": definition.get("title") or key,
                        "category": definition.get("category"),
                        "fact_type": definition.get("fact_type"),
                        "status": status,
                        "value": _json_loads(fact.get("value_json"), None) if fact else None,
                        "fact_id": fact.get("id") if fact else None,
                        "requirement_id": requirement.get("id"),
                        "target_type": requirement.get("target_type"),
                        "target_id": requirement.get("target_id"),
                        "target_source_id": requirement.get("target_source_id"),
                        "context": requirement.get("context"),
                        "priority": requirement.get("priority"),
                        "responsible_party": requirement.get("responsible_party"),
                        "source_system": fact.get("source_system") if fact else None,
                        "source_url": fact.get("source_url") if fact else None,
                        "verified_at": fact.get("verified_at") if fact else None,
                        "review_due": fact.get("review_due") if fact else None,
                        "effective_scope_kind": fact.get("effective_scope_kind") if fact else None,
                        "effective_scope_size": fact.get("effective_scope_size") if fact else None,
                        "resolution_conflict": conflict_rows or None,
                    }
                    usage = {
                        "requirement_id": item.pop("requirement_id"),
                        "target_type": item.pop("target_type"),
                        "target_id": item.pop("target_id"),
                        "target_source_id": item.pop("target_source_id"),
                        "context": item.pop("context"),
                    }
                    if key not in combined:
                        item["usages"] = [usage]
                        combined[key] = item
                    else:
                        combined[key]["usages"].append(usage)
                legacy_open_items = list(combined.values())
            else:
                legacy_open_items = []

        if not portfolio_mode:
            for requirement in requirements:
                key = str(requirement.get("fact_key") or "")
                fact = facts.get(key)
                conflicts = fact_conflicts.get(key, [])
                definition = fact_definitions.get(key, {})
                item = _policy_fact_open_item(organization_id, requirement, fact, conflicts, definition)
                if not item:
                    continue
                if selected in {"all", "missing_information", "priority"}:
                    org_items.append(item)

        append_source_items(organization_id)

    if portfolio_mode:
        # Provider-owned and global obligations appear once in the portfolio,
        # never once per customer and never as a customer-owned task.
        append_source_items("", shared=True)

    combined_items: dict[str, dict[str, Any]] = {}
    for item in org_items:
        item_id = str(item.get("id") or "")
        existing_item = combined_items.get(item_id)
        if existing_item and item.get("kind") == "missing_information":
            existing_item["usages"] = [
                *(existing_item.get("usages") or []),
                *(item.get("usages") or []),
            ]
            continue
        combined_items[item_id] = item

    items = _sort_open_items(list(combined_items.values()))
    counts = _count_by_perspective(items)
    visible_items = items
    if selected == "priority":
        visible_items = [item for item in items if "priority" in (item.get("perspectives") or [])]
    elif selected != "all":
        visible_items = [item for item in items if str(item.get("perspective") or "") == selected]
    if selected == "missing_information" and portfolio_mode:
        visible_items = []
    if selected == "completed":
        visible_items = []
    total_count = len(visible_items)
    page, next_cursor = _page_items(visible_items, cursor, page_size)
    return {
        "mode": "read_only",
        "bifrost_organization_id": bifrost_organization_id,
        "portfolio_mode": portfolio_mode,
        "perspective": selected,
        "cursor": cursor or "0",
        "page_size": page_size,
        "count": len(page),
        "total_count": total_count,
        "next_cursor": next_cursor,
        "counts": counts,
        "items": page,
        "open_items": legacy_open_items if not portfolio_mode else [],
        "organization_ids": organization_ids,
    }


@workflow(
    name="bifrost_grc_query_records",
    description=(
        "Search and inspect any table surfaced by the Bifrost GRC app. Supports exact field filters, "
        "customer-effective scoping, free-text matching, and bounded results. Read-only."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_query_records(
    table: str,
    bifrost_organization_id: str | None = None,
    where: dict[str, Any] | None = None,
    search_text: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    _provider_owner_id()
    if table not in APP_GRC_TABLES:
        raise UserError(f"Unsupported GRC table: {table}")
    limit = max(1, min(limit, 500))
    rows = await _query_rows(table, where or {}, limit=1000)
    if bifrost_organization_id:
        rows = [row for row in rows if applies_to_organization(row, bifrost_organization_id)]
    if search_text and search_text.strip():
        needle = search_text.strip().lower()
        rows = [row for row in rows if needle in json.dumps(row, default=str).lower()]
    return {
        "mode": "read_only",
        "table": table,
        "bifrost_organization_id": bifrost_organization_id,
        "count": min(len(rows), limit),
        "truncated": len(rows) > limit,
        "rows": rows[:limit],
    }


@workflow(
    name="bifrost_grc_manage_record",
    description=(
        "Confirm-gated create, update, or delete for any row-backed surface in the Bifrost GRC app. "
        "Use specialized GRC tools when available; use this for remaining app fields and records."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_manage_record(
    table: str,
    action: str,
    payload: dict[str, Any] | None = None,
    row_id: str | None = None,
    bifrost_organization_id: str | None = None,
    allow_global: bool = False,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, f"{action} on {table}")
    provider_org_id = _provider_owner_id()
    if table not in APP_GRC_TABLES:
        raise UserError(f"Unsupported GRC table: {table}")
    if table in {TABLE_CHANGE_HISTORY, "grc-applied-control-history", "grc-policy-campaigns", "grc-policy-campaign-assignments", "grc-policy-acceptances"}:
        raise UserError("Change history is append-only; audit and sign-off records can only be written by their dedicated workflows.")
    if action not in {"create", "update", "delete"}:
        raise UserError("action must be create, update, or delete")
    if action in {"update", "delete"} and not row_id:
        raise UserError("row_id is required for update or delete")
    if action in {"create", "update"} and not isinstance(payload, dict):
        raise UserError("payload is required for create or update")

    existing = await _get_row(table, row_id) if row_id else None
    if row_id and not existing:
        raise UserError(f"Row not found: {table}:{row_id}")
    target_org = bifrost_organization_id
    if existing:
        owner = existing.get("organization_id")
        if owner is None and not allow_global:
            raise UserError("allow_global=true is required to change a global row")
        if target_org and owner not in {None, provider_org_id, target_org}:
            raise UserError("Row belongs to a different customer")

    next_payload = dict(payload or {})
    supplied_owner = next_payload.get("organization_id")
    if supplied_owner is None and "organization_id" in next_payload and not allow_global:
        raise UserError("allow_global=true is required to write a global row")
    if target_org and supplied_owner not in {None, provider_org_id, target_org}:
        raise UserError("payload.organization_id belongs to a different customer")
    if target_org and table in DIRECT_SCOPED_TABLES:
        next_payload["organization_id"] = target_org
        next_payload["applied_organizations"] = [target_org]
        next_payload["excluded_organizations"] = []

    if action != "delete":
        if table in EDITABLE_FIELDS:
            next_payload = attributed_payload(table, next_payload, existing, execution_context=context)
        elif set(next_payload) & PROTECTED_FIELDS:
            raise UserError("Attribution fields cannot be supplied through the generic record tool.")
    authenticated_actor_id(context)

    result = {
        "mode": "dry_run" if not apply else "apply",
        "table": table,
        "action": action,
        "row_id": row_id,
        "existing": existing,
        "payload": next_payload if action != "delete" else None,
    }
    if not apply:
        return result
    before = existing
    if action == "create":
        created_row = _doc_to_row(await tables.insert(table, next_payload))
        result["row"] = created_row
        await _record_change(
            entity_type=table,
            entity_id=str(created_row.get("id") or ""),
            event_type="create",
            organization_id=created_row.get("organization_id") or target_org,
            before=None,
            after=created_row,
            source_system=created_row.get("source_system"),
        )
    elif action == "update":
        await tables.update(table, str(row_id), next_payload)
        updated_row = await _get_row(table, row_id)
        result["row"] = updated_row
        await _record_change(
            entity_type=table,
            entity_id=str(row_id),
            event_type="update",
            organization_id=(updated_row or before or {}).get("organization_id") or target_org,
            before=before,
            after=updated_row,
            source_system=(updated_row or before or {}).get("source_system"),
        )
    else:
        result["deleted"] = bool(await tables.delete_document(table, str(row_id)))
        await _record_change(
            entity_type=table,
            entity_id=str(row_id),
            event_type="delete",
            organization_id=(before or {}).get("organization_id") or target_org,
            before=before,
            after=None,
            source_system=(before or {}).get("source_system"),
        )
    return result


@workflow(
    name="bifrost_grc_process_questionnaire",
    description=(
        "Run Bifrost GRC questionnaire automation to extract questions, draft answers "
        "from controls/evidence/policies, or apply accepted answers into reusable GRC records."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_process_questionnaire(
    questionnaire_id: str,
    operation: str,
    replace_existing: bool = False,
    model: str | None = None,
    max_chars: int = 80000,
    max_items: int = 40,
    max_context_rows: int = 120,
    response_ids: list[str] | None = None,
    dry_run: bool = True,
    apply_suggested_links: bool = True,
    create_missing_applied_controls: bool = False,
    prefill_answers: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    from workflows.grc_v2.grc_questionnaires import (
        grc_v2_apply_grc_questionnaire_answers,
        grc_v2_draft_grc_questionnaire_answers,
        grc_v2_extract_grc_questionnaire,
    )

    if operation == "extract":
        return await grc_v2_extract_grc_questionnaire(
            questionnaire_id=questionnaire_id,
            replace_existing=replace_existing,
            model=model,
            max_chars=max_chars,
            prefill_answers=prefill_answers,
        )
    if operation == "draft_answers":
        return await grc_v2_draft_grc_questionnaire_answers(
            questionnaire_id=questionnaire_id,
            replace_existing=replace_existing,
            model=model,
            max_items=max_items,
            max_context_rows=max_context_rows,
        )
    if operation == "apply_accepted":
        if not dry_run and not confirm_apply:
            raise UserError("confirm_apply=true is required before applying questionnaire answers.")
        return await grc_v2_apply_grc_questionnaire_answers(
            questionnaire_id=questionnaire_id,
            response_ids=response_ids,
            dry_run=dry_run,
            apply_suggested_links=apply_suggested_links,
            create_missing_applied_controls=create_missing_applied_controls,
        )
    raise UserError("operation must be one of: extract, draft_answers, apply_accepted")


_MIME_BY_EXT = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".txt": "text/plain",
}


@workflow(
    name="bifrost_grc_create_questionnaire_from_document",
    description=(
        "Bootstrap a Bifrost GRC questionnaire from an already-uploaded source document (PDF/DOCX/"
        "text in the uploads store): creates the grc-source-documents and grc-questionnaires rows, "
        "then runs question extraction. Use when an agent is handed a bare document with no existing "
        "questionnaire to operate on. Confirm-gated; defaults to a dry run."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_v2_create_questionnaire_from_document(
    bifrost_organization_id: str,
    file_path: str,
    name: str,
    carrier: str | None = None,
    file_name: str | None = None,
    mime_type: str | None = None,
    run_extraction: bool = True,
    prefill_answers: bool = False,
    model: str | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "creating a questionnaire from a source document")
    bind_organization_scope(bifrost_organization_id, resource="questionnaire")
    if not file_path:
        raise UserError("file_path is required (path of the uploaded document in the uploads store)")
    if not name:
        raise UserError("name is required")

    from workflows.grc_v2.grc_source_files import source_file_reference
    file_path = source_file_reference(file_path, bifrost_organization_id).path
    resolved_file_name = file_name or file_path.rsplit("/", 1)[-1]
    resolved_mime = mime_type
    if not resolved_mime:
        lowered = resolved_file_name.lower()
        for ext, mime in _MIME_BY_EXT.items():
            if lowered.endswith(ext):
                resolved_mime = mime
                break

    source_payload = _clean_payload(
        {
            "organization_id": bifrost_organization_id,
            "name": name,
            "document_type": "questionnaire",
            "file_name": resolved_file_name,
            "file_path": file_path,
            "mime_type": resolved_mime,
            "source_system": "bifrost_grc_agent",
            "metadata_json": _stable_json({"created_by": "bifrost_grc_create_questionnaire_from_document"}),
        }
    )
    questionnaire_payload = _clean_payload(
        {
            "organization_id": bifrost_organization_id,
            "name": name,
            "carrier": carrier,
            "status": "draft",
            "metadata_json": _stable_json({"created_by": "bifrost_grc_create_questionnaire_from_document"}),
        }
    )

    if not apply:
        return {
            "mode": "dry_run",
            "source_document": source_payload,
            "questionnaire": {**questionnaire_payload, "source_document_id": "<created_source_document_id>"},
            "run_extraction": run_extraction,
        }

    source = _doc_to_row(await tables.insert(TABLE_SOURCE_DOCUMENTS, source_payload))
    source_id = source.get("id")
    questionnaire_payload["source_document_id"] = source_id
    questionnaire = _doc_to_row(await tables.insert(TABLE_QUESTIONNAIRES, questionnaire_payload))
    questionnaire_id = questionnaire.get("id")

    extraction = None
    if run_extraction:
        from workflows.grc_v2.grc_questionnaires import grc_v2_extract_grc_questionnaire

        extraction = await grc_v2_extract_grc_questionnaire(
            questionnaire_id=questionnaire_id,
            replace_existing=True,
            model=model,
            prefill_answers=prefill_answers,
        )

    return {
        "mode": "apply",
        "source_document": source,
        "questionnaire": questionnaire,
        "extraction": extraction,
    }


@workflow(
    name="bifrost_grc_review_org_posture",
    description=(
        "Summarize Bifrost GRC organization posture across frameworks, assessments, "
        "applied controls, evidence, policies, exceptions, risks, questionnaires, and migration provenance."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_review_org_posture(
    bifrost_organization_id: str,
    include_recent: bool = True,
    include_gaps: bool = True,
    limit: int = 20,
) -> dict[str, Any]:
    _provider_owner_id()
    limit = max(1, min(limit, 100))

    async def effective(table: str, row_limit: int = 1000) -> list[dict[str, Any]]:
        rows = await _query_rows(table, {}, limit=row_limit)
        return [row for row in rows if applies_to_organization(row, bifrost_organization_id)]

    assessments = await effective(TABLE_ASSESSMENTS)
    assessment_ids = {row.get("id") for row in assessments if row.get("id")}
    assessment_controls = [
        row
        for row in await _query_rows(TABLE_ASSESSMENT_CONTROLS, {}, limit=1000)
        if row.get("assessment_id") in assessment_ids
    ]
    shared_rows = {
        "applied_controls": await effective(TABLE_APPLIED_CONTROLS),
        "control_mappings": await effective(TABLE_CONTROL_MAPPINGS),
        "evidence": await effective(TABLE_EVIDENCE),
        "evidence_links": await effective(TABLE_EVIDENCE_LINKS),
        "policies": await effective(TABLE_POLICIES),
        "policy_links": await effective(TABLE_POLICY_LINKS),
        "exceptions": await effective(TABLE_EXCEPTIONS),
        "exception_links": await effective(TABLE_EXCEPTION_LINKS),
        "risks": await effective(TABLE_RISKS),
        "risk_links": await effective(TABLE_RISK_LINKS),
    }
    org_where = {"organization_id": bifrost_organization_id}
    counts = {
        "assessments": len(assessments),
        "assessment_controls": len(assessment_controls),
        **{key: len(rows) for key, rows in shared_rows.items()},
        "questionnaires": await _safe_count(TABLE_QUESTIONNAIRES, org_where),
        "source_documents": await _safe_count(TABLE_SOURCE_DOCUMENTS, org_where),
        "import_mappings": await _safe_count(
            TABLE_IMPORT_MAPPINGS,
            {"organization_id": bifrost_organization_id, "source_system": "ciso_assistant"},
        ),
    }

    output: dict[str, Any] = {
        "bifrost_organization_id": bifrost_organization_id,
        "counts": counts,
    }

    if include_gaps:
        applied = shared_rows["applied_controls"]
        mappings = shared_rows["control_mappings"]
        mapped_applied_ids = {row.get("applied_control_id") for row in mappings if row.get("applied_control_id")}
        mapped_control_ids = {row.get("control_id") for row in mappings if row.get("control_id")}
        evidence_links = shared_rows["evidence_links"]
        applied_with_evidence = {
            row.get("target_id")
            for row in evidence_links
            if row.get("target_type") == "applied_control" and row.get("target_id")
        }
        output["gaps"] = {
            "unmapped_applied_controls": [
                {"id": row.get("id"), "name": row.get("name"), "status": row.get("status")}
                for row in applied
                if row.get("id") not in mapped_applied_ids
            ][:limit],
            "applied_controls_without_evidence": [
                {"id": row.get("id"), "name": row.get("name"), "status": row.get("status")}
                for row in applied
                if row.get("id") not in applied_with_evidence
            ][:limit],
            "mapped_reference_controls": len(mapped_control_ids),
        }

    if include_recent:
        output["recent"] = {
            "assessments": assessments[:limit],
            "applied_controls": shared_rows["applied_controls"][:limit],
            "questionnaires": await _query_rows(TABLE_QUESTIONNAIRES, org_where, limit=limit),
            "source_documents": await _query_rows(TABLE_SOURCE_DOCUMENTS, org_where, limit=limit),
        }

    return output


@workflow(
    name="bifrost_grc_read_answer_context",
    description=(
        "Read the Bifrost GRC answer context for one organization: tenant-scoped applied controls "
        "and policies, global reference controls, evidence and evidence "
        "links, policy links, and active exceptions. Read-only. This is the stored-data basis the GRC "
        "Investigation Agent uses to answer compliance and insurance-questionnaire questions before "
        "falling back to baseline reasoning."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_v2_read_answer_context(
    bifrost_organization_id: str,
    max_context_rows: int = 120,
) -> dict[str, Any]:
    provider_org_id = _provider_owner_id()
    from workflows.grc_v2.grc_questionnaires import _build_answer_context

    context = await _build_answer_context(
        {"organization_id": bifrost_organization_id},
        max(1, min(max_context_rows, 500)),
        provider_org_id=provider_org_id,
    )
    context["mode"] = "read_only"
    context["bifrost_organization_id"] = bifrost_organization_id
    return context


@workflow(
    name="bifrost_grc_suggest_control_mappings",
    description=(
        "Suggest Bifrost GRC applied-control to reference-control mappings with rationale "
        "and confidence using existing policies, evidence, questionnaire answers, and imported CISO mappings."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_suggest_control_mappings(
    bifrost_organization_id: str,
    applied_control_ids: list[str] | None = None,
    control_ids: list[str] | None = None,
    min_confidence: float = 0.25,
    limit: int = 25,
) -> dict[str, Any]:
    _provider_owner_id()
    limit = max(1, min(limit, 100))

    applied_rows = []
    if applied_control_ids:
        for row_id in applied_control_ids:
            applied_rows.append(await _validate_target(bifrost_organization_id, "applied_control", row_id))
    else:
        applied_rows = await _query_rows(
            TABLE_APPLIED_CONTROLS,
            {},
            limit=500,
        )
        applied_rows = [row for row in applied_rows if applies_to_organization(row, bifrost_organization_id)]

    control_rows = []
    if control_ids:
        for row_id in control_ids:
            row = await _get_row(TABLE_CONTROLS, row_id)
            if row:
                control_rows.append(row)
    else:
        control_rows = await _query_rows(TABLE_CONTROLS, {"is_active": True}, limit=1000)
        if not control_rows:
            control_rows = await _query_rows(TABLE_CONTROLS, {}, limit=1000)

    existing_mappings = await _query_rows(
        TABLE_CONTROL_MAPPINGS,
        {},
        limit=1000,
    )
    existing_mappings = [row for row in existing_mappings if applies_to_organization(row, bifrost_organization_id)]
    existing_pairs = {
        (row.get("applied_control_id"), row.get("control_id"))
        for row in existing_mappings
        if row.get("applied_control_id") and row.get("control_id")
    }

    evidence_links = await _query_rows(
        TABLE_EVIDENCE_LINKS,
        {},
        limit=1000,
    )
    policy_links = await _query_rows(
        TABLE_POLICY_LINKS,
        {},
        limit=1000,
    )
    evidence_links = [row for row in evidence_links if applies_to_organization(row, bifrost_organization_id)]
    policy_links = [row for row in policy_links if applies_to_organization(row, bifrost_organization_id)]
    evidence_by_target: dict[tuple[str, str], list[str]] = {}
    policy_by_target: dict[tuple[str, str], list[str]] = {}
    for link in evidence_links:
        key = (str(link.get("target_type")), str(link.get("target_id")))
        evidence_by_target.setdefault(key, []).append(str(link.get("evidence_id")))
    for link in policy_links:
        key = (str(link.get("target_type")), str(link.get("target_id")))
        policy_by_target.setdefault(key, []).append(str(link.get("policy_id")))

    suggestions: list[dict[str, Any]] = []
    for applied in applied_rows:
        applied_id = applied.get("id")
        applied_tokens = _tokens(
            applied.get("name"),
            applied.get("description"),
            applied.get("control_type"),
            _tag_text(applied.get("tags_json")),
        )
        if not applied_id or not applied_tokens:
            continue
        for control in control_rows:
            control_id = control.get("id")
            if not control_id or (applied_id, control_id) in existing_pairs:
                continue
            control_tokens = _tokens(control.get("control_id"), control.get("title"), control.get("description"), control.get("guidance"))
            if not control_tokens:
                continue
            overlap = sorted(applied_tokens & control_tokens)
            if not overlap:
                continue
            confidence = min(0.95, round(len(overlap) / max(5, len(control_tokens)) + 0.15, 2))
            if confidence < min_confidence:
                continue
            applied_evidence_ids = evidence_by_target.get(("applied_control", applied_id), [])
            applied_policy_ids = policy_by_target.get(("applied_control", applied_id), [])
            relationship = "satisfies" if confidence >= 0.7 else "supports"
            suggestions.append(
                {
                    "applied_control_id": applied_id,
                    "applied_control_name": applied.get("name"),
                    "control_id": control_id,
                    "reference_control": control.get("control_id"),
                    "control_title": control.get("title"),
                    "relationship": relationship,
                    "confidence": confidence,
                    "rationale": (
                        "Keyword overlap suggests this applied control may map to the reference control: "
                        + ", ".join(overlap[:10])
                    ),
                    "supporting_evidence_ids": applied_evidence_ids[:10],
                    "supporting_policy_ids": applied_policy_ids[:10],
                    "recommended_action": "review_and_accept_mapping",
                }
            )

    suggestions.sort(key=lambda row: row["confidence"], reverse=True)
    return {
        "bifrost_organization_id": bifrost_organization_id,
        "mode": "suggest_only",
        "count": len(suggestions[:limit]),
        "suggestions": suggestions[:limit],
    }


@workflow(
    name="bifrost_grc_list_frameworks",
    description=(
        "List Bifrost GRC frameworks, domains, and controls for framework building, "
        "assessment planning, and CISO Assistant migration review."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_list_frameworks(
    bifrost_organization_id: str | None = None,
    include_global: bool = True,
    include_inactive: bool = False,
    include_domains: bool = True,
    include_controls: bool = True,
    search: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    limit = max(1, min(limit, 200))
    framework_rows = await _query_rows(TABLE_FRAMEWORKS, {}, limit=1000)
    search_tokens = _tokens(search) if search else set()
    frameworks = []
    for framework in framework_rows:
        if not include_inactive and framework.get("is_active") is False:
            continue
        framework_org = framework.get("organization_id")
        if bifrost_organization_id:
            if framework_org not in (None, "", bifrost_organization_id):
                continue
            if framework_org in (None, "") and not include_global:
                continue
        elif framework_org in (None, "") and not include_global:
            continue
        if search_tokens and not (_tokens(framework.get("name"), framework.get("description"), framework.get("version")) & search_tokens):
            continue
        frameworks.append(framework)

    frameworks = frameworks[:limit]
    framework_ids = {row.get("id") for row in frameworks if row.get("id")}
    domains = [
        row
        for row in await _query_rows(TABLE_DOMAINS, {}, limit=1000)
        if row.get("framework_id") in framework_ids and (include_inactive or row.get("is_active") is not False)
    ] if include_domains or include_controls else []
    domain_ids = {row.get("id") for row in domains if row.get("id")}
    control_rows = [
        row
        for row in await _query_rows(TABLE_CONTROLS, {}, limit=1000)
        if row.get("framework_id") in framework_ids
        and (not domain_ids or row.get("domain_id") in domain_ids or row.get("domain_id") in (None, ""))
        and (include_inactive or row.get("is_active") is not False)
    ]
    domains_by_framework: dict[str, list[dict[str, Any]]] = {}
    controls_by_framework: dict[str, list[dict[str, Any]]] = {}
    controls_by_domain: dict[str, list[dict[str, Any]]] = {}
    for domain in domains:
        domains_by_framework.setdefault(str(domain.get("framework_id")), []).append(domain)
    for control in control_rows:
        controls_by_framework.setdefault(str(control.get("framework_id")), []).append(control)
        if control.get("domain_id"):
            controls_by_domain.setdefault(str(control.get("domain_id")), []).append(control)

    output_rows = []
    for framework in frameworks:
        framework_id = str(framework.get("id"))
        item = {
            "id": framework_id,
            "name": framework.get("name"),
            "version": framework.get("version"),
            "description": framework.get("description"),
            "organization_id": framework.get("organization_id"),
            "scope": framework.get("scope"),
            "is_active": framework.get("is_active"),
            "domain_count": len(domains_by_framework.get(framework_id, [])),
            "control_count": len(controls_by_framework.get(framework_id, [])),
        }
        if include_domains:
            item["domains"] = [
                {
                    "id": domain.get("id"),
                    "name": domain.get("name"),
                    "description": domain.get("description"),
                    "sort_order": domain.get("sort_order"),
                    "is_active": domain.get("is_active"),
                    "control_count": len(controls_by_domain.get(str(domain.get("id")), [])),
                }
                for domain in sorted(domains_by_framework.get(framework_id, []), key=lambda row: row.get("sort_order") or 0)
            ]
        if include_controls:
            item["controls"] = [
                {
                    "id": control.get("id"),
                    "domain_id": control.get("domain_id"),
                    "control_id": control.get("control_id"),
                    "title": control.get("title"),
                    "description": control.get("description"),
                    "guidance": control.get("guidance"),
                    "sort_order": control.get("sort_order"),
                    "is_active": control.get("is_active"),
                }
                for control in sorted(controls_by_framework.get(framework_id, []), key=lambda row: (str(row.get("domain_id") or ""), row.get("sort_order") or 0))
            ]
        output_rows.append(item)

    return {
        "mode": "read_only",
        "bifrost_organization_id": bifrost_organization_id,
        "count": len(output_rows),
        "frameworks": output_rows,
    }


@workflow(
    name="bifrost_grc_manage_framework",
    description=(
        "Create or update a Bifrost GRC framework with domains and reference controls "
        "for framework building, migration, and assessment readiness."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_manage_framework(
    name: str,
    framework_id: str | None = None,
    description: str | None = None,
    version: str | None = "1.0",
    is_active: bool = True,
    domains: list[dict[str, Any]] | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "creating or updating a framework")
    require_provider("Only Platform Org users may maintain the global standards catalog.")
    if not name:
        raise UserError("name is required")
    existing_framework = await _get_row(TABLE_FRAMEWORKS, framework_id)
    if framework_id and not existing_framework:
        raise UserError(f"Framework not found: {framework_id}")
    framework_payload = _clean_payload(
        {
            "name": name,
            "description": description,
            "version": version,
            "is_active": is_active,
            "scope": "global",
        }
    )

    planned_domains: list[dict[str, Any]] = []
    planned_controls: list[dict[str, Any]] = []
    for domain_index, domain in enumerate(domains or [], start=1):
        domain_id = domain.get("id")
        domain_payload = _clean_payload(
            {
                "framework_id": framework_id or "<created_framework_id>",
                "name": domain.get("name") or f"Domain {domain_index}",
                "description": domain.get("description"),
                "sort_order": domain.get("sort_order") or domain_index * 10,
                "is_active": domain.get("is_active", True),
            }
        )
        planned_domains.append(
            {
                "action": "update" if domain_id else "create",
                "domain_id": domain_id,
                "payload": domain_payload,
            }
        )
        for control_index, control in enumerate(domain.get("controls") or [], start=1):
            control_id = control.get("id")
            control_payload = _clean_payload(
                {
                    "framework_id": framework_id or "<created_framework_id>",
                    "domain_id": domain_id or f"<domain:{domain_index}>",
                    "control_id": control.get("control_id") or f"C-{control_index}",
                    "title": control.get("title") or "New control",
                    "description": control.get("description"),
                    "guidance": control.get("guidance"),
                    "sort_order": control.get("sort_order") or control_index * 10,
                    "is_active": control.get("is_active", True),
                }
            )
            planned_controls.append(
                {
                    "action": "update" if control_id else "create",
                    "domain_index": domain_index,
                    "control_id": control_id,
                    "payload": control_payload,
                }
            )

    if not apply:
        return {
            "mode": "dry_run",
            "framework": {
                "action": "update" if framework_id else "create",
                "framework_id": framework_id,
                "payload": framework_payload,
            },
            "domains": planned_domains,
            "controls": planned_controls,
            "summary": {
                "domains": len(planned_domains),
                "controls": len(planned_controls),
            },
        }

    if framework_id:
        await tables.update(TABLE_FRAMEWORKS, framework_id, framework_payload)
        framework = await _get_row(TABLE_FRAMEWORKS, framework_id)
    else:
        framework = _doc_to_row(await tables.insert(TABLE_FRAMEWORKS, framework_payload))
        framework_id = framework.get("id")

    created_domains: list[dict[str, Any]] = []
    domain_id_by_index: dict[int, str] = {}
    for index, planned in enumerate(planned_domains, start=1):
        payload = dict(planned["payload"])
        payload["framework_id"] = framework_id
        if planned.get("domain_id"):
            await tables.update(TABLE_DOMAINS, planned["domain_id"], payload)
            domain_row = await _get_row(TABLE_DOMAINS, planned["domain_id"])
            action = "update"
        else:
            domain_row = _doc_to_row(await tables.insert(TABLE_DOMAINS, payload))
            action = "create"
        domain_id_by_index[index] = domain_row.get("id")
        created_domains.append({"action": action, "domain": domain_row})

    created_controls: list[dict[str, Any]] = []
    for planned in planned_controls:
        payload = dict(planned["payload"])
        payload["framework_id"] = framework_id
        payload["domain_id"] = domain_id_by_index.get(planned["domain_index"], payload.get("domain_id"))
        if planned.get("control_id"):
            await tables.update(TABLE_CONTROLS, planned["control_id"], payload)
            control_row = await _get_row(TABLE_CONTROLS, planned["control_id"])
            action = "update"
        else:
            control_row = _doc_to_row(await tables.insert(TABLE_CONTROLS, payload))
            action = "create"
        created_controls.append({"action": action, "control": control_row})

    return {
        "mode": "apply",
        "framework": framework,
        "domains": created_domains,
        "controls": created_controls,
        "summary": {
            "domains": len(created_domains),
            "controls": len(created_controls),
        },
    }


@workflow(
    name="bifrost_grc_create_assessment",
    description=(
        "Create a Bifrost GRC assessment from a framework and seed assessment-control rows "
        "for active reference controls before assessment execution."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_create_assessment(
    bifrost_organization_id: str,
    framework_id: str,
    name: str | None = None,
    assigned_to: str | None = None,
    additional_organization_ids: list[str] | None = None,
    apply_to_all: bool = False,
    seed_controls: bool = True,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "creating an assessment")
    owner_id = _provider_owner_id()
    if not framework_id:
        raise UserError("framework_id is required")
    framework = await _get_row(TABLE_FRAMEWORKS, framework_id)
    if not framework:
        raise UserError(f"Framework not found: {framework_id}")

    controls = []
    if seed_controls:
        controls = [
            row
            for row in await _query_rows(TABLE_CONTROLS, {"framework_id": framework_id, "is_active": True}, limit=1000)
            if row.get("id")
    ]
    assessment_name = name or framework.get("name") or "New assessment"
    scope = _requested_scope(bifrost_organization_id, additional_organization_ids, apply_to_all)
    row_organization_id = None if apply_to_all else bifrost_organization_id
    payload = _clean_payload(
        {
            "organization_id": row_organization_id,
            **scope,
            "framework_id": framework_id,
            "name": assessment_name,
            "status": "draft",
            "progress_percentage": 0,
            "assigned_to": assigned_to,
        }
    )
    seed_rows = [
        {
            "organization_id": row_organization_id,
            "assessment_id": "<created_assessment_id>",
            "control_id": control.get("id"),
            "status": "not_assessed",
            "implementation_percentage": 0,
            "notes": None,
            "assessed_by": None,
            "assessed_at": None,
        }
        for control in controls
    ]
    if not apply:
        return {
            "mode": "dry_run",
            "framework": {
                "id": framework.get("id"),
                "name": framework.get("name"),
                "version": framework.get("version"),
            },
            "assessment": payload,
            "seed_controls": seed_controls,
            "seed_assessment_controls": seed_rows,
            "summary": {
                "active_controls_found": len(controls),
                "assessment_controls_to_create": len(seed_rows),
            },
        }

    assessment = _doc_to_row(await tables.insert(TABLE_ASSESSMENTS, payload))
    assessment_id = assessment.get("id")
    created_controls = []
    for seed in seed_rows:
        seed_payload = dict(seed)
        seed_payload["assessment_id"] = assessment_id
        created_controls.append(_doc_to_row(await tables.insert(TABLE_ASSESSMENT_CONTROLS, seed_payload)))

    return {
        "mode": "apply",
        "assessment": assessment,
        "assessment_controls": created_controls,
        "summary": {
            "assessment_controls_created": len(created_controls),
        },
    }


@workflow(
    name="bifrost_grc_fill_assessment_from_mappings",
    description=(
        "Fill Bifrost GRC assessment controls from existing mapped customer applied controls, "
        "preferring reviewed mappings and summarizing linked evidence, policies, and exceptions."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_fill_assessment_from_mappings(
    bifrost_organization_id: str,
    assessment_id: str,
    control_ids: list[str] | None = None,
    mapping_statuses: list[str] | None = None,
    include_suggested: bool = False,
    overwrite_existing: bool = False,
    apply: bool = False,
    confirm_apply: bool = False,
    max_controls: int | None = None,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "filling assessment controls from applied-control mappings")
    owner_id = _provider_owner_id()
    if not assessment_id:
        raise UserError("assessment_id is required")

    assessment = await _get_row(TABLE_ASSESSMENTS, assessment_id)
    if not assessment:
        raise UserError(f"Assessment not found: {assessment_id}")
    if (
        assessment.get("organization_id") not in {None, owner_id, bifrost_organization_id}
        or not applies_to_organization(assessment, bifrost_organization_id)
    ):
        raise UserError("Assessment belongs to a different customer or does not apply here.")

    selected_statuses = set(mapping_statuses or sorted(FILL_MAPPING_STATUSES))
    if include_suggested:
        selected_statuses.add("suggested")
    invalid_statuses = selected_statuses - MAPPING_STATUSES
    if invalid_statuses:
        raise UserError(f"mapping_statuses contains unsupported values: {', '.join(sorted(invalid_statuses))}")

    requested_controls = set(control_ids or [])
    assessment_controls = await _query_rows(
        TABLE_ASSESSMENT_CONTROLS,
        {"assessment_id": assessment_id},
        limit=1000,
    )
    if requested_controls:
        assessment_controls = [
            row for row in assessment_controls if row.get("control_id") in requested_controls or row.get("id") in requested_controls
        ]
    if max_controls is not None:
        assessment_controls = assessment_controls[: max(0, min(max_controls, 1000))]

    mappings = [
        row
        for row in await _query_rows(
            TABLE_CONTROL_MAPPINGS,
            {},
            limit=1000,
        )
        if row.get("status") in selected_statuses and applies_to_organization(row, bifrost_organization_id)
    ]
    applied_controls = {
        row.get("id"): row
        for row in await _query_rows(
            TABLE_APPLIED_CONTROLS,
            {},
            limit=1000,
        )
        if row.get("id") and applies_to_organization(row, bifrost_organization_id)
    }

    mappings_by_control: dict[str, list[dict[str, Any]]] = {}
    for mapping in mappings:
        control_id = mapping.get("control_id")
        applied_control_id = mapping.get("applied_control_id")
        if not control_id or not applied_control_id or applied_control_id not in applied_controls:
            continue
        mappings_by_control.setdefault(control_id, []).append(mapping)

    evidence_links = [row for row in await _query_rows(TABLE_EVIDENCE_LINKS, {}, limit=1000) if applies_to_organization(row, bifrost_organization_id)]
    policy_links = [row for row in await _query_rows(TABLE_POLICY_LINKS, {}, limit=1000) if applies_to_organization(row, bifrost_organization_id)]
    exception_links = [row for row in await _query_rows(TABLE_EXCEPTION_LINKS, {}, limit=1000) if applies_to_organization(row, bifrost_organization_id)]
    evidence_rows = {row.get("id"): row for row in await _query_rows(TABLE_EVIDENCE, {}, limit=1000) if row.get("id") and applies_to_organization(row, bifrost_organization_id)}
    policy_rows = {row.get("id"): row for row in await _query_rows(TABLE_POLICIES, {}, limit=1000) if row.get("id") and applies_to_organization(row, bifrost_organization_id)}
    exception_rows = {row.get("id"): row for row in await _query_rows(TABLE_EXCEPTIONS, {}, limit=1000) if row.get("id") and applies_to_organization(row, bifrost_organization_id)}

    def linked_names(
        links: list[dict[str, Any]],
        link_id_key: str,
        rows: dict[str, dict[str, Any]],
        applied_control_id: str,
    ) -> list[str]:
        names: list[str] = []
        for link in links:
            if link.get("target_type") != "applied_control" or link.get("target_id") != applied_control_id:
                continue
            linked = rows.get(link.get(link_id_key))
            if not linked:
                continue
            names.append(str(linked.get("name") or linked.get("title") or linked.get("reason") or linked.get("id")))
        return names[:10]

    planned_updates: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for assessment_control in assessment_controls:
        control_id = assessment_control.get("control_id")
        assessment_control_id = assessment_control.get("id")
        if not control_id or not assessment_control_id:
            skipped.append({"assessment_control_id": assessment_control_id, "control_id": control_id, "reason": "missing control_id or row id"})
            continue
        candidates = mappings_by_control.get(control_id, [])
        if not candidates:
            skipped.append({"assessment_control_id": assessment_control_id, "control_id": control_id, "reason": "no eligible applied-control mapping"})
            continue
        ranked = sorted(
            candidates,
            key=lambda mapping: _mapping_rank(mapping, applied_controls.get(mapping.get("applied_control_id"), {})),
            reverse=True,
        )
        mapping = ranked[0]
        applied_control = applied_controls[mapping["applied_control_id"]]
        next_status, implementation, status_reason = _assessment_fill_status(applied_control, mapping)
        if not overwrite_existing and assessment_control.get("status") not in (None, "", "not_assessed"):
            skipped.append(
                {
                    "assessment_control_id": assessment_control_id,
                    "control_id": control_id,
                    "reason": "assessment control already has a status",
                    "current_status": assessment_control.get("status"),
                    "candidate_status": next_status,
                    "applied_control_id": applied_control.get("id"),
                }
            )
            continue

        evidence_names = linked_names(evidence_links, "evidence_id", evidence_rows, applied_control["id"])
        policy_names = linked_names(policy_links, "policy_id", policy_rows, applied_control["id"])
        exception_names = linked_names(exception_links, "exception_id", exception_rows, applied_control["id"])
        note_parts = [
            str(assessment_control.get("notes") or "").strip() if overwrite_existing else "",
            f"Filled from applied control: {applied_control.get('name') or applied_control.get('id')}.",
            f"Decision: {next_status} ({implementation}%). Reason: {status_reason}.",
            applied_control.get("description") and f"Implementation: {applied_control.get('description')}",
            (
                "Mapping: "
                f"{mapping.get('relationship') or 'supports'} / {mapping.get('status') or 'unknown'}"
                f" / confidence {mapping.get('confidence') if mapping.get('confidence') is not None else 'unknown'}."
            ),
            mapping.get("rationale") and f"Mapping rationale: {mapping.get('rationale')}",
            evidence_names and "Linked applied-control evidence: " + "; ".join(evidence_names),
            policy_names and "Linked applied-control policies: " + "; ".join(policy_names),
            exception_names and "Linked applied-control exceptions: " + "; ".join(exception_names),
        ]
        patch = {
            "status": next_status,
            "implementation_percentage": implementation,
            "notes": "\n\n".join(str(part) for part in note_parts if part),
            "assessed_by": "bifrost_grc_agent",
            "assessed_at": datetime.now(UTC).isoformat(),
        }
        planned_updates.append(
            {
                "assessment_control_id": assessment_control_id,
                "control_id": control_id,
                "applied_control_id": applied_control.get("id"),
                "applied_control_name": applied_control.get("name"),
                "mapping_id": mapping.get("id"),
                "mapping_relationship": mapping.get("relationship"),
                "mapping_status": mapping.get("status"),
                "mapping_confidence": mapping.get("confidence"),
                "status": next_status,
                "implementation_percentage": implementation,
                "linked_evidence_count": len(evidence_names),
                "linked_policy_count": len(policy_names),
                "linked_exception_count": len(exception_names),
                "patch": patch,
            }
        )

    applied_results = []
    if apply:
        for update in planned_updates:
            await tables.update(TABLE_ASSESSMENT_CONTROLS, update["assessment_control_id"], update["patch"])
            applied_results.append(
                {
                    "assessment_control_id": update["assessment_control_id"],
                    "control_id": update["control_id"],
                    "status": update["status"],
                    "implementation_percentage": update["implementation_percentage"],
                    "action": "update",
                }
            )

    return {
        "mode": "apply" if apply else "dry_run",
        "bifrost_organization_id": bifrost_organization_id,
        "assessment_id": assessment_id,
        "assessment_name": assessment.get("name"),
        "mapping_statuses": sorted(selected_statuses),
        "overwrite_existing": overwrite_existing,
        "summary": {
            "assessment_controls_considered": len(assessment_controls),
            "planned_updates": len(planned_updates),
            "skipped": len(skipped),
            "applied_updates": len(applied_results),
        },
        "planned_updates": planned_updates,
        "skipped": skipped,
        "applied_updates": applied_results,
    }


@workflow(
    name="bifrost_grc_manage_applied_control",
    description=(
        "Create or update a Bifrost GRC applied control that describes what a customer "
        "actually does, with optional mapping to framework reference controls."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_manage_applied_control(
    bifrost_organization_id: str,
    name: str,
    applied_control_id: str | None = None,
    description: str | None = None,
    control_type: str | None = None,
    status: str = "planned",
    maturity: str = "unknown",
    owner: str | None = None,
    review_status: str = "needs_review",
    tags: list[str] | None = None,
    source_system: str | None = "bifrost_grc_agent",
    source_id: str | None = None,
    source_url: str | None = None,
    metadata: dict[str, Any] | None = None,
    map_control_ids: list[str] | None = None,
    mapping_relationship: str = "supports",
    mapping_confidence: float = 0.5,
    mapping_status: str = "suggested",
    mapping_rationale: str | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "creating or updating an applied control")
    owner_id = _provider_owner_id()
    if not name:
        raise UserError("name is required")
    if status not in APPLIED_CONTROL_STATUSES:
        raise UserError(f"status must be one of: {', '.join(sorted(APPLIED_CONTROL_STATUSES))}")
    if maturity not in APPLIED_CONTROL_MATURITIES:
        raise UserError(f"maturity must be one of: {', '.join(sorted(APPLIED_CONTROL_MATURITIES))}")
    if review_status not in REVIEW_STATUSES:
        raise UserError(f"review_status must be one of: {', '.join(sorted(REVIEW_STATUSES))}")
    if mapping_relationship not in MAPPING_RELATIONSHIPS:
        raise UserError(f"mapping_relationship must be one of: {', '.join(sorted(MAPPING_RELATIONSHIPS))}")
    if mapping_status not in MAPPING_STATUSES:
        raise UserError(f"mapping_status must be one of: {', '.join(sorted(MAPPING_STATUSES))}")

    existing = await _get_row(TABLE_APPLIED_CONTROLS, applied_control_id)
    if applied_control_id and not existing:
        raise UserError(f"Applied control not found: {applied_control_id}")
    if existing and (
        existing.get("organization_id") not in {None, owner_id, bifrost_organization_id}
        or not applies_to_organization(existing, bifrost_organization_id)
    ):
        raise UserError("Applied control belongs to a different customer or does not apply here.")

    payload = _clean_payload(
        {
            "organization_id": bifrost_organization_id,
            **(_customer_scope(bifrost_organization_id) if not existing else {}),
            "name": name,
            "description": description,
            "control_type": control_type,
            "status": status,
            "maturity": maturity,
            "owner": owner,
            "review_status": review_status,
            "source_system": source_system,
            "source_id": source_id,
            "source_url": source_url,
            "tags_json": json.dumps(tags or [], separators=(",", ":")),
            "metadata_json": _stable_json(metadata),
        }
    )
    mapping_payloads = []
    for control_id in map_control_ids or []:
        await _validate_target(bifrost_organization_id, "control", control_id)
        mapping_payloads.append(
            _clean_payload(
                {
                    "organization_id": bifrost_organization_id,
                    **_customer_scope(bifrost_organization_id),
                    "applied_control_id": applied_control_id or "<created_applied_control_id>",
                    "control_id": control_id,
                    "relationship": mapping_relationship,
                    "confidence": mapping_confidence,
                    "status": mapping_status,
                    "rationale": mapping_rationale,
                    "source_system": source_system,
                    "source_id": source_id,
                    "metadata_json": _stable_json({"created_by": "bifrost_grc_manage_applied_control"}),
                }
            )
        )

    if not apply:
        return {
            "mode": "dry_run",
            "action": "update" if applied_control_id else "create",
            "applied_control": payload,
            "control_mappings": mapping_payloads,
        }

    if applied_control_id:
        await tables.update(TABLE_APPLIED_CONTROLS, applied_control_id, payload)
        applied_control = await _get_row(TABLE_APPLIED_CONTROLS, applied_control_id)
    else:
        applied_control = _doc_to_row(await tables.insert(TABLE_APPLIED_CONTROLS, payload))
        applied_control_id = applied_control.get("id")

    created_mappings = []
    for mapping_payload in mapping_payloads:
        mapping_payload["applied_control_id"] = applied_control_id
        existing_mappings = await _query_rows(
            TABLE_CONTROL_MAPPINGS,
            {
                "applied_control_id": applied_control_id,
                "control_id": mapping_payload["control_id"],
            },
            limit=10,
        )
        if existing_mappings:
            created_mappings.append({"action": "skip", "mapping": existing_mappings[0]})
            continue
        created = _doc_to_row(await tables.insert(TABLE_CONTROL_MAPPINGS, mapping_payload))
        created_mappings.append({"action": "create", "mapping": created})

    return {
        "mode": "apply",
        "applied_control": applied_control,
        "control_mappings": created_mappings,
    }


@workflow(
    name="bifrost_grc_attach_evidence",
    description=(
        "Attach Bifrost GRC evidence to applied controls, assessment controls, policies, "
        "exceptions, risks, questionnaires, or source documents, optionally creating a note/url evidence row."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_attach_evidence(
    bifrost_organization_id: str,
    target_type: str,
    target_id: str,
    evidence_id: str | None = None,
    evidence_name: str | None = None,
    evidence_type: str = "note",
    url: str | None = None,
    file_path: str | None = None,
    notes: str | None = None,
    uploaded_by: str | None = None,
    relationship: str = "supports",
    citation: str | None = None,
    source_system: str | None = "bifrost_grc_agent",
    source_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "attaching evidence")
    if uploaded_by is not None:
        raise UserError("uploaded_by is recorded from authenticated context.")
    actor_id = authenticated_actor_id(context)
    owner_id = _provider_owner_id()
    if evidence_type not in EVIDENCE_TYPES:
        raise UserError(f"evidence_type must be one of: {', '.join(sorted(EVIDENCE_TYPES))}")
    await _validate_target(bifrost_organization_id, target_type, target_id)

    evidence = await _get_row(TABLE_EVIDENCE, evidence_id)
    if evidence_id and not evidence:
        raise UserError(f"Evidence not found: {evidence_id}")
    if evidence and (
        evidence.get("organization_id") not in {None, owner_id, bifrost_organization_id}
        or not applies_to_organization(evidence, bifrost_organization_id)
    ):
        raise UserError("Evidence belongs to a different customer or does not apply here.")
    if not evidence_id and not evidence_name:
        raise UserError("evidence_name is required when evidence_id is not provided")

    evidence_payload = None
    if not evidence_id:
        evidence_payload = _clean_payload(
            {
                "organization_id": bifrost_organization_id,
                **_customer_scope(bifrost_organization_id),
                "name": evidence_name,
                "type": evidence_type,
                "url": url,
                "file_path": file_path,
                "notes": notes,
                "uploaded_by": actor_id,
            }
        )
    link_payload = _clean_payload(
        {
            "organization_id": bifrost_organization_id,
            **_customer_scope(bifrost_organization_id),
            "evidence_id": evidence_id or "<created_evidence_id>",
            "target_type": target_type,
            "target_id": target_id,
            "relationship": relationship,
            "citation": citation,
            "source_system": source_system,
            "source_id": source_id,
            "metadata_json": _stable_json(metadata),
        }
    )

    if not apply:
        return {
            "mode": "dry_run",
            "evidence": evidence or evidence_payload,
            "evidence_link": link_payload,
        }

    if not evidence_id:
        evidence = _doc_to_row(await tables.insert(TABLE_EVIDENCE, evidence_payload))
        evidence_id = evidence.get("id")

    existing_link = await _find_existing_link(
        TABLE_EVIDENCE_LINKS,
        bifrost_organization_id,
        "evidence_id",
        evidence_id,
        target_type,
        target_id,
    )
    if existing_link:
        return {"mode": "apply", "evidence": evidence, "evidence_link": existing_link, "action": "skip"}

    link_payload["evidence_id"] = evidence_id
    evidence_link = _doc_to_row(await tables.insert(TABLE_EVIDENCE_LINKS, link_payload))
    return {"mode": "apply", "evidence": evidence, "evidence_link": evidence_link, "action": "create"}


@workflow(
    name="bifrost_grc_normalize_tenant_ownership",
    description=(
        "Dry-run-first migration of legacy provider-owned GRC rows into row-level-security-compatible "
        "ownership: all-customer rows become global, single-customer rows become customer-owned, "
        "and ambiguous multi-customer or excluded scopes are skipped."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_normalize_tenant_ownership(
    include_changes: bool = False,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "normalizing GRC tenant ownership")
    provider_organization_id = _provider_owner_id()
    plan: list[dict[str, Any]] = []
    target_by_parent: dict[tuple[str, str], str | None] = {}

    for table in DIRECT_SCOPED_TABLES:
        for row in await _query_rows(table, {}, limit=1000):
            target, reason = _normalized_scope_owner(row, provider_organization_id)
            action = "skip" if reason in {"already_normalized", "ambiguous_scope"} else "update"
            plan.append(
                {
                    "table": table,
                    "id": row.get("id"),
                    "from_organization_id": row.get("organization_id"),
                    "to_organization_id": target,
                    "reason": reason,
                    "action": action,
                }
            )
            if table == TABLE_ASSESSMENTS and row.get("id"):
                target_by_parent[(TABLE_ASSESSMENTS, str(row["id"]))] = target

    # Assessment controls inherit the normalized owner from their assessment.
    for row in await _query_rows(TABLE_ASSESSMENT_CONTROLS, {}, limit=1000):
        if row.get("organization_id") != provider_organization_id:
            continue
        assessment_id = str(row.get("assessment_id") or "")
        key = (TABLE_ASSESSMENTS, assessment_id)
        if key not in target_by_parent or target_by_parent[key] == provider_organization_id:
            plan.append(
                {
                    "table": TABLE_ASSESSMENT_CONTROLS,
                    "id": row.get("id"),
                    "from_organization_id": provider_organization_id,
                    "to_organization_id": provider_organization_id,
                    "reason": "ambiguous_parent_scope",
                    "action": "skip",
                }
            )
            continue
        plan.append(
            {
                "table": TABLE_ASSESSMENT_CONTROLS,
                "id": row.get("id"),
                "from_organization_id": provider_organization_id,
                "to_organization_id": target_by_parent[key],
                "reason": "inherits_assessment_scope",
                "action": "update",
            }
        )

    if apply:
        for item in plan:
            if item["action"] != "update" or not item.get("id"):
                continue
            await tables.update(item["table"], str(item["id"]), {"organization_id": item["to_organization_id"]})

    summary = {
        "update": sum(1 for item in plan if item["action"] == "update"),
        "skip": sum(1 for item in plan if item["action"] == "skip"),
        "ambiguous": sum(1 for item in plan if str(item["reason"]).startswith("ambiguous")),
    }
    return {
        "mode": "apply" if apply else "dry_run",
        "summary": summary,
        **({"changes": plan} if include_changes else {}),
    }


@workflow(
    name="bifrost_grc_seed_standard_fact_pack",
    description="Seed or update standard facts and dormant IR/SSP addendum-template metadata. Dry-run first and confirmation-gated.",
    category="grc",
    is_tool=True,
)
async def bifrost_grc_seed_standard_fact_pack(apply: bool = False, confirm_apply: bool = False) -> dict[str, Any]:
    require_provider("Only the provider organization can maintain the global GRC fact pack.")
    _require_confirm(apply, confirm_apply, "seeding the global GRC fact pack")
    definitions = await _query_rows(TABLE_FACT_DEFINITIONS, {}, limit=1000)
    requirements = await _query_rows(TABLE_FACT_REQUIREMENTS, {}, limit=1000)
    definition_by_key = {str(row.get("key")): row for row in definitions if row.get("key")}
    requirement_by_source = {str(row.get("source_id")): row for row in requirements if row.get("source_id")}
    definition_plan = []
    for key, title, fact_type, expected_from, category, description in STANDARD_FACTS:
        payload = {
            "organization_id": None, "key": key, "title": title, "category": category,
            "description": description,
            "fact_type": fact_type, "expected_from": expected_from, "sensitivity": "normal",
            "review_frequency_days": 365, "is_active": True,
            "source_system": "bifrost_grc_standard", "source_id": key,
        }
        definition_plan.append({"action": "update" if key in definition_by_key else "create", "id": definition_by_key.get(key, {}).get("id"), "payload": payload})
    requirement_plan = []
    for target_source_id, keys in STANDARD_REQUIREMENTS.items():
        for key in keys:
            source_id = f"{target_source_id}:{key}"
            legacy_source_id = f"{LEGACY_STANDARD_REQUIREMENT_SOURCES.get(target_source_id, '')}:{key}"
            expected_from = next((item[3] for item in STANDARD_FACTS if item[0] == key), "shared")
            definition_id = definition_by_key.get(key, {}).get("id") or f"<definition:{key}>"
            payload = {
                "organization_id": None, "fact_definition_id": definition_id, "fact_key": key,
                "target_type": "policy_template", "target_source_id": target_source_id,
                "context": f"Required by {target_source_id}", "required": True, "priority": "high",
                "responsible_party": expected_from, "status": "active",
                "source_system": "bifrost_grc_standard", "source_id": source_id,
            }
            existing_requirement = requirement_by_source.get(source_id) or requirement_by_source.get(legacy_source_id)
            requirement_plan.append({"action": "update" if existing_requirement else "create", "id": (existing_requirement or {}).get("id"), "payload": payload})
    if not apply:
        return {"mode": "dry_run", "definitions": definition_plan, "requirements": requirement_plan}
    created_definitions: dict[str, str] = {}
    for item in definition_plan:
        if item["id"]:
            await tables.update(TABLE_FACT_DEFINITIONS, str(item["id"]), item["payload"])
            created_definitions[item["payload"]["key"]] = str(item["id"])
        else:
            row = _doc_to_row(await tables.insert(TABLE_FACT_DEFINITIONS, item["payload"]))
            created_definitions[item["payload"]["key"]] = str(row.get("id"))
    for item in requirement_plan:
        item["payload"]["fact_definition_id"] = created_definitions[item["payload"]["fact_key"]]
        if item["id"]:
            await tables.update(TABLE_FACT_REQUIREMENTS, str(item["id"]), item["payload"])
        else:
            await tables.insert(TABLE_FACT_REQUIREMENTS, item["payload"])
    return {"mode": "apply", "definition_count": len(definition_plan), "requirement_count": len(requirement_plan)}


@workflow(
    name="bifrost_grc_get_fact_workspace",
    description="Read the complete paginated fact definitions, requirements, and visible fact values for the GRC Open Items workspace.",
    category="grc",
)
async def bifrost_grc_get_fact_workspace(bifrost_organization_id: str | None = None) -> dict[str, Any]:
    target = str(bifrost_organization_id or "").strip()
    if target:
        # Provider reads stay in provider scope and are filtered by the
        # effective-fact resolver. Mutating the execution scope here can make
        # a later portfolio read inherit the selected customer.
        if is_platform_scope():
            require_provider()
        else:
            bind_organization_scope(target, resource="GRC fact workspace")
    elif is_platform_scope():
        require_provider()
    else:
        target = str(caller_organization_id() or "").strip()
        if not target:
            raise UserError("Your organization could not be resolved.")
        bind_organization_scope(target, resource="GRC fact workspace")
    definitions, requirements, facts, policies = await asyncio.gather(
        _query_all_rows(TABLE_FACT_DEFINITIONS, {}),
        _query_all_rows(TABLE_FACT_REQUIREMENTS, {}),
        _query_all_rows(TABLE_FACTS, {}),
        _query_all_rows(TABLE_POLICIES, {}),
    )
    return {
        "mode": "read_only",
        "bifrost_organization_id": target or None,
        "definitions": definitions,
        "requirements": requirements,
        "facts": facts,
        "policies": policies,
    }


@workflow(
    name="bifrost_grc_get_open_items",
    description=(
        "Read normalized GRC open items for one customer or a provider portfolio, with "
        "paging, counts, and a legacy fact-workspace payload for compatibility."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_get_open_items(
    bifrost_organization_id: str | None = None,
    perspective: str | None = None,
    cursor: str | None = None,
    page_size: int = 50,
    include_complete: bool = False,
) -> dict[str, Any]:
    return await _build_open_items_feed(
        bifrost_organization_id,
        perspective=perspective,
        cursor=cursor,
        page_size=page_size,
        include_complete=include_complete,
    )


@workflow(
    name="bifrost_grc_count_open_items",
    description="Return Open Items counts only for the current customer or provider portfolio.",
    category="grc",
    is_tool=True,
)
async def bifrost_grc_count_open_items(bifrost_organization_id: str | None = None) -> dict[str, Any]:
    result = await _build_open_items_feed(bifrost_organization_id, page_size=1)
    return {
        "mode": "read_only",
        "bifrost_organization_id": result.get("bifrost_organization_id"),
        "portfolio_mode": result.get("portfolio_mode"),
        "counts": result.get("counts", {}),
        "total_count": result.get("total_count", 0),
    }


@workflow(
    name="bifrost_grc_resolve_open_item",
    description="Apply one safe source-aware Open Item action and append change history. Confirmation-gated.",
    category="grc",
)
async def bifrost_grc_resolve_open_item(
    item_kind: str,
    source_id: str,
    resolution: str,
    bifrost_organization_id: str | None = None,
    notes: str | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, f"{resolution} for {item_kind}:{source_id}")
    authenticated_actor_id(context)
    if bifrost_organization_id:
        bind_organization_scope(bifrost_organization_id, resource="GRC open item")
    else:
        require_provider("Provider access is required to resolve a provider-level Open Item.")

    source_by_kind = {
        "manual_finding": TABLE_FINDINGS,
        "questionnaire_finding": TABLE_QUESTIONNAIRE_RECOMMENDATIONS,
        "policy_review": TABLE_POLICIES,
        "evidence_review": TABLE_EVIDENCE,
        "applied_control_review": TABLE_APPLIED_CONTROLS,
    }
    table = source_by_kind.get(item_kind)
    if not table:
        raise UserError("This Open Item must be resolved from its source record.")
    existing = await _get_row(table, source_id)
    if not existing:
        raise UserError(f"Source record not found: {table}:{source_id}")
    row_organization_id = str(existing.get("organization_id") or "") or None
    if row_organization_id is None:
        require_provider("Provider access is required to change a global Open Item.")
    if bifrost_organization_id and row_organization_id not in {None, bifrost_organization_id}:
        raise UserError("The Open Item belongs to a different organization.")

    now = datetime.now(UTC)
    payload: dict[str, Any]
    if item_kind == "manual_finding":
        if resolution not in {"resolved", "accepted", "dismissed"}:
            raise UserError("Manual findings support resolved, accepted, or dismissed.")
        actor_id = authenticated_actor_id(context)
        payload = {
            "status": resolution,
            "resolution_notes": notes,
            "resolved_at": now.isoformat(),
            "resolved_by": actor_id,
        }
    elif item_kind == "questionnaire_finding":
        if resolution not in {"resolved", "dismissed"}:
            raise UserError("Questionnaire findings support resolved or dismissed.")
        actor_id = authenticated_actor_id(context)
        payload = {
            "status": "done" if resolution == "resolved" else "dismissed",
            "completed_at": now.isoformat(),
            "completed_by": actor_id,
            "completion_notes": notes,
        }
    elif item_kind == "policy_review":
        if resolution != "reviewed":
            raise UserError("Policy review items support reviewed.")
        frequency = max(1, int(existing.get("review_frequency_days") or 365))
        payload = {
            "last_reviewed_at": now.isoformat(),
            "review_date": (now + timedelta(days=frequency)).date().isoformat(),
        }
        if existing.get("policy_role") == "extension" and existing.get("base_policy_id"):
            base = await _get_row(TABLE_POLICIES, str(existing["base_policy_id"]))
            if base and base.get("version"):
                payload["reviewed_base_version"] = str(base["version"])
    elif item_kind == "evidence_review":
        if resolution != "reviewed":
            raise UserError("Evidence review items support reviewed.")
        frequency = max(1, int(existing.get("review_frequency_days") or 365))
        payload = {
            "review_status": "approved",
            "last_reviewed_at": now.isoformat(),
            "review_due": (now + timedelta(days=frequency)).date().isoformat(),
        }
    else:
        if resolution != "reviewed":
            raise UserError("Applied control review items support reviewed.")
        payload = {"review_status": "approved", "last_reviewed_at": now.isoformat()}

    result = {
        "mode": "apply" if apply else "dry_run",
        "item_kind": item_kind,
        "source_table": table,
        "source_id": source_id,
        "resolution": resolution,
        "before": existing,
        "changes": payload,
    }
    if not apply:
        return result
    await tables.update(table, source_id, payload)
    updated = await _get_row(table, source_id) or {**existing, **payload}
    await _record_change(
        entity_type=table,
        entity_id=source_id,
        event_type=resolution,
        organization_id=row_organization_id,
        before=existing,
        after=updated,
        reason=notes,
        source_system="bifrost_grc_open_items",
    )
    result["record"] = updated
    return result


@workflow(
    name="bifrost_grc_manage_fact",
    description=(
        "Propose, create, or update a GRC fact for One, Some, or All customers. "
        "Fact scope is independent of the policy or assessment that references it. "
        "Every write is confirmation-gated."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_manage_fact(
    bifrost_organization_id: str, fact_key: str, value: Any = None,
    status: str = "proposed", source_system: str | None = None, source_id: str | None = None,
    source_url: str | None = None, confidence: float | None = None, notes: str | None = None,
    verified_by: str | None = None, scope_mode: str = "one",
    organization_ids: list[str] | None = None, scope_id: str | None = None,
    apply: bool = False, confirm_apply: bool = False,
) -> dict[str, Any]:
    if scope_mode not in {"one", "some", "all"}:
        raise UserError("scope_mode must be one, some, or all.")
    requested_ids = sorted({str(item) for item in (organization_ids or []) if item})
    if scope_mode == "all":
        require_provider("Only Platform Org users can manage an All-customer fact.")
        target_ids: list[str] = []
    elif scope_mode == "some":
        require_provider("Only Platform Org users can manage a Some-customer fact.")
        if len(requested_ids) < 2:
            raise UserError("Some requires at least two organizations.")
        target_ids = requested_ids
    else:
        target_ids = requested_ids or [bifrost_organization_id]
        if len(target_ids) != 1:
            raise UserError("One requires exactly one organization.")
    bind_organization_scope(target_ids[0] if target_ids else bifrost_organization_id, resource="GRC fact")
    _require_confirm(apply, confirm_apply, "creating or updating a GRC fact")
    if status not in FACT_STATUSES:
        raise UserError(f"status must be one of: {', '.join(sorted(FACT_STATUSES))}")
    definitions = await _query_rows(TABLE_FACT_DEFINITIONS, {"key": fact_key}, limit=10)
    if not definitions:
        raise UserError(f"Unknown fact_key: {fact_key}. Seed or create its fact definition first.")
    all_rows = await _query_all_rows(TABLE_FACTS, {"fact_key": fact_key})
    existing_group = [row for row in all_rows if scope_id and str(row.get("scope_id") or "") == scope_id]
    # Legacy one-customer facts predate logical scope IDs. The UI may send the
    # row ID when promoting one of those facts to a wider scope so the original
    # row is migrated instead of surviving as a narrower override.
    if scope_id and not existing_group:
        existing_group = [
            row for row in all_rows
            if str(row.get("id") or "") == scope_id and not row.get("scope_id")
        ]
    if scope_id and not existing_group:
        raise UserError("The selected fact scope no longer exists.")
    if not scope_id:
        if scope_mode == "all":
            existing_group = [row for row in all_rows if row.get("scope_kind") == "all" or row.get("organization_id") is None]
        elif scope_mode == "one":
            target = target_ids[0]
            existing_group = [
                row for row in all_rows
                if row.get("organization_id") == target
                and row.get("scope_kind") in (None, "one")
                and not row.get("scope_id")
            ]
            if not existing_group:
                existing_group = [
                    row for row in all_rows
                    if row.get("organization_id") == target and row.get("scope_kind") == "one"
                ][:1]
        else:
            matching_groups: dict[str, list[dict[str, Any]]] = {}
            for row in all_rows:
                if row.get("scope_kind") == "some" and row.get("scope_id"):
                    matching_groups.setdefault(str(row["scope_id"]), []).append(row)
            existing_group = next((rows for rows in matching_groups.values() if sorted(str(row.get("organization_id")) for row in rows) == target_ids), [])

    logical_scope_id = scope_id or (str(existing_group[0].get("scope_id") or "") if existing_group else "")
    if not logical_scope_id:
        scope_token = "all" if scope_mode == "all" else ",".join(target_ids)
        logical_scope_id = str(uuid5(NAMESPACE_URL, f"bifrost-grc:fact:{fact_key}:{scope_mode}:{scope_token}"))
    desired_orgs: list[str | None] = [None] if scope_mode == "all" else target_ids
    existing_by_org = {row.get("organization_id"): row for row in existing_group}
    changes: list[dict[str, Any]] = []
    for target_org in desired_orgs:
        existing = existing_by_org.get(target_org)
        payload = _clean_payload({
            "organization_id": target_org,
            "applied_organizations": None if scope_mode == "all" else [target_org],
            "excluded_organizations": [],
            "scope_id": logical_scope_id,
            "scope_kind": scope_mode,
            "scope_size": None if scope_mode == "all" else len(target_ids),
            "fact_definition_id": definitions[0].get("id"), "fact_key": fact_key,
            "value_json": _stable_json(value), "status": status, "source_system": source_system,
            "source_id": source_id, "source_url": source_url, "confidence": confidence, "notes": notes,
            "verified_by": verified_by if status == "verified" else None,
            "verified_at": datetime.now(UTC).isoformat() if status == "verified" and verified_by else None,
            "revision": int(existing.get("revision") or 0) + 1 if existing else 1,
        })
        changes.append({"action": "update" if existing else "create", "fact_id": existing.get("id") if existing else None, "payload": payload})
    for row in existing_group:
        if row.get("organization_id") not in desired_orgs:
            changes.append({"action": "delete", "fact_id": row.get("id")})
    result = {"mode": "dry_run", "scope_id": logical_scope_id, "scope_mode": scope_mode, "organization_ids": target_ids or None, "changes": changes}
    if not apply:
        return result
    saved: list[dict[str, Any]] = []
    for change in changes:
        if change["action"] == "delete":
            before_row = next((row for row in existing_group if str(row.get("id")) == str(change["fact_id"])), None)
            await tables.delete_document(TABLE_FACTS, str(change["fact_id"]))
            await _record_change(
                entity_type=TABLE_FACTS,
                entity_id=str(change["fact_id"]),
                event_type="delete",
                organization_id=(before_row or {}).get("organization_id") or (target_ids[0] if target_ids else bifrost_organization_id),
                before=before_row,
                after=None,
                source_system=(before_row or {}).get("source_system"),
            )
        elif change["action"] == "update":
            before_row = next((row for row in all_rows if str(row.get("id")) == str(change["fact_id"])), None)
            await tables.update(TABLE_FACTS, str(change["fact_id"]), change["payload"])
            updated_row = await _get_row(TABLE_FACTS, str(change["fact_id"])) or {}
            saved.append(updated_row)
            await _record_change(
                entity_type=TABLE_FACTS,
                entity_id=str(change["fact_id"]),
                event_type="update",
                organization_id=updated_row.get("organization_id") or (before_row or {}).get("organization_id") or (target_ids[0] if target_ids else bifrost_organization_id),
                before=before_row,
                after=updated_row,
                source_system=updated_row.get("source_system") or (before_row or {}).get("source_system"),
            )
        else:
            created_row = _doc_to_row(await tables.insert(TABLE_FACTS, change["payload"]))
            saved.append(created_row)
            await _record_change(
                entity_type=TABLE_FACTS,
                entity_id=str(created_row.get("id") or ""),
                event_type="create",
                organization_id=created_row.get("organization_id") or (target_ids[0] if target_ids else bifrost_organization_id),
                before=None,
                after=created_row,
                source_system=created_row.get("source_system"),
            )
    return {**result, "mode": "apply", "facts": saved}


@workflow(
    name="bifrost_grc_snapshot_policy_facts",
    description="Resolve all inline facts for a customer policy and optionally capture their revisions as the approval snapshot. Confirmation-gated when writing.",
    category="grc",
    is_tool=True,
)
async def bifrost_grc_snapshot_policy_facts(
    bifrost_organization_id: str, policy_id: str, apply: bool = False, confirm_apply: bool = False,
) -> dict[str, Any]:
    bind_organization_scope(bifrost_organization_id, resource="GRC policy fact snapshot")
    _require_confirm(apply, confirm_apply, "capturing a policy fact snapshot")
    policy = await _get_row(TABLE_POLICIES, policy_id)
    if not policy or not applies_to_organization(policy, bifrost_organization_id):
        raise UserError("Policy not found or does not apply to this customer.")
    definitions, facts, conflicts = await _resolved_facts(bifrost_organization_id)
    base = await _get_row(TABLE_POLICIES, str(policy.get("base_policy_id") or ""))
    content = _effective_policy_content(base, policy) if base else str(policy.get("content") or "")
    keys = _fact_marker_keys(content)
    snapshot = {
        key: {
            "value": _json_loads(facts.get(key, {}).get("value_json"), None),
            "status": "scope_conflict" if key in conflicts else facts.get(key, {}).get("status", "unanswered"),
            "revision": facts.get(key, {}).get("revision", 0),
            "scope_id": facts.get(key, {}).get("scope_id"),
        }
        for key in keys
    }
    unresolved = [key for key, value in snapshot.items() if value["value"] in (None, "") or value["status"] == "scope_conflict"]
    existing_rows = await _query_rows(TABLE_POLICY_FACT_SNAPSHOTS, {"organization_id": bifrost_organization_id, "policy_id": policy_id}, limit=10)
    existing = existing_rows[0] if existing_rows else None
    result = {"mode": "dry_run", "policy_id": policy_id, "snapshot_id": existing.get("id") if existing else None, "snapshot": snapshot, "unresolved_fact_keys": unresolved}
    if apply:
        captured_at = datetime.now(UTC).isoformat()
        payload = {
            "organization_id": bifrost_organization_id, "policy_id": policy_id,
            "effective_policy_id": policy_id, "policy_version": policy.get("version"),
            "base_version": base.get("version") if base else None,
            "snapshot_json": _stable_json(snapshot), "captured_at": captured_at,
        }
        if existing:
            await tables.update(TABLE_POLICY_FACT_SNAPSHOTS, str(existing["id"]), payload)
        else:
            created = _doc_to_row(await tables.insert(TABLE_POLICY_FACT_SNAPSHOTS, payload))
            result["snapshot_id"] = created.get("id")
        result.update({"mode": "apply", "fact_snapshot_at": captured_at})
    return result


@workflow(
    name="bifrost_grc_get_effective_policies",
    description=(
        "Read the effective policy set for one customer, resolving customer extensions "
        "against their global base policies and flagging extensions reviewed against an older base version."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_get_effective_policies(
    bifrost_organization_id: str,
    policy_type: str | None = None,
    include_content: bool = True,
) -> dict[str, Any]:
    bind_organization_scope(bifrost_organization_id, resource="GRC policy view")
    if policy_type and policy_type not in POLICY_TYPES:
        raise UserError(f"Unsupported policy_type: {policy_type}")

    fact_definitions, organization_facts, fact_conflicts = await _resolved_facts(bifrost_organization_id)

    rows = await _query_rows(TABLE_POLICIES, {}, limit=1000)
    applicable = [
        row for row in rows
        if applies_to_organization(row, bifrost_organization_id)
        and (not policy_type or str(row.get("policy_type") or "policy") == policy_type)
        and row.get("status") != "archived"
    ]
    by_id = {str(row.get("id")): row for row in rows if row.get("id")}
    extensions_by_base = {
        str(row.get("base_policy_id")): row
        for row in applicable
        if row.get("policy_role") == "extension" and row.get("base_policy_id")
    }

    effective: list[dict[str, Any]] = []
    consumed_extensions: set[str] = set()
    for row in applicable:
        row_id = str(row.get("id") or "")
        if row.get("policy_role") == "extension":
            continue
        extension = extensions_by_base.get(row_id)
        if extension:
            consumed_extensions.add(str(extension.get("id") or ""))
            effective.append(
                {
                    "policy_id": extension.get("id"),
                    "name": extension.get("name"),
                    "policy_type": extension.get("policy_type") or row.get("policy_type") or "policy",
                    "status": extension.get("status"),
                    "version": extension.get("version"),
                    "base_policy_id": row_id,
                    "base_name": row.get("name"),
                    "base_version": row.get("version"),
                    "reviewed_base_version": extension.get("reviewed_base_version"),
                    "base_changed_since_review": bool(
                        extension.get("reviewed_base_version")
                        and str(extension.get("reviewed_base_version")) != str(row.get("version") or "")
                    ),
                    "review_date": extension.get("review_date"),
                    "owner": extension.get("owner"),
                    **({"content": _effective_policy_content(row, extension)} if include_content else {}),
                }
            )
        else:
            effective.append(
                {
                    "policy_id": row_id,
                    "name": row.get("name"),
                    "policy_type": row.get("policy_type") or "policy",
                    "status": row.get("status"),
                    "version": row.get("version"),
                    "base_policy_id": None,
                    "review_date": row.get("review_date"),
                    "owner": row.get("owner"),
                    **({"content": row.get("content") or ""} if include_content else {}),
                }
            )

    for extension in applicable:
        extension_id = str(extension.get("id") or "")
        if extension.get("policy_role") != "extension" or extension_id in consumed_extensions:
            continue
        base = by_id.get(str(extension.get("base_policy_id") or ""))
        effective.append(
            {
                "policy_id": extension_id,
                "name": extension.get("name"),
                "policy_type": extension.get("policy_type") or "policy",
                "status": extension.get("status"),
                "version": extension.get("version"),
                "base_policy_id": extension.get("base_policy_id"),
                "base_missing": base is None,
                "review_date": extension.get("review_date"),
                "owner": extension.get("owner"),
                **({"content": _effective_policy_content(base, extension) if base else extension.get("content") or ""} if include_content else {}),
            }
        )

    if include_content:
        for item in effective:
            resolved, unresolved = _resolve_fact_markers(str(item.get("content") or ""), fact_definitions, organization_facts)
            item["content"] = resolved
            item["unresolved_fact_keys"] = unresolved
            item["open_item_count"] = len(unresolved)
            item["fact_scope_conflicts"] = sorted(key for key in unresolved if key in fact_conflicts)

    return {
        "mode": "read_only",
        "bifrost_organization_id": bifrost_organization_id,
        "count": len(effective),
        "effective_policies": effective,
    }


@workflow(
    name="bifrost_grc_manage_policy",
    description=(
        "Confirm-gated creation or update of standalone policies, reusable global base policies, "
        "and templated single-customer extensions with source provenance and base-version review tracking."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_manage_policy(
    name: str,
    bifrost_organization_id: str | None = None,
    policy_id: str | None = None,
    template_id: str | None = None,
    policy_type: str = "policy",
    policy_role: str = "standalone",
    base_policy_id: str | None = None,
    extension_mode: str = "supplement",
    content: str | None = None,
    description: str | None = None,
    version: str = "1.0",
    status: str = "draft",
    owner: str | None = None,
    review_date: str | None = None,
    approved_by: str | None = None,
    approved_at: str | None = None,
    source_system: str | None = None,
    source_id: str | None = None,
    source_url: str | None = None,
    apply_to_all: bool = False,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "creating or updating a policy")
    if approved_by is not None or approved_at is not None:
        raise UserError("Policy approval attribution is recorded from authenticated context.")
    _provider_owner_id()
    if not name.strip():
        raise UserError("name is required")
    if policy_type not in POLICY_TYPES:
        raise UserError(f"Unsupported policy_type: {policy_type}")
    if policy_role not in POLICY_ROLES:
        raise UserError(f"Unsupported policy_role: {policy_role}")
    if extension_mode not in POLICY_EXTENSION_MODES:
        raise UserError(f"Unsupported extension_mode: {extension_mode}")
    if status not in POLICY_STATUSES:
        raise UserError(f"Unsupported status: {status}")
    if policy_role == "base" and not apply_to_all:
        raise UserError("A base policy must apply_to_all=true.")
    if policy_role == "extension" and (not bifrost_organization_id or not base_policy_id):
        raise UserError("A customer extension requires bifrost_organization_id and base_policy_id.")
    if policy_role == "extension" and apply_to_all:
        raise UserError("A customer extension cannot apply to all organizations.")
    if not apply_to_all and not bifrost_organization_id:
        raise UserError("bifrost_organization_id is required unless apply_to_all=true.")

    template = await _get_row(TABLE_POLICY_TEMPLATES, template_id)
    if template_id and not template:
        raise UserError(f"Policy template not found: {template_id}")
    if template and content is None:
        content = str(template.get("content") or "")

    base: dict[str, Any] | None = None
    if base_policy_id:
        base = await _get_row(TABLE_POLICIES, base_policy_id)
        if not base:
            raise UserError(f"Base policy not found: {base_policy_id}")
        if str(base.get("policy_role") or "standalone") != "base":
            raise UserError("base_policy_id must reference a policy whose policy_role is base.")
        if base.get("applied_organizations") is not None:
            raise UserError("The referenced base policy is not global.")
        if policy_role == "extension" and not str(content or "").strip() and not template:
            raise UserError("Provide content or select an editable policy template for this customer addendum.")

    existing = await _get_row(TABLE_POLICIES, policy_id)
    if policy_id and not existing:
        raise UserError(f"Policy not found: {policy_id}")
    if not policy_id:
        candidates = await _query_rows(TABLE_POLICIES, {}, limit=1000)
        if source_system and source_id:
            existing = next(
                (
                    row for row in candidates
                    if row.get("source_system") == source_system and row.get("source_id") == source_id
                ),
                None,
            )
        if not existing and policy_role == "extension" and base_policy_id and bifrost_organization_id:
            existing = next(
                (
                    row for row in candidates
                    if row.get("policy_role") == "extension"
                    and row.get("base_policy_id") == base_policy_id
                    and applies_to_organization(row, bifrost_organization_id)
                ),
                None,
            )
    allowed_owner_ids = {None, bifrost_organization_id}
    if existing and existing.get("organization_id") not in allowed_owner_ids:
        raise UserError("The policy belongs to a different customer scope.")

    scope = {"applied_organizations": None, "excluded_organizations": []} if apply_to_all else _customer_scope(str(bifrost_organization_id))
    payload = _clean_payload(
        {
            # Policy row ownership follows its audience so tenant table policies
            # can expose global bases (NULL) and customer extensions (customer id).
            "organization_id": None if apply_to_all else bifrost_organization_id,
            **scope,
            "name": name.strip(),
            "description": description,
            "content": content,
            "version": version,
            "status": status,
            "policy_type": policy_type,
            "policy_role": policy_role,
            "base_policy_id": base_policy_id,
            "extension_mode": extension_mode if policy_role == "extension" else None,
            "reviewed_base_version": str(base.get("version") or "") if base else None,
            "owner": owner,
            "review_date": review_date,
            "source_system": source_system,
            "source_id": source_id,
            "source_url": source_url,
            "template_id": str(template.get("id")) if template else None,
            "template_version": str(template.get("version") or "") if template else None,
        }
    )
    payload["organization_id"] = None if apply_to_all else bifrost_organization_id
    payload["applied_organizations"] = None if apply_to_all else [bifrost_organization_id]
    payload = attributed_payload(TABLE_POLICIES, payload, existing, execution_context=context)
    action = "update" if existing else "create"
    if not apply:
        return {"mode": "dry_run", "action": action, "policy_id": policy_id, "policy": payload, "base_policy": base, "template": template}

    if existing:
        await tables.update(TABLE_POLICIES, str(existing["id"]), payload)
        policy = await _get_row(TABLE_POLICIES, str(existing["id"])) or {"id": existing["id"], **payload}
    else:
        policy = _doc_to_row(await tables.insert(TABLE_POLICIES, payload))
    return {"mode": "apply", "action": action, "policy": policy, "base_policy": base, "template": template}


@workflow(
    name="bifrost_grc_manage_policy_template",
    description=(
        "Confirm-gated creation or update of an editable policy template. Templates are dormant recipes: "
        "their fact markers do not create customer Open Items until a policy is created from them."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_manage_policy_template(
    name: str,
    template_id: str | None = None,
    bifrost_organization_id: str | None = None,
    description: str | None = None,
    content: str | None = None,
    version: str = "1.0",
    status: str = "draft",
    policy_type: str = "policy",
    default_policy_role: str = "standalone",
    default_name: str | None = None,
    base_policy_type: str | None = None,
    source_system: str | None = None,
    source_id: str | None = None,
    source_url: str | None = None,
    apply_to_all: bool = True,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "creating or updating a policy template")
    _provider_owner_id()
    if not name.strip():
        raise UserError("name is required")
    if status not in POLICY_STATUSES:
        raise UserError(f"Unsupported status: {status}")
    if policy_type not in POLICY_TYPES:
        raise UserError(f"Unsupported policy_type: {policy_type}")
    if default_policy_role not in POLICY_ROLES:
        raise UserError(f"Unsupported default_policy_role: {default_policy_role}")
    if base_policy_type and base_policy_type not in POLICY_TYPES:
        raise UserError(f"Unsupported base_policy_type: {base_policy_type}")
    if not apply_to_all and not bifrost_organization_id:
        raise UserError("bifrost_organization_id is required unless apply_to_all=true.")

    existing = await _get_row(TABLE_POLICY_TEMPLATES, template_id)
    if template_id and not existing:
        raise UserError(f"Policy template not found: {template_id}")
    if not existing:
        candidates = await _query_rows(TABLE_POLICY_TEMPLATES, {}, limit=1000)
        if source_system and source_id:
            existing = next((row for row in candidates if row.get("source_system") == source_system and row.get("source_id") == source_id), None)
        if not existing:
            existing = next((row for row in candidates if str(row.get("name") or "").casefold() == name.strip().casefold()), None)

    payload = _clean_payload({
        "organization_id": None if apply_to_all else bifrost_organization_id,
        "applied_organizations": None if apply_to_all else [bifrost_organization_id],
        "excluded_organizations": [],
        "name": name.strip(),
        "description": description,
        "content": content,
        "version": version,
        "status": status,
        "policy_type": policy_type,
        "default_policy_role": default_policy_role,
        "default_extension_mode": "supplement" if default_policy_role == "extension" else None,
        "default_name": default_name,
        "base_policy_type": (base_policy_type or policy_type) if default_policy_role == "extension" else None,
        "source_system": source_system,
        "source_id": source_id,
        "source_url": source_url,
    })
    payload["organization_id"] = None if apply_to_all else bifrost_organization_id
    payload["applied_organizations"] = None if apply_to_all else [bifrost_organization_id]
    action = "update" if existing else "create"
    if not apply:
        return {"mode": "dry_run", "action": action, "template_id": str(existing.get("id")) if existing else template_id, "template": payload}
    if existing:
        await tables.update(TABLE_POLICY_TEMPLATES, str(existing["id"]), payload)
        result = await _get_row(TABLE_POLICY_TEMPLATES, str(existing["id"])) or {"id": existing["id"], **payload}
    else:
        result = _doc_to_row(await tables.insert(TABLE_POLICY_TEMPLATES, payload))
    return {"mode": "apply", "action": action, "template": result}


@workflow(
    name="bifrost_grc_attach_policy",
    description=(
        "Attach a Bifrost GRC policy to applied controls, assessment controls, evidence, "
        "exceptions, risks, questionnaires, or source documents with an explicit relationship."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_attach_policy(
    bifrost_organization_id: str,
    policy_id: str,
    target_type: str,
    target_id: str,
    relationship: str = "supports",
    source_system: str | None = "bifrost_grc_agent",
    source_id: str | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "attaching a policy")
    owner_id = _provider_owner_id()
    policy = await _validate_target(bifrost_organization_id, "policy", policy_id)
    await _validate_target(bifrost_organization_id, target_type, target_id)
    link_payload = _clean_payload(
        {
            "organization_id": bifrost_organization_id,
            **_customer_scope(bifrost_organization_id),
            "policy_id": policy_id,
            "target_type": target_type,
            "target_id": target_id,
            "relationship": relationship,
            "source_system": source_system,
            "source_id": source_id,
        }
    )
    if not apply:
        return {"mode": "dry_run", "policy": policy, "policy_link": link_payload}

    existing_link = await _find_existing_link(
        TABLE_POLICY_LINKS,
        bifrost_organization_id,
        "policy_id",
        policy_id,
        target_type,
        target_id,
    )
    if existing_link:
        return {"mode": "apply", "policy": policy, "policy_link": existing_link, "action": "skip"}
    policy_link = _doc_to_row(await tables.insert(TABLE_POLICY_LINKS, link_payload))
    return {"mode": "apply", "policy": policy, "policy_link": policy_link, "action": "create"}


@workflow(
    name="bifrost_grc_create_exception",
    description=(
        "Create a Bifrost GRC exception and link it to an applied control, reference control, "
        "assessment control, assessment, or risk with compensating-control context."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_create_exception(
    bifrost_organization_id: str,
    reason: str,
    target_type: str | None = None,
    target_id: str | None = None,
    status: str = "pending",
    approved_by: str | None = None,
    expires_at: str | None = None,
    compensating_controls: str | None = None,
    relationship: str = "documents_gap",
    source_system: str | None = "bifrost_grc_agent",
    source_id: str | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "creating an exception")
    if approved_by is not None:
        raise UserError("Exception approval attribution is recorded from authenticated context.")
    owner_id = _provider_owner_id()
    if not reason:
        raise UserError("reason is required")
    if status not in EXCEPTION_STATUSES:
        raise UserError(f"status must be one of: {', '.join(sorted(EXCEPTION_STATUSES))}")
    if target_type and target_id:
        await _validate_target(bifrost_organization_id, target_type, target_id)
    elif target_type or target_id:
        raise UserError("target_type and target_id must be provided together")

    payload = _clean_payload(
        {
            "organization_id": bifrost_organization_id,
            **_customer_scope(bifrost_organization_id),
            "reason": reason,
            "status": status,
            "expires_at": expires_at,
            "compensating_controls": compensating_controls,
            "control_id": target_id if target_type == "control" else None,
        }
    )
    payload = attributed_payload(TABLE_EXCEPTIONS, payload, execution_context=context)
    link_payload = None
    if target_type and target_id:
        link_payload = _clean_payload(
            {
                "organization_id": bifrost_organization_id,
                **_customer_scope(bifrost_organization_id),
                "exception_id": "<created_exception_id>",
                "target_type": target_type,
                "target_id": target_id,
                "relationship": relationship,
                "source_system": source_system,
                "source_id": source_id,
            }
        )

    if not apply:
        return {"mode": "dry_run", "exception": payload, "exception_link": link_payload}

    exception = _doc_to_row(await tables.insert(TABLE_EXCEPTIONS, payload))
    exception_id = exception.get("id")
    exception_link = None
    if link_payload:
        link_payload["exception_id"] = exception_id
        exception_link = _doc_to_row(await tables.insert(TABLE_EXCEPTION_LINKS, link_payload))
    return {"mode": "apply", "exception": exception, "exception_link": exception_link}


@workflow(
    name="bifrost_grc_apply_control_mapping",
    description=(
        "Accept or create a reviewed Bifrost GRC applied-control to reference-control mapping "
        "with rationale, confidence, and source provenance."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_apply_control_mapping(
    bifrost_organization_id: str,
    applied_control_id: str,
    control_id: str,
    relationship: str = "supports",
    confidence: float = 0.5,
    status: str = "accepted",
    rationale: str | None = None,
    source_system: str | None = "bifrost_grc_agent",
    source_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict[str, Any]:
    _require_confirm(apply, confirm_apply, "applying a control mapping")
    owner_id = _provider_owner_id()
    if relationship not in MAPPING_RELATIONSHIPS:
        raise UserError(f"relationship must be one of: {', '.join(sorted(MAPPING_RELATIONSHIPS))}")
    if status not in MAPPING_STATUSES:
        raise UserError(f"status must be one of: {', '.join(sorted(MAPPING_STATUSES))}")
    await _validate_target(bifrost_organization_id, "applied_control", applied_control_id)
    await _validate_target(bifrost_organization_id, "control", control_id)

    payload = _clean_payload(
        {
            "organization_id": bifrost_organization_id,
            **_customer_scope(bifrost_organization_id),
            "applied_control_id": applied_control_id,
            "control_id": control_id,
            "relationship": relationship,
            "confidence": confidence,
            "status": status,
            "rationale": rationale,
            "source_system": source_system,
            "source_id": source_id,
            "metadata_json": _stable_json(metadata),
        }
    )
    existing = await _query_rows(
        TABLE_CONTROL_MAPPINGS,
        {
            "applied_control_id": applied_control_id,
            "control_id": control_id,
        },
        limit=10,
    )
    if not apply:
        return {
            "mode": "dry_run",
            "action": "update" if existing else "create",
            "control_mapping": payload,
            "existing_mapping": existing[0] if existing else None,
        }
    if existing:
        mapping_id = existing[0]["id"]
        await tables.update(TABLE_CONTROL_MAPPINGS, mapping_id, payload)
        mapping = await _get_row(TABLE_CONTROL_MAPPINGS, mapping_id)
        return {"mode": "apply", "action": "update", "control_mapping": mapping}
    mapping = _doc_to_row(await tables.insert(TABLE_CONTROL_MAPPINGS, payload))
    return {"mode": "apply", "action": "create", "control_mapping": mapping}
