"""Portable integration gateway for generic GRC policy campaigns."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid5

from bifrost import UserError, context, tables, workflow

from functions.grc_policy_acceptance import is_genuine_policy_acceptance
from functions.grc_scope import applies_to_organization


CONTRACT_VERSION = "1"
OPERATION_GET_STATUS = "get_campaign_status"
OPERATION_ENSURE_CAMPAIGN = "ensure_campaign"

TABLE_CAMPAIGNS = "grc-policy-campaigns"
TABLE_ASSIGNMENTS = "grc-policy-campaign-assignments"
TABLE_ACCEPTANCES = "grc-policy-acceptances"
TABLE_POLICIES = "grc-policies"


def _doc_to_row(doc: Any) -> dict[str, Any]:
    if doc is None:
        return {}
    if isinstance(doc, dict):
        if isinstance(doc.get("data"), dict):
            return {
                "id": str(doc.get("id") or doc["data"].get("id") or ""),
                "created_at": doc.get("created_at"),
                "updated_at": doc.get("updated_at"),
                **doc["data"],
            }
        return dict(doc)
    data = dict(getattr(doc, "data", None) or {})
    data["id"] = str(getattr(doc, "id", data.get("id", "")))
    data["created_at"] = getattr(doc, "created_at", data.get("created_at", None))
    data["updated_at"] = getattr(doc, "updated_at", data.get("updated_at", None))
    return data


async def _query_rows(table: str, where: dict[str, Any] | None = None, limit: int = 1000) -> list[dict[str, Any]]:
    result = await tables.query(table, where=where or {}, limit=limit)
    return [_doc_to_row(doc) for doc in getattr(result, "documents", [])]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if not value:
        return []
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _json_value(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, ValueError):
        return default


def _stable_id(*parts: str) -> str:
    return str(uuid5(NAMESPACE_URL, ":".join(parts)))


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _effective_user_actor() -> dict[str, str | None]:
    user = getattr(context, "user", None)
    actor_id = getattr(user, "id", None) if user is not None else None
    if not actor_id:
        actor_id = getattr(context, "user_id", None)
    if not actor_id:
        raise UserError("Authenticated caller is required.")
    email = getattr(user, "email", None) if user is not None else None
    display_name = (
        getattr(user, "display_name", None)
        or getattr(user, "name", None)
        or getattr(user, "full_name", None)
    ) if user is not None else None
    return {
        "id": str(actor_id),
        "email": str(email) if email else None,
        "display_name": str(display_name) if display_name else None,
    }


def _request_actor(actor: Any) -> dict[str, str | None]:
    if not isinstance(actor, dict):
        raise UserError("actor is required.")
    actor_id = str(actor.get("id") or "").strip()
    if not actor_id:
        raise UserError("actor.id is required.")
    email = str(actor.get("email") or "").strip() or None
    display_name = str(actor.get("display_name") or "").strip() or None
    return {"id": actor_id, "email": email, "display_name": display_name}


def _caller_organization_id() -> str | None:
    value = getattr(context, "org_id", None)
    return str(value) if value else None


def _is_platform_scope() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def _is_function_key_call() -> bool:
    return bool(getattr(context, "is_function_key", False))


def _authorize_envelope_actor_and_org(requested_organization_id: Any, actor: Any) -> tuple[str, dict[str, str | None]]:
    requested = str(requested_organization_id or "").strip()
    if not requested:
        raise UserError("organization_id is required.")
    if _is_function_key_call():
        raise UserError("Function-key gateway calls require a delegated human identity and are not supported.")
    request_actor = _request_actor(actor)

    caller_org_id = _caller_organization_id()
    if not caller_org_id:
        raise UserError("Authenticated caller organization is required.")
    if not _is_platform_scope() and requested != caller_org_id:
        raise UserError("organization_id must match the authenticated caller organization.")

    effective_actor = _effective_user_actor()
    if request_actor["id"] != effective_actor["id"]:
        raise UserError("actor.id must match the authenticated caller.")
    if request_actor["email"] and effective_actor["email"] and request_actor["email"].casefold() != effective_actor["email"].casefold():
        raise UserError("actor.email must match the authenticated caller.")
    return requested, effective_actor


def _envelope(operation: str, organization_id: str, status: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "contract_version": CONTRACT_VERSION,
        "operation": operation,
        "organization_id": organization_id,
        "status": status,
        "data": data,
        "updated_at": _now_iso(),
    }


async def _validate_policy_ids(organization_id: str, policy_ids: list[str]) -> None:
    if not policy_ids:
        raise UserError("payload.policy_ids must include at least one policy id.")
    rows = await _query_rows(TABLE_POLICIES, {}, limit=1000)
    visible = {
        str(row.get("id"))
        for row in rows
        if row.get("id")
        and row.get("status") != "archived"
        and applies_to_organization(row, organization_id)
    }
    missing = [policy_id for policy_id in policy_ids if policy_id not in visible]
    if missing:
        raise UserError(f"Unknown or unavailable policy_ids: {', '.join(missing)}")


async def _policy_versions(organization_id: str, policy_ids: list[str]) -> dict[str, str | None]:
    rows = await _query_rows(TABLE_POLICIES, {}, limit=1000)
    versions = {
        str(row.get("id")): (str(row.get("version")) if row.get("version") is not None else None)
        for row in rows
        if row.get("id")
        and str(row.get("id")) in set(policy_ids)
        and row.get("status") != "archived"
        and applies_to_organization(row, organization_id)
    }
    missing = [policy_id for policy_id in policy_ids if policy_id not in versions]
    if missing:
        raise UserError(f"Unknown or unavailable policy_ids: {', '.join(missing)}")
    return versions


def _audience_actor(row: dict[str, Any]) -> dict[str, str | None]:
    actor = row.get("actor") if isinstance(row.get("actor"), dict) else row
    actor_id = actor.get("id") or actor.get("actor_id")
    if not actor_id:
        raise UserError("Every audience entry must include actor.id.")
    email = actor.get("email") or actor.get("actor_email")
    display_name = actor.get("display_name") or actor.get("name") or actor.get("actor_display_name")
    return {
        "id": str(actor_id),
        "email": str(email) if email else None,
        "display_name": str(display_name) if display_name else None,
    }


def _dedupe_audience(rows: list[dict[str, Any]]) -> list[dict[str, str | None]]:
    audience: list[dict[str, str | None]] = []
    seen: set[str] = set()
    for row in rows:
        actor = _audience_actor(row)
        actor_id = str(actor["id"])
        if actor_id in seen:
            continue
        seen.add(actor_id)
        audience.append(actor)
    return audience


def _safe_link_url(value: Any) -> str | None:
    if value in (None, ""):
        return None
    url = str(value).strip()
    parsed = urlparse(url)
    if parsed.scheme and parsed.scheme not in {"http", "https"}:
        raise UserError("link_url must use http or https.")
    if not parsed.scheme and url.startswith("//"):
        raise UserError("link_url must use http or https.")
    return url


async def _find_campaign(organization_id: str, idempotency_key: str) -> dict[str, Any] | None:
    rows = await _query_rows(
        TABLE_CAMPAIGNS,
        {"organization_id": organization_id, "idempotency_key": idempotency_key},
        limit=1,
    )
    return rows[0] if rows else None


def _campaign_fingerprint(
    *,
    title: str,
    description: Any,
    policy_ids: list[str],
    audience: list[dict[str, str | None]],
    due_date: Any,
    link_url: Any,
    metadata: Any,
) -> str:
    return _canonical_json(
        {
            "title": title,
            "description": description or None,
            "policy_ids": policy_ids,
            "audience": audience,
            "due_date": due_date or None,
            "link_url": link_url or None,
            "metadata": metadata or {},
        }
    )


async def _ensure_campaign(organization_id: str, actor: dict[str, str | None], idempotency_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    campaign_input = payload.get("campaign") if isinstance(payload.get("campaign"), dict) else {}
    title = str(campaign_input.get("title") or payload.get("title") or "").strip()
    if not title:
        raise UserError("payload.campaign.title is required.")
    policy_ids = sorted({str(policy_id) for policy_id in payload.get("policy_ids") or [] if str(policy_id).strip()})
    policy_versions = await _policy_versions(organization_id, policy_ids)
    audience = _dedupe_audience(payload.get("audience") or [])
    if not audience:
        raise UserError("payload.audience must include at least one actor.")
    description = campaign_input.get("description") or payload.get("description")
    due_date = campaign_input.get("due_date") or payload.get("due_date")
    link_url = _safe_link_url(campaign_input.get("link_url") or payload.get("link_url"))
    metadata = campaign_input.get("metadata") or {}
    fingerprint = _campaign_fingerprint(
        title=title,
        description=description,
        policy_ids=policy_ids,
        audience=audience,
        due_date=due_date,
        link_url=link_url,
        metadata=metadata,
    )

    campaign = await _find_campaign(organization_id, idempotency_key)
    if not campaign:
        campaign_id = _stable_id(TABLE_CAMPAIGNS, organization_id, idempotency_key)
        campaign_payload = {
            "organization_id": organization_id,
            "idempotency_key": idempotency_key,
            "request_fingerprint": fingerprint,
            "title": title,
            "description": description,
            "status": campaign_input.get("status") or "active",
            "policy_ids_json": _canonical_json(policy_ids),
            "policy_versions_json": _canonical_json(policy_versions),
            "audience_count": len(audience),
            "audience_json": _canonical_json(audience),
            "due_date": due_date,
            "link_url": link_url,
            "created_by_actor_id": actor["id"],
            "created_by_actor_email": actor["email"],
            "created_by_actor_display_name": actor["display_name"],
            "metadata_json": _canonical_json(metadata),
        }
        campaign = _doc_to_row(await tables.insert(TABLE_CAMPAIGNS, campaign_payload, id=campaign_id))
    else:
        campaign_id = str(campaign["id"])
        if campaign.get("request_fingerprint") and campaign.get("request_fingerprint") != fingerprint:
            raise UserError("idempotency_key conflicts with an existing campaign payload.")
        policy_ids = [str(policy_id) for policy_id in _json_list(campaign.get("policy_ids_json"))]
        audience = [
            item for item in _json_list(campaign.get("audience_json"))
            if isinstance(item, dict) and item.get("id")
        ]

    assignments = await _query_rows(TABLE_ASSIGNMENTS, {"organization_id": organization_id, "campaign_id": campaign_id})
    existing_actor_ids = {
        str(row.get("actor_id"))
        for row in assignments
        if row.get("actor_id") and row.get("status") not in {"removed", "revoked", "superseded"}
    }
    for audience_actor in audience:
        if audience_actor["id"] in existing_actor_ids:
            continue
        assignment_payload = {
            "organization_id": organization_id,
            "campaign_id": campaign_id,
            "actor_id": audience_actor["id"],
            "actor_email": audience_actor["email"],
            "actor_display_name": audience_actor["display_name"],
            "status": "assigned",
        }
        assignment_id = _stable_id(TABLE_ASSIGNMENTS, organization_id, campaign_id, audience_actor["id"] or "")
        assignments.append(_doc_to_row(await tables.insert(TABLE_ASSIGNMENTS, assignment_payload, id=assignment_id)))

    return await _campaign_status(organization_id, actor)


def _safe_campaign(row: dict[str, Any], required_count: int, accepted_count: int, actor_status: str) -> dict[str, Any]:
    return {
        "campaign_id": row.get("id"),
        "title": row.get("title"),
        "status": row.get("status") or "active",
        "required_count": required_count,
        "accepted_count": accepted_count,
        "current_actor_status": actor_status,
        "due_date": row.get("due_date"),
        "updated_at": row.get("updated_at"),
        "link_url": row.get("link_url"),
    }


async def _campaign_status(organization_id: str, actor: dict[str, str | None]) -> dict[str, Any]:
    campaigns = [
        row for row in await _query_rows(TABLE_CAMPAIGNS, {"organization_id": organization_id}, limit=1000)
        if row.get("status") in (None, "active")
    ]
    assignments = await _query_rows(TABLE_ASSIGNMENTS, {"organization_id": organization_id}, limit=1000)
    acceptances = await _query_rows(TABLE_ACCEPTANCES, {"organization_id": organization_id}, limit=1000)

    assignments_by_campaign: dict[str, list[dict[str, Any]]] = {}
    assignments_by_id: dict[str, dict[str, Any]] = {}
    for assignment in assignments:
        assignments_by_campaign.setdefault(str(assignment.get("campaign_id") or ""), []).append(assignment)
        assignments_by_id[str(assignment.get("id") or "")] = assignment

    accepted_by_campaign: dict[str, set[str]] = {}
    for acceptance in acceptances:
        campaign_id = str(acceptance.get("campaign_id") or "")
        actor_id = str(acceptance.get("actor_id") or "")
        campaign = next((row for row in campaigns if str(row.get("id") or "") == campaign_id), None)
        assignment = assignments_by_id.get(str(acceptance.get("assignment_id") or ""))
        if not is_genuine_policy_acceptance(acceptance, assignment, campaign):
            continue
        if campaign_id and actor_id:
            accepted_by_campaign.setdefault(campaign_id, set()).add(actor_id)

    safe_campaigns = []
    for campaign in campaigns:
        campaign_id = str(campaign.get("id") or "")
        campaign_assignments = [
            row for row in assignments_by_campaign.get(campaign_id, [])
            if row.get("status") not in {"removed", "revoked", "superseded"}
        ]
        assigned_actor_ids = {str(row.get("actor_id") or "") for row in campaign_assignments}
        accepted_actor_ids = accepted_by_campaign.get(campaign_id, set())
        accepted_actor_ids = accepted_actor_ids & assigned_actor_ids
        actor_assignment = next(
            (row for row in campaign_assignments if str(row.get("actor_id") or "") == actor["id"]),
            None,
        )
        current_actor_status = "not_assigned"
        if actor_assignment:
            current_actor_status = "accepted" if actor["id"] in accepted_actor_ids else "assigned"
        safe_campaigns.append(
            _safe_campaign(
                campaign,
                required_count=len(campaign_assignments),
                accepted_count=len(accepted_actor_ids),
                actor_status=current_actor_status,
            )
        )

    safe_campaigns.sort(key=lambda item: (str(item.get("due_date") or ""), str(item.get("title") or "")))
    return {
        "campaign_count": len(safe_campaigns),
        "assignment_count": sum(campaign["required_count"] for campaign in safe_campaigns),
        "accepted_count": sum(campaign["accepted_count"] for campaign in safe_campaigns),
        "campaigns": safe_campaigns,
    }


@workflow(
    name="grc_integration_gateway",
    description="Versioned authenticated gateway for generic GRC policy campaign integrations.",
    category="grc",
)
async def grc_integration_gateway(
    contract_version: str,
    operation: str,
    organization_id: str,
    actor: dict[str, Any],
    idempotency_key: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if str(contract_version or "") != CONTRACT_VERSION:
        raise UserError("Unsupported contract_version.")
    operation = str(operation or "")
    if operation not in {OPERATION_GET_STATUS, OPERATION_ENSURE_CAMPAIGN}:
        raise UserError(f"Unsupported operation: {operation}")
    idempotency_key = str(idempotency_key or "").strip()
    if not idempotency_key:
        raise UserError("idempotency_key is required.")
    if payload is not None and not isinstance(payload, dict):
        raise UserError("payload must be an object.")

    organization_id, actor = _authorize_envelope_actor_and_org(organization_id, actor)
    if operation == OPERATION_GET_STATUS:
        data = await _campaign_status(organization_id, actor)
    else:
        data = await _ensure_campaign(organization_id, actor, idempotency_key, payload or {})
    return _envelope(operation, organization_id, "ok", data)
