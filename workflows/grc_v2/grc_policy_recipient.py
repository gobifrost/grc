"""Narrow policy-recipient workflows for customer acknowledgement journeys."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from bifrost import UserError, context, files, tables, workflow

from functions.grc_auth import caller_organization_id, is_platform_scope
from functions.grc_attribution import authenticated_actor_id
from functions.grc_policy_acceptance import is_genuine_policy_acceptance
from functions.grc_scope import applies_to_organization


TABLE_POLICIES = "grc-policies"
TABLE_CAMPAIGNS = "grc-policy-campaigns"
TABLE_ASSIGNMENTS = "grc-policy-campaign-assignments"
TABLE_ACCEPTANCES = "grc-policy-acceptances"
POLICY_FILE_LOCATION = "grc-policy-files"


def _row(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        return {"id": str(raw.get("id") or data.get("id") or ""), **data}
    data = dict(getattr(raw, "data", None) or {})
    return {"id": str(getattr(raw, "id", data.get("id") or "")), **data}


async def _query_rows(
    table: str,
    where: dict[str, Any] | None = None,
    *,
    page_size: int = 1000,
    max_rows: int = 10_000,
) -> list[dict[str, Any]]:
    """Read bounded pages so an applicable record cannot fall after page one."""
    rows: list[dict[str, Any]] = []
    offset = 0
    while len(rows) < max_rows:
        result = await tables.query(table, where=where or {}, limit=page_size, offset=offset)
        page = [_row(document) for document in getattr(result, "documents", [])]
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += len(page)
    raise UserError(f"{table} exceeded the safe {max_rows}-row recipient read limit.")


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


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _recipient_context() -> tuple[str, dict[str, str | None]]:
    authenticated_actor_id(context)
    if is_platform_scope():
        raise UserError("Policy recipient access is available only to customer organizations.")
    organization_id = caller_organization_id()
    if not organization_id:
        raise UserError("Authenticated caller organization is required.")
    user = getattr(context, "user", None)
    actor_id = getattr(user, "id", None) if user is not None else getattr(context, "user_id", None)
    if not actor_id:
        raise UserError("Authenticated caller is required.")
    return organization_id, {
        "id": str(actor_id),
        "email": str(getattr(user, "email", None) or getattr(context, "email", "") or "") or None,
        "display_name": str(
            getattr(user, "display_name", None)
            or getattr(user, "name", None)
            or getattr(user, "full_name", None)
            or getattr(context, "name", None)
            or ""
        ) or None,
    }


def _is_readable_policy(policy: dict[str, Any], organization_id: str) -> bool:
    return policy.get("status") == "active" and applies_to_organization(policy, organization_id)


def _safe_policy(policy: dict[str, Any]) -> dict[str, Any]:
    attachments = [
        {
            key: attachment[key]
            for key in ("id", "name", "path", "contentType", "sizeBytes", "kind")
            if key in attachment
        }
        for attachment in _json_list(policy.get("attachments_json"))
        if isinstance(attachment, dict)
    ]
    return {
        "id": policy["id"],
        "name": policy.get("name"),
        "content": policy.get("content") or "",
        "version": policy.get("version"),
        "policy_type": policy.get("policy_type"),
        "policy_role": policy.get("policy_role") or "standalone",
        "base_policy_id": policy.get("base_policy_id"),
        "attachments": attachments,
    }


async def _recipient_policy(policy_id: str, organization_id: str) -> dict[str, Any]:
    policy = _row(await tables.get(TABLE_POLICIES, policy_id))
    if not policy or not _is_readable_policy(policy, organization_id):
        raise UserError("Policy is not available to your organization.")
    return policy


@workflow(
    name="grc_v2_get_recipient_policies",
    description="Return only active GRC policies applicable to the authenticated customer organization.",
    category="grc",
)
async def grc_v2_get_recipient_policies() -> dict[str, Any]:
    organization_id, _ = _recipient_context()
    policies = [
        _safe_policy(policy)
        for policy in await _query_rows(TABLE_POLICIES)
        if _is_readable_policy(policy, organization_id)
    ]
    policies.sort(key=lambda policy: ((policy.get("name") or "").casefold(), policy["id"]))
    return {"organization_id": organization_id, "policies": policies}


@workflow(
    name="grc_v2_get_my_policy_assignments",
    description="Return only the authenticated recipient's active policy assignments.",
    category="grc",
)
async def grc_v2_get_my_policy_assignments() -> dict[str, Any]:
    organization_id, actor = _recipient_context()
    organization = getattr(context, "organization", None)
    organization_name = getattr(organization, "name", None) or organization_id
    rows = await _query_rows(TABLE_ASSIGNMENTS, {"organization_id": organization_id, "actor_id": actor["id"]})
    assignments = []
    for row in rows:
        if row.get("status") not in {"assigned", "accepted"}:
            continue
        campaign = _row(await tables.get(TABLE_CAMPAIGNS, str(row.get("campaign_id") or "")))
        if not campaign or campaign.get("organization_id") != organization_id or (campaign.get("status") != "active" and row.get("status") != "accepted"):
            continue
        snapshot = _json_object(campaign.get("policy_versions_json"))
        content_snapshot = _json_object(_json_object(campaign.get("metadata_json")).get("policy_contents"))
        policies = []
        stale = False
        for policy_id in _json_list(campaign.get("policy_ids_json")):
            policy = _row(await tables.get(TABLE_POLICIES, str(policy_id)))
            if not policy or not _is_readable_policy(policy, organization_id):
                stale = True
                continue
            stale = stale or policy.get("version") != snapshot.get(policy["id"])
            role = policy.get("policy_role") or "standalone"
            policies.append({
                "id": policy["id"], "name": policy.get("name"), "version": snapshot.get(policy["id"]),
                "content": content_snapshot.get(policy["id"], policy.get("content") or ""),
                "policy_role": role, "base_policy_id": policy.get("base_policy_id"),
                "organization_name": organization_name if role == "extension" else None,
            })
        metadata = _json_object(row.get("metadata_json"))
        assignments.append({
            "assignment_id": row["id"], "campaign_id": campaign["id"],
            "status": row["status"], "due_date": row.get("due_date") or campaign.get("due_date"),
            "accepted_at": metadata.get("accepted_at"), "policies": policies,
            "recipient_name": actor["display_name"],
            "stale": stale,
        })
    for item in assignments:
        if not item["stale"]:
            continue
        ids = {policy["id"] for policy in item["policies"]}
        newer = next((candidate for candidate in assignments if candidate["assignment_id"] != item["assignment_id"] and not candidate["stale"] and {policy["id"] for policy in candidate["policies"]} == ids), None)
        if newer:
            item["superseded_by_assignment_id"] = newer["assignment_id"]
    assignments.sort(key=lambda item: (str(item.get("due_date") or ""), item["assignment_id"]))
    return {"organization_id": organization_id, "organization_name": organization_name, "assignments": assignments}


@workflow(
    name="grc_v2_record_policy_acceptance",
    description="Append an acceptance for the authenticated recipient's active policy-campaign assignment.",
    category="grc",
)
async def grc_v2_record_policy_acceptance(campaign_id: str) -> dict[str, Any]:
    if not str(campaign_id or "").strip():
        raise UserError("campaign_id is required.")
    organization_id, actor = _recipient_context()
    campaign = _row(await tables.get(TABLE_CAMPAIGNS, str(campaign_id)))
    if (
        not campaign
        or campaign.get("organization_id") != organization_id
    ):
        raise UserError("Campaign is not available to your organization.")

    assignments = await _query_rows(
        TABLE_ASSIGNMENTS,
        {
            "organization_id": organization_id,
            "campaign_id": str(campaign_id),
            "actor_id": actor["id"],
        },
    )
    assignment = next((row for row in assignments if row.get("status") in {"assigned", "accepted"}), None)
    if not assignment:
        raise UserError("This campaign is not assigned to the authenticated recipient.")

    policy_ids = [str(policy_id) for policy_id in _json_list(campaign.get("policy_ids_json")) if str(policy_id)]
    if not policy_ids:
        raise UserError("Campaign has no policies to accept.")
    if len(set(policy_ids)) != len(policy_ids):
        raise UserError("Campaign policy version snapshot is invalid or stale.")
    accepted_versions = _json_object(campaign.get("policy_versions_json"))
    if set(accepted_versions) != set(policy_ids):
        raise UserError("Campaign policy version snapshot is invalid or stale.")
    accepted_versions = {policy_id: accepted_versions[policy_id] for policy_id in policy_ids}
    canonical_policy_ids = sorted(policy_ids)
    canonical_versions = _canonical_json(accepted_versions)

    existing = await _query_rows(
        TABLE_ACCEPTANCES,
        {
            "organization_id": organization_id,
            "campaign_id": str(campaign_id),
            "actor_id": actor["id"],
        },
    )
    for acceptance in existing:
        if is_genuine_policy_acceptance(acceptance, assignment, campaign):
            if assignment.get("status") != "accepted":
                metadata = _json_object(assignment.get("metadata_json"))
                metadata["accepted_at"] = acceptance.get("accepted_at")
                await tables.update(TABLE_ASSIGNMENTS, assignment["id"], {"status": "accepted", "metadata_json": _canonical_json(metadata)})
            return {"organization_id": organization_id, "status": "already_accepted", "acceptance": acceptance}

    if assignment.get("status") == "accepted":
        raise UserError("This campaign was already accepted; its acceptance record is unavailable.")

    if campaign.get("status") != "active":
        raise UserError("Campaign is no longer active.")
    policies = {
        policy["id"]: policy
        for policy in await _query_rows(TABLE_POLICIES)
        if _is_readable_policy(policy, organization_id)
    }
    if any(policy_id not in policies for policy_id in policy_ids):
        raise UserError("Campaign includes a policy that is no longer available to your organization.")
    current_versions = {policy_id: policies[policy_id].get("version") for policy_id in policy_ids}
    if accepted_versions != current_versions:
        raise UserError("Campaign policy version snapshot is invalid or stale.")

    payload = {
        "organization_id": organization_id,
        "campaign_id": str(campaign_id),
        "assignment_id": assignment["id"],
        "actor_id": actor["id"],
        "actor_email": actor["email"],
        "actor_display_name": actor["display_name"],
        "accepted_policy_ids_json": _canonical_json(canonical_policy_ids),
        "accepted_policy_versions_json": canonical_versions,
        "status": "accepted",
        "accepted_at": datetime.now(UTC).isoformat(),
        "source_system": "bifrost_grc_policy_recipient",
    }
    acceptance = _row(await tables.insert(TABLE_ACCEPTANCES, payload))
    metadata = _json_object(assignment.get("metadata_json"))
    metadata["accepted_at"] = payload["accepted_at"]
    await tables.update(TABLE_ASSIGNMENTS, assignment["id"], {"status": "accepted", "metadata_json": _canonical_json(metadata)})
    return {"organization_id": organization_id, "status": "accepted", "acceptance": acceptance}


@workflow(
    name="grc_v2_get_recipient_policy_download_url",
    description="Return a signed download URL for an attachment on an active policy applicable to the authenticated customer organization.",
    category="grc",
)
async def grc_v2_get_recipient_policy_download_url(policy_id: str, path: str) -> dict[str, Any]:
    if not str(policy_id or "").strip() or not str(path or "").strip():
        raise UserError("policy_id and path are required.")
    organization_id, _ = _recipient_context()
    policy = await _recipient_policy(str(policy_id), organization_id)
    attachment_paths = {
        str(attachment.get("path"))
        for attachment in _json_list(policy.get("attachments_json"))
        if isinstance(attachment, dict) and attachment.get("path")
    }
    if path not in attachment_paths:
        raise UserError("File is not attached to this policy.")
    scope = policy.get("organization_id") or None
    if not await files.exists(path, location=POLICY_FILE_LOCATION, scope=scope):
        raise UserError("File not found.")
    signed = await files.get_signed_url(path, method="GET", location=POLICY_FILE_LOCATION, scope=scope)
    return {"url": signed.get("url") if isinstance(signed, dict) else signed}
