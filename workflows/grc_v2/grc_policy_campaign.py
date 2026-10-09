"""Preparation and delivery workflows for employee policy sign-off campaigns."""

from __future__ import annotations

import html
import json
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid4, uuid5

from bifrost import UserError, config, context, events, organizations, roles, tables, users, workflow

from functions.grc_attribution import attributed_payload
from functions.grc_auth import bind_organization_scope, is_platform_scope, require_provider
from functions.grc_scope import applies_to_organization
from workflows.grc_v2 import grc_integration


TABLE_TEMPLATES = "grc-policy-templates"
TABLE_POLICIES = "grc-policies"
TABLE_CAMPAIGNS = "grc-policy-campaigns"
TABLE_ASSIGNMENTS = "grc-policy-campaign-assignments"
TABLE_ACCEPTANCES = "grc-policy-acceptances"

AI_TEMPLATE_SOURCE_ID = "ai-acceptable-use-small-business"
AI_TEMPLATE_NAME = "AI Acceptable Use Policy"
AI_TEMPLATE_CONTENT_DATE = date(2026, 10, 1)
AI_PARENT_TEMPLATE_SOURCE_ID = "ai-acceptable-use-policy-v2"
AI_ADDENDUM_TEMPLATE_SOURCE_ID = "ai-acceptable-use-policy-addendum-v1"
AI_PARENT_TEMPLATE_NAME = "AI Acceptable Use Policy"
AI_ADDENDUM_TEMPLATE_NAME = "AI Acceptable Use Policy Addendum"
AI_TEMPLATE_FIELD_SCHEMA = [
    {"key": "organization_name", "required": True, "description": "Organization name"},
    {"key": "policy_owner_name", "required": True, "description": "Policy owner's name"},
    {"key": "policy_owner_title", "required": True, "description": "Policy owner's title"},
    {"key": "approved_ai_tools", "required": True, "description": "Approved AI tool names, as a string or list of strings"},
    {"key": "it_contact", "required": True, "description": "Contact for AI questions and incident reports"},
    {"key": "approved_tool_note", "required": False, "description": "Optional note about approved tools"},
    {"key": "additional_restricted_data", "required": False, "description": "Optional additional restricted data category"},
]
AI_TEMPLATE_FIELDS = {item["key"] for item in AI_TEMPLATE_FIELD_SCHEMA}
AI_TEMPLATE_REQUIRED_FIELDS = {item["key"] for item in AI_TEMPLATE_FIELD_SCHEMA if item["required"]}
AI_TEMPLATE_CONTENT = """**{{organization_name}}** · Owner: {{policy_owner_name}}, {{policy_owner_title}} · Effective {{effective_date}}

## Approved AI Tools

You may use these AI tools for work, signed in with your work account: **{{approved_ai_tools}}**. {{approved_tool_note}}

Do not use personal or free AI accounts for work. Ask {{it_contact}} before you try a different AI tool or connect one to our email, files, or other systems.

## What Not to Put Into AI

Do not type, paste, or upload:

- passwords, security codes, or account recovery details
- payment card numbers, bank account numbers, or Social Security numbers
- health or medical information about any person
- {{additional_restricted_data}}

Use client or customer information only in an approved tool, and only when your work needs it. If you are unsure whether something is sensitive, leave it out or ask.

## Check the Work

AI can be wrong and still sound confident. Check facts, numbers, and names before you use, send, or act on anything AI produced. You are responsible for your work, whether or not AI helped.

## Decisions About People

Do not let AI make decisions about hiring, pay, discipline, or whether a customer qualifies for something. A person must review and make those decisions.

## Meetings and Recordings

Tell everyone before you use AI to record, transcribe, or summarize a meeting or call, and stop if anyone objects.

## Report Problems Right Away

Tell {{it_contact}} right away if:

- you put information into AI that you should not have
- an AI tool shows you information you should not be able to see
- an AI tool does something you did not ask it to do

Reporting a mistake quickly is always the right choice.

## Acknowledgement

I have read this policy and will follow it. I understand that {{organization_name}} may update it, and that I will be asked to acknowledge changes.
"""
AI_PARENT_TEMPLATE_CONTENT = """## Approved AI Tools

Use only the AI tools listed in your organization's addendum, signed in with your work account. Do not use personal or free AI accounts for work. Ask the contact named in the addendum before you try a different AI tool or connect one to email, files, or other systems.

## What Not to Put Into AI

Do not type, paste, or upload:

- Passwords, security codes, or account recovery details
- Payment card numbers, bank account numbers, or Social Security numbers
- Health or medical information about any person
- Anything your addendum lists as restricted

Use client or customer information only in an approved tool, and only when your work needs it. If you are unsure whether something is sensitive, leave it out or ask.

## Check the Work

AI can be wrong and still sound confident. Check facts, numbers, and names before you use, send, or act on anything AI produced. You are responsible for your work, whether or not AI helped.

## Decisions About People

Do not let AI make decisions about hiring, pay, discipline, or whether a customer qualifies for something. A person must review and make those decisions.

## Meetings and Recordings

Follow your addendum's rule for AI meeting notes and recordings. Never record or transcribe anyone without telling them first.

## Report Problems Right Away

Tell the contact named in your addendum right away if:

- You put information into AI that you should not have
- An AI tool shows you information you should not be able to see
- An AI tool does something you did not ask it to do

Reporting a mistake quickly is always the right choice.

## Acknowledgement

I have read this policy and my organization's addendum, and I will follow them. I understand they may be updated, and that I will be asked to acknowledge changes.
"""
AI_ADDENDUM_TEMPLATE_CONTENT = """**{{organization_name}}** · Owner: {{policy_owner_name}}, {{policy_owner_title}} · Effective {{effective_date}}

## Approved AI Tools

**{{approved_ai_tools}}**. {{approved_tool_note}}

## Meetings and Recordings

{{meeting_rule}}

## Questions and Problems

Contact {{it_contact}}.
"""
AI_ADDENDUM_TEMPLATE_FIELD_SCHEMA = [
    {"key": "organization_name", "type": "string", "required": True, "description": "Organization name"},
    {"key": "policy_owner_name", "type": "string", "required": True, "description": "Policy owner's name"},
    {"key": "policy_owner_title", "type": "string", "required": True, "description": "Policy owner's title"},
    {"key": "approved_ai_tools", "type": "array", "required": True, "description": "One or more approved AI tools"},
    {"key": "approved_tool_note", "type": "string", "required": False, "description": "Optional approved-tool note"},
    {"key": "approved_connections", "type": "array", "required": False, "description": "Systems approved tools may connect to"},
    {"key": "additional_restricted_data", "type": "array", "required": False, "description": "Additional data that must never be entered"},
    {"key": "client_contracts", "type": "enum", "enum": ["none", "manager_approval"], "default": "none", "required": False, "description": "Client contract handling"},
    {"key": "meeting_rule", "type": "enum", "enum": ["allowed_with_notice", "ask_first", "not_allowed"], "default": "allowed_with_notice", "required": False, "description": "Meeting recording rule"},
    {"key": "it_contact", "type": "string", "required": True, "description": "Contact for AI questions and incident reports"},
]
ENGINE_USER_ID = "00000000-0000-0000-0000-000000000001"
NOTIFICATION_TOPIC = "grc.policy.notification_requested"
NO_NOTIFICATION_LISTENER = "No notification listener is configured on this instance."


def _row(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        return {"id": str(raw.get("id") or data.get("id") or ""), **data}
    data = dict(getattr(raw, "data", None) or {})
    return {"id": str(getattr(raw, "id", data.get("id") or "")), **data}


async def _query_rows(table: str, where: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while len(rows) < 10_000:
        result = await tables.query(table, where=where or {}, limit=1_000, offset=offset)
        page = [_row(document) for document in getattr(result, "documents", [])]
        rows.extend(page)
        if len(page) < 1_000:
            return rows
        offset += len(page)
    raise UserError(f"{table} exceeded the safe 10000-row policy campaign read limit.")


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not value:
        return {}
    try:
        decoded = json.loads(str(value))
    except (TypeError, ValueError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _today() -> date:
    return datetime.now(UTC).date()


def _stable_id(*parts: str) -> str:
    return str(uuid5(NAMESPACE_URL, ":".join(parts)))


def _template_content(template: dict[str, Any] | str) -> str:
    if isinstance(template, str):
        return template
    if isinstance(template, dict):
        return str(template.get("content") or "")
    raise UserError("template must be a template object or content string.")


def _field_schema(template: dict[str, Any] | str) -> list[dict[str, Any]]:
    if isinstance(template, dict):
        schema = template.get("field_schema")
        if isinstance(schema, str):
            try:
                schema = json.loads(schema)
            except ValueError as exc:
                raise UserError("Template field schema is invalid.") from exc
        if schema is not None:
            if not isinstance(schema, list) or any(not isinstance(item, dict) or not item.get("key") for item in schema):
                raise UserError("Template field schema is invalid.")
            return schema
    return AI_TEMPLATE_FIELD_SCHEMA


def _join_tools(value: Any) -> str:
    if not isinstance(value, list):
        return str(value or "").strip()
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise UserError("approved_ai_tools must be a list of non-empty strings or a string.")
    names = [item.strip() for item in value]
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return " and ".join(names)
    return ", ".join(names[:-1]) + ", and " + names[-1] if names else ""


def _string_list(value: Any, field: str, *, required: bool = False) -> list[str]:
    if value is None or value == "":
        if required:
            raise UserError(f"Required field(s) are missing: {field}")
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise UserError(f"{field} must be a list of non-empty strings.")
    if required and not value:
        raise UserError(f"Required field(s) are missing: {field}")
    return [item.strip() for item in value]


def _addendum_template() -> dict[str, Any]:
    return {
        "source_id": AI_ADDENDUM_TEMPLATE_SOURCE_ID,
        "name": AI_ADDENDUM_TEMPLATE_NAME,
        "content": AI_ADDENDUM_TEMPLATE_CONTENT,
        "content_updated_at": AI_TEMPLATE_CONTENT_DATE.isoformat(),
        "field_schema": AI_ADDENDUM_TEMPLATE_FIELD_SCHEMA,
        "version": "1.0",
        "status": "active",
        "policy_type": "ai_acceptable_use",
        "default_policy_role": "extension",
        "default_extension_mode": "supplement",
        "base_policy_type": "ai_acceptable_use",
        "default_name": AI_ADDENDUM_TEMPLATE_NAME,
    }


def _render_addendum(template: dict[str, Any], fields: dict[str, Any], *, effective_date: date | None) -> str:
    schema = _field_schema(template)
    allowed = {str(item["key"]) for item in schema}
    unexpected = sorted(set(fields) - allowed)
    if unexpected:
        raise UserError(f"Unknown template field(s): {', '.join(unexpected)}")
    required = [str(item["key"]) for item in schema if item.get("required")]
    missing = [key for key in required if not fields.get(key)]
    if missing:
        raise UserError(f"Required field(s) are missing: {', '.join(sorted(missing))}")
    approved_tools = _string_list(fields.get("approved_ai_tools"), "approved_ai_tools", required=True)
    approved_connections = _string_list(fields.get("approved_connections"), "approved_connections")
    restricted = _string_list(fields.get("additional_restricted_data"), "additional_restricted_data")
    client_contracts = str(fields.get("client_contracts") or "none")
    if client_contracts not in {"none", "manager_approval"}:
        raise UserError("client_contracts must be one of: none, manager_approval.")
    meeting_rule = str(fields.get("meeting_rule") or "allowed_with_notice")
    meeting_text = {
        "allowed_with_notice": "You may use AI to take notes in meetings and calls when you tell everyone first, and you stop if anyone objects.",
        "ask_first": f"Ask {str(fields['it_contact']).strip()} before you use AI to record, transcribe, or summarize a meeting or call.",
        "not_allowed": "Do not use AI to record, transcribe, or summarize meetings or calls.",
    }.get(meeting_rule)
    if meeting_text is None:
        raise UserError("meeting_rule must be one of: allowed_with_notice, ask_first, not_allowed.")
    effective = effective_date or AI_TEMPLATE_CONTENT_DATE
    lines = [
        f"**{str(fields['organization_name']).strip()}** · Owner: {str(fields['policy_owner_name']).strip()}, {str(fields['policy_owner_title']).strip()} · Effective {effective.strftime('%B')} {effective.day}, {effective.year}",
        "", "## Approved AI Tools", "",
    ]
    tools_line = f"**{_join_tools(approved_tools)}**."
    note = str(fields.get("approved_tool_note") or "").strip()
    if note:
        tools_line += f" {note}"
    if approved_connections:
        tools_line += f" The approved tools may connect to: {', '.join(approved_connections)}."
    lines.append(tools_line)
    if restricted:
        lines.extend(["", "## Also Never Enter", "", *[f"- {_capitalize(item)}" for item in restricted]])
    if client_contracts == "manager_approval":
        lines.extend(["", "## Client Information", "", "Some of our client contracts limit how their information may be used. Get your manager's approval before you put any client information into AI."])
    lines.extend(["", "## Meetings and Recordings", "", meeting_text, "", "## Questions and Problems", "", f"Contact {str(fields['it_contact']).strip()}."])
    return "\n".join(lines).rstrip() + "\n"


def render_policy_template(template: dict[str, Any] | str, fields: dict[str, Any], *, effective_date: date | None = None) -> str:
    """Render a policy template without any I/O or caller context."""
    if not isinstance(fields, dict):
        raise UserError("fields must be an object.")
    if isinstance(template, dict) and template.get("default_policy_role") == "extension":
        return _render_addendum(template, fields, effective_date=effective_date)
    content = _template_content(template)
    schema = _field_schema(template)
    allowed = {str(item["key"]) for item in schema}
    unexpected = sorted(set(fields) - allowed)
    if unexpected:
        raise UserError(f"Unknown template field(s): {', '.join(unexpected)}")
    placeholders = set(re.findall(r"{{\s*([a-z_][a-z0-9_]*)\s*}}", content))
    unknown = sorted(placeholders - allowed - {"effective_date"})
    if unknown:
        raise UserError(f"Template contains unknown placeholder(s): {', '.join(unknown)}")
    missing = sorted(
        str(item["key"]) for item in schema if item.get("required")
        and not (fields.get(str(item["key"])) if isinstance(fields.get(str(item["key"])), list) else str(fields.get(str(item["key"])) or "").strip())
    )
    if missing:
        raise UserError(f"Required field(s) are missing: {', '.join(missing)}")

    rendered = content
    # This optional value occupies a complete Markdown bullet; preserve the
    # surrounding list while removing the empty bullet itself.
    if not str(fields.get("additional_restricted_data") or "").strip():
        rendered = re.sub(r"(?m)^-\s*{{\s*additional_restricted_data\s*}}\s*\n", "", rendered)
    for field in allowed | {"effective_date"}:
        if field == "effective_date":
            changed = template.get("content_updated_at") if isinstance(template, dict) else None
            try:
                effective = effective_date or (date.fromisoformat(str(changed)) if changed else AI_TEMPLATE_CONTENT_DATE)
            except ValueError as exc:
                raise UserError("Template content change date is invalid.") from exc
            value = f"{effective.strftime('%B')} {effective.day}, {effective.year}"
        elif field == "approved_ai_tools":
            value = _join_tools(fields.get(field))
        else:
            value = str(fields.get(field) or "").strip()
        rendered = re.sub(r"{{\s*" + re.escape(field) + r"\s*}}", value, rendered)
    # The optional note follows a sentence and should not leave an internal
    # double space when omitted. Do not normalize Markdown prose globally.
    rendered = re.sub(r"(?m)(\.)([ \t]{2,})(?=\S)", r"\1 ", rendered)
    rendered = re.sub(r"(?m)^(- .+)\n(?=[^\n#-])", r"\1\n\n", rendered)
    return rendered.rstrip() + "\n"


def _minor_version(version: Any) -> str:
    match = re.fullmatch(r"(\d+)\.(\d+)", str(version or "1.0"))
    if not match:
        return "1.1"
    return f"{match.group(1)}.{int(match.group(2)) + 1}"


def _actor() -> dict[str, str | None]:
    user = getattr(context, "user", None)
    actor_id = getattr(user, "id", None) if user is not None else getattr(context, "user_id", None)
    if not actor_id:
        raise UserError("Authenticated caller is required.")
    return {
        "id": str(actor_id),
        "email": str(getattr(user, "email", None) or getattr(context, "email", "") or "") or None,
        "display_name": str(
            getattr(user, "display_name", None)
            or getattr(user, "name", None)
            or getattr(context, "name", "")
            or ""
        ) or None,
    }


def _authorize_campaign_operator(organization_id: str) -> str:
    return bind_organization_scope(organization_id, resource="policy campaign")


async def _authorize_direct_campaign_operator(organization_id: str) -> str:
    """Check the caller identity when a cross-Solution engine call skips roles."""
    organization_id = _authorize_campaign_operator(organization_id)
    actor = _actor()
    if actor["id"] == ENGINE_USER_ID:
        raise UserError("A real user must be passed with run_as for policy campaign access.")
    if is_platform_scope():
        return organization_id
    allowed_roles = {"GRC Administrator", "GRC Contributor"}
    for role in await roles.list():
        role_name = str(getattr(role, "name", None) or (role.get("name") if isinstance(role, dict) else ""))
        if role_name not in allowed_roles:
            continue
        role_id = str(getattr(role, "id", None) or (role.get("id") if isinstance(role, dict) else ""))
        if role_id and actor["id"] in {str(user_id) for user_id in await roles.list_users(role_id)}:
            return organization_id
    raise UserError("An authorized GRC role is required for policy campaign access.")


@workflow(
    name="grc_v2_seed_ai_acceptable_use_template",
    description="Idempotently seed the product AI acceptable-use policy template.",
    category="grc",
)
async def grc_v2_seed_ai_acceptable_use_template() -> dict[str, Any]:
    """Idempotently seed the parent AI policy and its customer addendum template."""
    actor = _actor()
    if actor["id"] == ENGINE_USER_ID:
        raise UserError("A real provider user must be passed with run_as to seed policy templates.")
    require_provider("Platform Org access is required to seed policy templates.")
    provider_id = str(
        getattr(getattr(context, "organization", None), "id", None)
        or getattr(context, "org_id", None)
        or ""
    )
    if not provider_id:
        raise UserError("Provider organization id is required to seed policy templates.")
    parent_template_id = _stable_id(TABLE_TEMPLATES, AI_PARENT_TEMPLATE_SOURCE_ID)
    addendum_template_id = _stable_id(TABLE_TEMPLATES, AI_ADDENDUM_TEMPLATE_SOURCE_ID)
    parent_template = {
        "organization_id": None,
        "applied_organizations": None,
        "excluded_organizations": [],
        "name": AI_PARENT_TEMPLATE_NAME,
        "description": "Provider-wide parent AI acceptable use policy.",
        "content": AI_PARENT_TEMPLATE_CONTENT,
        "content_updated_at": AI_TEMPLATE_CONTENT_DATE.isoformat(),
        "field_schema": [],
        "version": "2.1",
        "status": "active",
        "policy_type": "ai_acceptable_use",
        "default_policy_role": "base",
        "default_extension_mode": "supplement",
        "default_name": AI_PARENT_TEMPLATE_NAME,
        "source_system": "bifrost_grc_policy_signoff",
        "source_id": AI_PARENT_TEMPLATE_SOURCE_ID,
    }
    addendum_template = {
        "organization_id": None,
        "applied_organizations": None,
        "excluded_organizations": [],
        **_addendum_template(),
        # This durable reference makes the template pair unambiguous even
        # when several templates share the same policy type.
        "base_template_id": parent_template_id,
        "source_system": "bifrost_grc_policy_signoff",
    }
    for template_id, payload in ((parent_template_id, parent_template), (addendum_template_id, addendum_template)):
        existing = await _query_rows(TABLE_TEMPLATES, {"source_id": payload["source_id"]})
        if existing:
            row = existing[0]
            if row["id"] != template_id:
                raise UserError("Seeded AI template has a non-deterministic id; migrate it before seeding.")
            if any(row.get(key) != value for key, value in payload.items()):
                await tables.update(TABLE_TEMPLATES, template_id, payload)
        else:
            await tables.insert(TABLE_TEMPLATES, payload, id=template_id)
    for legacy in await _query_rows(TABLE_TEMPLATES, {"source_id": AI_TEMPLATE_SOURCE_ID}):
        if legacy.get("status") != "archived":
            await tables.update(TABLE_TEMPLATES, legacy["id"], {"status": "archived"})
    base_policy_id = _stable_id(TABLE_POLICIES, AI_PARENT_TEMPLATE_SOURCE_ID)
    base_payload = {
        "organization_id": provider_id,
        # None is the supported all-organizations scope; [] is a non-applying
        # explicit scope under functions.grc_scope.normalized_scope.
        "applied_organizations": None,
        "excluded_organizations": [],
        "name": AI_PARENT_TEMPLATE_NAME,
        "content": AI_PARENT_TEMPLATE_CONTENT,
        "version": "2.1",
        "status": "active",
        "policy_type": "ai_acceptable_use",
        "policy_role": "base",
        "extension_mode": "supplement",
        "template_id": parent_template_id,
        "template_version": "2.1",
        "source_system": "bifrost_grc_policy_signoff",
    }
    existing_bases = await _query_rows(TABLE_POLICIES, {"template_id": parent_template_id})
    if existing_bases:
        base = existing_bases[0]
        if base["id"] != base_policy_id:
            raise UserError("Seeded parent policy has a non-deterministic id; migrate it before seeding.")
        if any(base.get(key) != value for key, value in base_payload.items()):
            await _replace_prepared_policy(base, {key: value for key, value in base_payload.items() if key != "status"})
    else:
        await tables.insert(TABLE_POLICIES, attributed_payload(TABLE_POLICIES, base_payload, execution_context=context), id=base_policy_id)
    return {
        "template_id": parent_template_id,
        "parent_template_id": parent_template_id,
        "addendum_template_id": addendum_template_id,
        "base_policy_id": base_policy_id,
    }


async def _prepare_policy(organization_id: str, template_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    template = _row(await tables.get(TABLE_TEMPLATES, str(template_id)))
    if not template or template.get("status") != "active" or not applies_to_organization(template, organization_id):
        raise UserError("Policy template is not available to this organization.")
    if template.get("default_policy_role") == "base":
        raise UserError("Base policy templates are provider-managed and cannot be prepared per organization.")
    if template.get("default_policy_role") == "extension":
        raise UserError("Extension templates must be prepared with grc_v2_prepare_policy_addendum.")
    candidates = [
        row for row in await _query_rows(TABLE_POLICIES, {"template_id": str(template_id)})
        if row.get("status") != "archived" and applies_to_organization(row, organization_id)
        and sorted(str(item) for item in (row.get("applied_organizations") or [])) == [organization_id]
    ]
    candidates.sort(key=lambda row: str(row.get("id") or ""))
    policy = candidates[0] if candidates else None
    old_content = str(policy.get("content") or "") if policy else ""
    old_date_match = re.search(r"· Effective ([A-Za-z]+ \d{1,2}, \d{4})", old_content)
    try:
        old_date = datetime.strptime(old_date_match.group(1), "%B %d, %Y").date() if old_date_match else None
    except ValueError:
        old_date = None
    comparable_content = render_policy_template(template, fields, effective_date=old_date) if policy else ""
    content = comparable_content if policy and old_content == comparable_content else render_policy_template(
        template, fields, effective_date=_today(),
    )
    if policy and str(policy.get("content") or "") == content:
        metadata = {"name": template.get("default_name") or template.get("name"), "template_version": template.get("version") or "1.0"}
        if any(policy.get(key) != value for key, value in metadata.items()):
            await tables.update(TABLE_POLICIES, policy["id"], attributed_payload(TABLE_POLICIES, metadata, policy, execution_context=context))
        return {"policy_id": policy["id"], "version": str(policy.get("version") or "1.0"), "content": content}

    if policy:
        version = _minor_version(policy.get("version"))
        await _replace_prepared_policy(policy, {
            "content": content, "version": version,
            "name": template.get("default_name") or template.get("name"),
            "template_version": template.get("version") or "1.0",
        })
        return {"policy_id": policy["id"], "version": version, "content": content}

    policy_id = _stable_id(TABLE_POLICIES, organization_id, str(template_id))
    inserted = _row(await tables.insert(TABLE_POLICIES, attributed_payload(TABLE_POLICIES, {
        "organization_id": organization_id,
        "applied_organizations": [organization_id],
        "excluded_organizations": [],
        "name": template.get("default_name") or template.get("name"),
        "content": content,
        "version": "1.0",
        "status": "active",
        "policy_type": template.get("policy_type") or "policy",
        "policy_role": template.get("default_policy_role") or "standalone",
        "extension_mode": template.get("default_extension_mode") or "supplement",
        "template_id": str(template_id),
        "template_version": template.get("version") or "1.0",
        "source_system": "bifrost_grc_policy_signoff",
    }, execution_context=context), id=policy_id))
    return {"policy_id": inserted["id"], "version": "1.0", "content": content}


async def _active_parent_policy(organization_id: str, template: dict[str, Any] | None = None) -> dict[str, Any]:
    base_type = str((template or {}).get("base_policy_type") or "ai_acceptable_use")
    parents = [
        row for row in await _query_rows(TABLE_POLICIES)
        if row.get("status") == "active"
        and row.get("policy_role") == "base"
        and str(row.get("policy_type") or "") == base_type
        and applies_to_organization(row, organization_id)
    ]
    parents.sort(key=lambda row: str(row.get("id") or ""))
    if not parents:
        raise UserError("No active parent policy is available for this addendum.")
    if len(parents) > 1:
        raise UserError("More than one active parent policy is available for this addendum.")
    return parents[0]


async def _prepare_policy_addendum(organization_id: str, template_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    template = _row(await tables.get(TABLE_TEMPLATES, str(template_id)))
    if not template or template.get("status") != "active" or not applies_to_organization(template, organization_id):
        raise UserError("Policy template is not available to this organization.")
    if template.get("default_policy_role") != "extension":
        raise UserError("Policy template is not an addendum template.")
    expected_parent_template_id = str(template.get("base_template_id") or "")
    parent = await _active_parent_policy(organization_id, template)
    if expected_parent_template_id and str(parent.get("template_id") or "") != expected_parent_template_id:
        raise UserError("The addendum template is linked to a different parent policy template.")
    candidates = [
        row for row in await _query_rows(TABLE_POLICIES, {"template_id": str(template_id)})
        if row.get("status") != "archived"
        and row.get("policy_role") == "extension"
        and str(row.get("base_policy_id") or "") == str(parent["id"])
        and sorted(str(item) for item in (row.get("applied_organizations") or [])) == [organization_id]
    ]
    candidates.sort(key=lambda row: str(row.get("id") or ""))
    policy = candidates[0] if candidates else None
    old_content = str((policy or {}).get("content") or "")
    old_date_match = re.search(r"· Effective ([A-Za-z]+ \d{1,2}, \d{4})", old_content)
    try:
        old_date = datetime.strptime(old_date_match.group(1), "%B %d, %Y").date() if old_date_match else None
    except ValueError:
        old_date = None
    comparable = render_policy_template(template, fields, effective_date=old_date) if policy else ""
    content = comparable if policy and old_content == comparable else render_policy_template(template, fields, effective_date=_today())
    result_base = {"base_policy_id": parent["id"], "base_version": str(parent.get("version") or "")}
    if policy and old_content == content:
        metadata = {
            "name": template.get("default_name") or template.get("name"),
            "template_version": template.get("version") or "1.0",
            "reviewed_base_version": str(parent.get("version") or ""),
            "status": "active",
        }
        if any(policy.get(key) != value for key, value in metadata.items()):
            await tables.update(TABLE_POLICIES, policy["id"], attributed_payload(TABLE_POLICIES, metadata, policy, execution_context=context))
        return {**result_base, "addendum_policy_id": policy["id"], "addendum_version": str(policy.get("version") or "1.0"), "content": content}
    if policy:
        version = _minor_version(policy.get("version"))
        await _replace_prepared_policy(policy, {
            "content": content, "version": version,
            "name": template.get("default_name") or template.get("name"),
            "template_version": template.get("version") or "1.0",
            "base_policy_id": parent["id"], "reviewed_base_version": str(parent.get("version") or ""),
        })
        return {**result_base, "addendum_policy_id": policy["id"], "addendum_version": version, "content": content}
    policy_id = _stable_id(TABLE_POLICIES, organization_id, str(template_id), str(parent["id"]))
    inserted = _row(await tables.insert(TABLE_POLICIES, attributed_payload(TABLE_POLICIES, {
        "organization_id": organization_id,
        "applied_organizations": [organization_id], "excluded_organizations": [],
        "name": template.get("default_name") or template.get("name"), "content": content,
        "version": "1.0", "status": "active", "policy_type": template.get("policy_type") or "policy",
        "policy_role": "extension", "base_policy_id": parent["id"],
        "extension_mode": template.get("default_extension_mode") or "supplement",
        "reviewed_base_version": str(parent.get("version") or ""),
        "template_id": str(template_id), "template_version": template.get("version") or "1.0",
        "source_system": "bifrost_grc_policy_signoff",
    }, execution_context=context), id=policy_id))
    return {**result_base, "addendum_policy_id": inserted["id"], "addendum_version": "1.0", "content": content}


async def _replace_prepared_policy(policy: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Record generated content as a draft, then approve it as the current caller.

    Template preparation is an explicit signing operation. Keeping the content
    write and approval transition separate makes attribution enforce the same
    invalidation rule as every other policy edit.
    """
    draft = attributed_payload(TABLE_POLICIES, payload, policy, execution_context=context)
    updated = _row(await tables.update(TABLE_POLICIES, policy["id"], draft))
    approval = attributed_payload(
        TABLE_POLICIES, {"status": "active"}, updated, execution_context=context,
    )
    return _row(await tables.update(TABLE_POLICIES, policy["id"], approval))


async def prepare_policy_for_authorized_caller(
    organization_id: str,
    template_id: str,
    fields: dict[str, Any],
) -> dict[str, Any]:
    """Prepare a policy after a caller-facing workflow has checked its own roles."""
    organization_id = _authorize_campaign_operator(organization_id)
    template = _row(await tables.get(TABLE_TEMPLATES, str(template_id)))
    if template.get("default_policy_role") == "extension":
        return await _prepare_policy_addendum(organization_id, template_id, fields)
    return await _prepare_policy(organization_id, template_id, fields)


async def preview_policy_addendum_for_authorized_caller(
    organization_id: str, template_id: str, fields: dict[str, Any],
) -> dict[str, Any]:
    """Render a linked parent policy and addendum without persisting either."""
    organization_id = _authorize_campaign_operator(organization_id)
    template = _row(await tables.get(TABLE_TEMPLATES, str(template_id)))
    if not template or template.get("status") != "active" or template.get("default_policy_role") != "extension":
        raise UserError("Policy template is not an active addendum template.")
    parent = await _active_parent_policy(organization_id, template)
    candidates = [
        row for row in await _query_rows(TABLE_POLICIES, {"template_id": str(template_id)})
        if row.get("status") != "archived"
        and row.get("policy_role") == "extension"
        and str(row.get("base_policy_id") or "") == str(parent["id"])
        and sorted(str(item) for item in (row.get("applied_organizations") or [])) == [organization_id]
    ]
    candidates.sort(key=lambda row: str(row.get("id") or ""))
    existing = candidates[0] if candidates else None
    old_content = str((existing or {}).get("content") or "")
    old_date_match = re.search(r"· Effective ([A-Za-z]+ \d{1,2}, \d{4})", old_content)
    try:
        old_date = datetime.strptime(old_date_match.group(1), "%B %d, %Y").date() if old_date_match else None
    except ValueError:
        old_date = None
    comparable = render_policy_template(template, fields, effective_date=old_date) if existing else ""
    content = comparable if existing and old_content == comparable else render_policy_template(template, fields, effective_date=_today())
    if not existing:
        addendum_version = "1.0"
    elif old_content == content:
        addendum_version = str(existing.get("version") or "1.0")
    else:
        addendum_version = _minor_version(existing.get("version"))
    parent_version = str(parent.get("version") or "")
    return {
        "base_policy_id": parent["id"], "base_version": parent_version,
        "parent_markdown": str(parent.get("content") or ""),
        "addendum_markdown": content,
        # Caller contract: the version each document would carry if sent now.
        "parent": {"name": str(parent.get("name") or ""), "version": parent_version, "content": str(parent.get("content") or "")},
        "addendum": {"version": addendum_version, "content": content},
    }


@workflow(
    name="grc_v2_prepare_policy",
    description="Render an active policy template and create or update an organization's active policy.",
    category="grc",
)
async def grc_v2_prepare_policy(organization_id: str, template_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    return await _prepare_policy(await _authorize_direct_campaign_operator(organization_id), template_id, fields)


@workflow(
    name="grc_v2_prepare_policy_addendum",
    description="Render an active AI policy addendum and create or update an organization's extension policy.",
    category="grc",
)
async def grc_v2_prepare_policy_addendum(organization_id: str, addendum_template_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    organization_id = await _authorize_direct_campaign_operator(organization_id)
    return await _prepare_policy_addendum(organization_id, addendum_template_id, fields)


def _user_value(user: Any, name: str, default: Any = None) -> Any:
    return user.get(name, default) if isinstance(user, dict) else getattr(user, name, default)


def _is_system_user(user: Any) -> bool:
    """Keep platform service identities out of the human-recipient default."""
    user_id = str(_user_value(user, "id", "") or "")
    user_type = str(_user_value(user, "user_type", "") or "").casefold()
    email = str(_user_value(user, "email", "") or "").casefold()
    return user_id == ENGINE_USER_ID or email == "system@internal.gobifrost.com" or bool(_user_value(user, "is_system", False)) or user_type == "system"


def _is_active_user(user: Any) -> bool:
    active = _user_value(user, "is_active", None)
    if active is None:
        active = _user_value(user, "active", None)
    if active is None:
        status = str(_user_value(user, "status", "") or "").casefold()
        return status not in {"inactive", "disabled"}
    return bool(active)


def _belongs_to_organization(user: Any, organization_id: str) -> bool:
    user_org = _user_value(user, "organization_id", "__missing__")
    # Check the returned record too: older SDK/API combinations may ignore
    # the users.list org_id query parameter.
    return user_org == "__missing__" or str(user_org) == organization_id


async def _default_policy_recipients(organization_id: str) -> dict[str, list[dict[str, str]]]:
    """Return active Bifrost users who can receive a policy sign-off request."""
    included: list[dict[str, str]] = []
    excluded: list[dict[str, str]] = []
    for user in await users.list(org_id=organization_id, include_inactive=True):
        if _is_system_user(user) or not _belongs_to_organization(user, organization_id):
            continue
        name = str(_user_value(user, "display_name", None) or _user_value(user, "name", None) or _user_value(user, "email", "") or "").strip()
        email = str(_user_value(user, "email", "") or "").strip()
        reason: str | None = None
        if not _is_active_user(user):
            reason = "Inactive user"
        elif not email:
            reason = "No email address"
        if reason:
            excluded.append({"email": email, "name": name, "reason": reason})
        else:
            included.append({"email": email, "name": name})
    included.sort(key=lambda row: (row["name"].casefold(), row["email"].casefold()))
    excluded.sort(key=lambda row: (row["name"].casefold(), row["email"].casefold()))
    return {"included": included, "excluded": excluded}


@workflow(
    name="grc_v2_default_policy_recipients",
    description="Return active Bifrost users as policy recipients, with explicit exclusions.",
    category="grc",
)
async def grc_v2_default_policy_recipients(organization_id: str) -> dict[str, list[dict[str, str]]]:
    return await _default_policy_recipients(await _authorize_direct_campaign_operator(organization_id))


def _normalize_recipients(recipients: list[dict[str, Any]]) -> list[dict[str, str]]:
    if not isinstance(recipients, list) or not recipients:
        raise UserError("recipients must include at least one person.")
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for recipient in recipients:
        if not isinstance(recipient, dict):
            raise UserError("Each recipient must be an object.")
        email = str(recipient.get("email") or "").strip()
        name = str(recipient.get("name") or "").strip()
        if not email or "@" not in email:
            raise UserError("Each recipient requires a valid email address.")
        if not name:
            raise UserError("Each recipient requires a name.")
        canonical_email = email.casefold()
        if canonical_email in seen:
            raise UserError("Recipients must be unique by email.")
        seen.add(canonical_email)
        normalized.append({"email": email, "name": name})
    return normalized


def _due_date(value: str | None) -> str:
    if value is None or not str(value).strip():
        return (datetime.now(UTC).date() + timedelta(days=14)).isoformat()
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError as exc:
        raise UserError("due_date must be an ISO date.") from exc


def _capitalize(text: str) -> str:
    """Start a list item with a capital without changing the rest (keeps acronyms)."""
    text = str(text or "").strip()
    return text[:1].upper() + text[1:]


def _campaign_title(policies: list[dict[str, Any]]) -> str:
    """Name a campaign the way employees see it: a parent policy names its addendum pair."""
    base = next((policy for policy in policies if policy.get("policy_role") == "base"), None)
    if base:
        return str(base.get("name") or "Policy")
    if len(policies) == 1:
        return str(policies[0].get("name") or "Policy")
    return "Policy Sign-Off"


def _email_date(value: str) -> str:
    try:
        parsed = date.fromisoformat(str(value)[:10])
    except ValueError:
        return str(value)
    return f"{parsed:%B} {parsed.day}, {parsed.year}"


async def _active_policies(organization_id: str, policy_ids: list[str]) -> list[dict[str, Any]]:
    ids = [str(policy_id or "").strip() for policy_id in policy_ids or []]
    if not ids or not all(ids) or len(set(ids)) != len(ids):
        raise UserError("policy_ids must include unique policy ids.")
    by_id = {row["id"]: row for row in await _query_rows(TABLE_POLICIES)}
    selected = [by_id.get(policy_id) for policy_id in ids]
    if any(
        row is None or row.get("status") != "active" or not applies_to_organization(row, organization_id)
        for row in selected
    ):
        raise UserError("Every policy must be active and apply to this organization.")
    return [row for row in selected if row is not None]


async def _ensure_viewer_user(organization_id: str, recipient: dict[str, str], viewer_role_id: str) -> dict[str, str]:
    existing = await users.list(org_id=organization_id)
    user = next(
        (item for item in existing or [] if _belongs_to_organization(item, organization_id)
         and str(_user_value(item, "email", "") or "").casefold() == recipient["email"].casefold()),
        None,
    )
    if user is None:
        user = await users.create(recipient["email"], recipient["name"], org_id=organization_id)
    user_id = str(getattr(user, "id", None) or (user.get("id") if isinstance(user, dict) else "") or "")
    if not user_id:
        raise UserError(f"Could not create or resolve Bifrost user for {recipient['email']}.")
    await roles.assign_users(viewer_role_id, [user_id])
    return {"id": user_id, "email": recipient["email"], "display_name": recipient["name"]}


async def _viewer_role_id() -> str:
    for role in await roles.list():
        if str(getattr(role, "name", None) or (role.get("name") if isinstance(role, dict) else "")) == "GRC Viewer":
            role_id = str(getattr(role, "id", None) or (role.get("id") if isinstance(role, dict) else "") or "")
            if role_id:
                return role_id
    raise UserError("The GRC Viewer role is not configured.")


async def _policies_app_url() -> str:
    configured = str(await config.get("grc_policies_app_url", default="/apps/policies") or "/apps/policies").strip()
    parsed = urlparse(configured)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return configured
    if parsed.scheme or configured.startswith("//"):
        raise UserError("grc_policies_app_url must be an http(s) URL or absolute path.")
    base = str(getattr(context, "public_url", "") or "").rstrip("/")
    if not base:
        raise UserError("The platform public URL is required to send policy invitations.")
    return f"{base}/{configured.lstrip('/')}"


async def prepare_policy_notification(
    organization_id: str,
    assignment_id: str,
    email: str,
    name: str,
    campaign: dict[str, Any],
    reminder: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build an event payload and its initial assignment notification record."""
    policy_names = campaign.get("policy_names") or _json_object(campaign.get("metadata_json")).get("policy_names") or []
    if isinstance(policy_names, str):
        policy_names = [policy_names]
    title = str(campaign.get("title") or "").strip()
    # A parent policy with its addendum is one document, named by its title.
    policy_name = title if title and title != "Policy Sign-Off" else (", ".join(str(item) for item in policy_names if item) or "Policy")
    subject = f"Please Review and Sign: {policy_name}"
    due_date = str(campaign.get("due_date") or "")
    link_url = str(campaign.get("link_url") or "")
    if not link_url:
        raise UserError("Campaign has no policy review link.")
    organization = await organizations.get(organization_id)
    sender_name = str(getattr(organization, "name", None) or (organization.get("name") if isinstance(organization, dict) else "") or "")
    first_name = str(name or "").strip().split(maxsplit=1)[0] or "there"
    lead = "A reminder: please read and sign" if reminder else "Please read and sign"
    message = str(campaign.get("description") or "").strip()
    message_html = f"<p>{html.escape(message)}</p>" if message else ""
    due_text = f" by {html.escape(_email_date(due_date))}" if due_date else ""
    # Email clients ignore stylesheets, so the button is styled inline and
    # sits in its own paragraph.
    content_html = (
        f"<p>{lead} <strong>{html.escape(policy_name)}</strong>{due_text}. It takes about two minutes.</p>"
        f"{message_html}"
        f"<p style=\"margin:24px 0;\"><a href=\"{html.escape(link_url, quote=True)}\" "
        "style=\"display:inline-block;padding:12px 22px;border-radius:6px;background:#0f766e;"
        "color:#ffffff;font-weight:600;text-decoration:none;\">Review and Sign</a></p>"
        "<p style=\"color:#6b7280;font-size:13px;\">You will sign in with your Microsoft work account.</p>"
    )
    text_due = f" by {_email_date(due_date)}" if due_date else ""
    content_text = (
        f"{lead} {policy_name}{text_due}. It takes about two minutes.\n\n"
        + (f"{message}\n\n" if message else "")
        + f"Review and Sign: {link_url}\n\nYou will sign in with your Microsoft work account."
    )
    requested_at = _now_iso()
    notification_id = str(uuid4())
    payload = {
        "notification_id": notification_id,
        "kind": "reminder" if reminder else "invite",
        "organization_id": organization_id,
        "organization_name": sender_name,
        "campaign_id": str(campaign.get("id") or ""),
        "assignment_id": assignment_id,
        "recipient": {"email": email, "name": name, "first_name": first_name},
        "policy_name": policy_name,
        "due_date": due_date,
        "link_url": link_url,
        "subject": subject,
        "greeting": f"Hi {first_name},",
        "content_html": content_html,
        "content_text": content_text,
        "requested_at": requested_at,
    }
    record = {
        "notification_id": notification_id,
        "kind": payload["kind"],
        "status": "requested",
        "requested_at": requested_at,
        "subscribers_notified": 0,
    }
    return payload, record


async def emit_policy_notification(organization_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Emit a persisted request and return the result without claiming delivery."""
    record: dict[str, Any] = {}
    try:
        result = await events.emit(NOTIFICATION_TOPIC, payload, scope=organization_id)
        subscribers_notified = int((result or {}).get("subscribers_notified") or 0)
        record = {"subscribers_notified": subscribers_notified}
        if subscribers_notified < 1:
            record.update({"status": "no_listener", "error": NO_NOTIFICATION_LISTENER})
    except Exception as exc:
        detail = str(exc).strip()
        reason = "GRC could not publish the notification request."
        if detail:
            reason += f" {detail}"
        record.update({"status": "failed", "subscribers_notified": 0, "error": reason})
    return record


async def _merge_notification_emit_result(assignment_id: str, notification_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Merge emit metadata unless the listener has already recorded a terminal state."""
    assignment = _row(await tables.get(TABLE_ASSIGNMENTS, assignment_id))
    metadata = _json_object(assignment.get("metadata_json"))
    notices = metadata.get("notifications") if isinstance(metadata.get("notifications"), list) else []
    notice = next((item for item in notices if isinstance(item, dict) and item.get("notification_id") == notification_id), None)
    if notice is None:
        raise UserError("The persisted notification request could not be found.")
    if notice.get("status") != "requested":
        notice["subscribers_notified"] = int(result.get("subscribers_notified") or 0)
        metadata["notifications"] = notices
        await tables.update(TABLE_ASSIGNMENTS, assignment_id, {"metadata_json": _canonical_json(metadata)})
        return notice
    notice.update(result)
    metadata["notifications"] = notices
    await tables.update(TABLE_ASSIGNMENTS, assignment_id, {"metadata_json": _canonical_json(metadata)})
    return notice


async def _send_policy_campaign(
    organization_id: str,
    policy_ids: list[str],
    recipients: list[dict[str, Any]],
    due_date: str | None,
    message: str | None,
    waived_reasons: dict[str, str] | None = None,
) -> dict[str, Any]:
    recipients = _normalize_recipients(recipients)
    policies = await _active_policies(organization_id, policy_ids)
    due = _due_date(due_date)
    app_url = await _policies_app_url()
    viewer_role_id = await _viewer_role_id()
    audience = [await _ensure_viewer_user(organization_id, recipient, viewer_role_id) for recipient in recipients]
    policy_versions = {str(policy["id"]): str(policy.get("version") or "") for policy in policies}
    canonical_policy_ids = sorted(policy_versions)
    idempotency_key = "policy-signoff:" + organization_id + ":" + ",".join(
        f"{policy_id}@{policy_versions[policy_id]}" for policy_id in canonical_policy_ids
    )
    before = await _query_rows(TABLE_ASSIGNMENTS)
    before_ids = {row["id"] for row in before}
    policy_names = [str(policy.get("name") or "Policy") for policy in policies]
    title = _campaign_title(policies)
    await grc_integration._ensure_campaign(organization_id, _actor(), idempotency_key, {
        "campaign": {
            "title": title,
            "description": str(message or "").strip() or None,
            "due_date": due,
            "link_url": app_url,
            "metadata": {
                "policy_names": policy_names,
                "policy_contents": {str(policy["id"]): str(policy.get("content") or "") for policy in policies},
                "source_system": "bifrost_grc_policy_signoff",
            },
        },
        # The list is a rendering contract: parent first, then its extension.
        # The idempotency key remains sorted independently of display order.
        "policy_ids": [str(policy["id"]) for policy in policies],
        "audience": [{"actor": actor} for actor in audience],
    })
    campaign_rows = await _query_rows(TABLE_CAMPAIGNS, {"organization_id": organization_id, "idempotency_key": idempotency_key})
    if not campaign_rows:
        raise UserError("Campaign was not created.")
    campaign = campaign_rows[0]
    assignments = [
        row for row in await _query_rows(TABLE_ASSIGNMENTS, {"organization_id": organization_id, "campaign_id": campaign["id"]})
        if row.get("status") == "assigned"
    ]
    new_assignments = [row for row in assignments if row["id"] not in before_ids]
    recipient_by_email = {recipient["email"].casefold(): recipient for recipient in recipients}
    failed_notifications: list[dict[str, str]] = []
    requested = 0
    carried_waivers: list[dict[str, str]] = []
    for assignment in new_assignments:
        email = str(assignment.get("actor_email") or "").strip()
        recipient = recipient_by_email.get(email.casefold())
        if not recipient:
            continue
        metadata = _json_object(assignment.get("metadata_json"))
        waiver_reason = (waived_reasons or {}).get(email.casefold())
        if waiver_reason:
            metadata["waiver_reason"] = waiver_reason
            await tables.update(TABLE_ASSIGNMENTS, assignment["id"], {
                "status": "waived", "metadata_json": _canonical_json(metadata),
            })
            carried_waivers.append({"assignment_id": assignment["id"], "email": email, "reason": waiver_reason})
            continue
        notifications = metadata.get("notifications") if isinstance(metadata.get("notifications"), list) else []
        payload, event = await prepare_policy_notification(
            organization_id, str(assignment["id"]), email, recipient["name"], campaign, reminder=False,
        )
        notifications.append(event)
        metadata["notifications"] = notifications
        # Persist before emission so an eager listener can always find the ID.
        await tables.update(TABLE_ASSIGNMENTS, assignment["id"], {
            "due_date": due,
            "assigned_at": assignment.get("assigned_at") or _now_iso(),
            "metadata_json": _canonical_json(metadata),
        })
        emit_result = await emit_policy_notification(organization_id, payload)
        event = await _merge_notification_emit_result(
            str(assignment["id"]), str(event["notification_id"]),
            emit_result,
        )
        if emit_result.get("status") not in {"no_listener", "failed"}:
            requested += 1
        if event["status"] in {"no_listener", "failed"}:
            failed_notifications.append({
                "assignment_id": str(assignment["id"]), "email": email,
                "reason": str(event.get("error") or "GRC could not request a notification."),
            })
    return {
        "campaign_id": campaign["id"],
        "assigned": len(new_assignments),
        "requested": requested,
        "failed_notifications": failed_notifications,
        "carried_waivers": carried_waivers,
    }


async def send_policy_campaign_for_authorized_caller(
    organization_id: str,
    policy_ids: list[str],
    recipients: list[dict[str, Any]],
    due_date: str | None = None,
    message: str | None = None,
    waived_reasons: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Send a campaign after a caller-facing workflow has checked its own roles."""
    organization_id = _authorize_campaign_operator(organization_id)
    return await _send_policy_campaign(organization_id, policy_ids, recipients, due_date, message, waived_reasons)


@workflow(
    name="grc_v2_send_policy_campaign",
    description="Create an idempotent employee policy sign-off campaign and publish invitation requests.",
    category="grc",
)
async def grc_v2_send_policy_campaign(
    organization_id: str,
    policy_ids: list[str],
    recipients: list[dict[str, Any]],
    due_date: str | None = None,
    message: str | None = None,
    waived_reasons: dict[str, str] | None = None,
) -> dict[str, Any]:
    return await _send_policy_campaign(
        await _authorize_direct_campaign_operator(organization_id), policy_ids, recipients, due_date, message, waived_reasons,
    )
