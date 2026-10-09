"""Explicitly authorized entry points for other Solutions using GRC sign-off."""
from __future__ import annotations

import json
from typing import Any

from bifrost import UserError, config, context, roles, tables, workflow

from functions.grc_auth import require_organization_access
from functions.grc_scope import applies_to_organization
from workflows.grc_v2.grc_integration import _doc_to_row, _json_value
from workflows.grc_v2.grc_policy_admin import _details, _query_rows, _reissue
from workflows.grc_v2.grc_policy_admin import ASSIGNMENTS, CAMPAIGNS, _now, _remind
from workflows.grc_v2.grc_policy_campaign import (
    TABLE_TEMPLATES,
    _default_policy_recipients,
    _field_schema,
    _authorize_campaign_operator,
    _prepare_policy_addendum,
    _query_rows as _campaign_query_rows,
    prepare_policy_for_authorized_caller,
    preview_policy_addendum_for_authorized_caller,
    send_policy_campaign_for_authorized_caller,
)

ENGINE_ID = "00000000-0000-0000-0000-000000000001"


def _value(row: Any, key: str) -> Any:
    return row.get(key) if isinstance(row, dict) else getattr(row, key, None)


async def _authorize(organization_id: str, config_key: str) -> None:
    user = getattr(context, "user", None)
    user_id = str(getattr(user, "id", None) or getattr(context, "user_id", "") or "")
    if not user_id or user_id == ENGINE_ID:
        raise UserError("A real user must be passed with run_as for GRC caller access.")
    require_organization_access(organization_id, resource="policy sign-off")
    configured = await config.get(config_key, default=[])
    if not isinstance(configured, list):
        raise UserError(f"{config_key} must be a list of role names.")
    allowed = {str(name) for name in configured} | {"GRC Administrator", "GRC Contributor"}
    for role in await roles.list():
        if str(_value(role, "name") or "") not in allowed:
            continue
        role_id = str(_value(role, "id") or "")
        if role_id and user_id in {str(uid) for uid in await roles.list_users(role_id)}:
            return
    raise UserError("The caller does not hold an authorized GRC role.")


@workflow(name="grc_caller_policy_signoff", category="grc")
async def grc_caller_policy_signoff(organization_id: str, policy_type: str = "ai_acceptable_use") -> dict[str, Any]:
    await _authorize(organization_id, "grc_caller_reader_roles")
    campaigns = await _query_rows("grc-policy-campaigns", {"organization_id": organization_id})
    details = [await _details(row) for row in campaigns]
    matching = [row for row in details if any(p.get("policy_type") == policy_type for p in row.get("policies", []))]
    if not matching:
        return {"status": "not_sent"}
    matching.sort(key=lambda row: str(row.get("sent_date") or ""), reverse=True)
    return matching[0]


@workflow(name="grc_caller_prepare_and_send", category="grc")
async def grc_caller_prepare_and_send(
    organization_id: str,
    template_id: str,
    fields: dict[str, Any],
    recipients: list[dict[str, str]],
    due_date: str | None = None,
) -> dict[str, Any]:
    await _authorize(organization_id, "grc_caller_sender_roles")
    prepared = await prepare_policy_for_authorized_caller(organization_id, template_id, fields)
    policy_ids = (
        [prepared["base_policy_id"], prepared["addendum_policy_id"]]
        if "addendum_policy_id" in prepared else [prepared["policy_id"]]
    )
    campaign = await send_policy_campaign_for_authorized_caller(organization_id, policy_ids, recipients, due_date)
    return {"policy": prepared, "campaign": campaign}


@workflow(name="grc_caller_preview_addendum", category="grc")
async def grc_caller_preview_addendum(
    organization_id: str, addendum_template_id: str, fields: dict[str, Any],
) -> dict[str, Any]:
    """Render a caller-authorized parent policy and addendum without saving it."""
    await _authorize(organization_id, "grc_caller_reader_roles")
    return await preview_policy_addendum_for_authorized_caller(organization_id, addendum_template_id, fields)


@workflow(name="grc_caller_prepare_addendum", category="grc")
async def grc_caller_prepare_addendum(
    organization_id: str, addendum_template_id: str, fields: dict[str, Any],
) -> dict[str, Any]:
    """Save a new addendum version from edited choices so a re-issue sends it."""
    await _authorize(organization_id, "grc_caller_sender_roles")
    return await _prepare_policy_addendum(_authorize_campaign_operator(organization_id), addendum_template_id, fields)


@workflow(name="grc_caller_list_policy_templates", category="grc")
async def grc_caller_list_policy_templates(
    policy_type: str | None = None,
) -> list[dict[str, Any]]:
    """List active policy templates available to an authorized caller."""
    organization_id = str(getattr(context, "org_id", "") or "")
    organization_id = require_organization_access(organization_id, resource="policy sign-off")
    await _authorize(organization_id, "grc_caller_reader_roles")
    requested_type = str(policy_type or "").strip()
    templates = []
    for template in await _campaign_query_rows(TABLE_TEMPLATES, {"status": "active"}):
        if template.get("status") != "active":
            continue
        if not applies_to_organization(template, organization_id):
            continue
        if requested_type and str(template.get("policy_type") or "") != requested_type:
            continue
        fields = [
            {
                "key": str(field["key"]),
                "required": bool(field.get("required")),
                "description": str(field.get("description") or ""),
                **({"type": str(field["type"])} if field.get("type") else {}),
                **({"enum": list(field["enum"])} if isinstance(field.get("enum"), list) else {}),
                **({"default": field["default"]} if "default" in field else {}),
            }
            for field in (_field_schema(template) if template.get("field_schema") is not None else [])
        ]
        templates.append({
            "id": str(template["id"]),
            "name": str(template.get("name") or ""),
            "version": str(template.get("version") or ""),
            "policy_type": str(template.get("policy_type") or ""),
            "policy_role": str(template.get("default_policy_role") or "standalone"),
            "base_template_id": str(template.get("base_template_id") or "") or None,
            "fields": fields,
        })
    templates.sort(key=lambda template: (template["name"].casefold(), template["id"]))
    return templates


async def _caller_owned_row(table: str, row_id: str, organization_id: str, resource: str) -> dict[str, Any]:
    row = _doc_to_row(await tables.get(table, row_id))
    if not row:
        raise UserError(f"{resource} not found.")
    if str(row.get("organization_id") or "") != organization_id:
        raise UserError(f"{resource} does not belong to this organization.")
    return row


@workflow(name="grc_caller_default_recipients", category="grc")
async def grc_caller_default_recipients(organization_id: str) -> dict[str, list[dict[str, str]]]:
    """Return active Bifrost policy recipients for an authorized caller's organization."""
    organization_id = require_organization_access(organization_id, resource="policy sign-off")
    await _authorize(organization_id, "grc_caller_reader_roles")
    return await _default_policy_recipients(organization_id)


@workflow(name="grc_caller_remind", category="grc")
async def grc_caller_remind(
    organization_id: str,
    campaign_id: str,
    assignment_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Send eligible policy reminders for a caller-owned campaign."""
    organization_id = require_organization_access(organization_id, resource="policy sign-off")
    await _authorize(organization_id, "grc_caller_sender_roles")
    campaign = await _caller_owned_row(CAMPAIGNS, campaign_id, organization_id, "Campaign")
    return await _remind(campaign, assignment_ids)


@workflow(name="grc_caller_reissue", category="grc")
async def grc_caller_reissue(organization_id: str, campaign_id: str) -> dict[str, Any]:
    """Reissue a caller-owned campaign after its policy version changes."""
    organization_id = require_organization_access(organization_id, resource="policy sign-off")
    await _authorize(organization_id, "grc_caller_sender_roles")
    campaign = await _caller_owned_row(CAMPAIGNS, campaign_id, organization_id, "Campaign")
    return await _reissue(campaign, send_policy_campaign_for_authorized_caller)


@workflow(name="grc_caller_waive", category="grc")
async def grc_caller_waive(organization_id: str, assignment_id: str, reason: str) -> dict[str, Any]:
    """Waive a caller-owned policy assignment with an auditable reason."""
    organization_id = require_organization_access(organization_id, resource="policy sign-off")
    await _authorize(organization_id, "grc_caller_sender_roles")
    reason = str(reason or "").strip()
    if not reason:
        raise UserError("A waiver reason is required.")
    assignment = await _caller_owned_row(ASSIGNMENTS, assignment_id, organization_id, "Assignment")
    if assignment.get("status") in {"accepted", "removed", "revoked", "superseded"}:
        raise UserError("This assignment cannot be waived.")
    metadata = _json_value(assignment.get("metadata_json"), {})
    metadata.update({
        "waiver_reason": reason,
        "waived_at": _now().isoformat(),
        "waived_by": str(getattr(getattr(context, "user", None), "id", None) or getattr(context, "user_id", "")),
    })
    await tables.update(ASSIGNMENTS, assignment_id, {"status": "waived", "metadata_json": json.dumps(metadata)})
    return {"assignment_id": assignment_id, "status": "waived", "reason": reason}
