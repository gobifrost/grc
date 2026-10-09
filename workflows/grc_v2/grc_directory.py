"""Tenant-aware directory reads for the global GRC Solution."""

from __future__ import annotations

from typing import Any

from bifrost import UserError, context, organizations, users, workflow


PLATFORM_ORG_ID = "00000000-0000-0000-0000-000000000002"


def _value(row: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(row, dict) and name in row:
            return row[name]
        value = getattr(row, name, None)
        if value is not None:
            return value
    return default


def _caller_org_id() -> str | None:
    # ExecutionContext exposes the effective organization as ``org_id``.  It
    # reflects a provider/admin ``context.set_scope(...)`` override as well as
    # the caller's native tenant.
    value = getattr(context, "org_id", None)
    return str(value) if value else None


def _is_platform_scope() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


@workflow(name="grc_list_organizations", category="grc")
async def list_organizations(include_inactive: bool = False) -> dict:
    """List all clients for Platform Org users, otherwise only the caller's org."""
    caller_org_id = _caller_org_id()
    if _is_platform_scope():
        rows = await organizations.list()
    elif caller_org_id:
        row = await organizations.get(caller_org_id)
        rows = [row] if row else []
    else:
        rows = []

    output = []
    for row in rows or []:
        if not include_inactive and _value(row, "is_active", default=True) is False:
            continue
        org_id = _value(row, "id")
        name = _value(row, "name")
        if not org_id or not name:
            continue
        output.append({
            "id": str(org_id),
            "name": str(name),
            "domain": _value(row, "domain"),
            "is_provider": bool(
                _value(row, "is_provider", "is_provider_org", "provider", default=False)
                or str(org_id) == PLATFORM_ORG_ID
            ),
            "is_active": bool(_value(row, "is_active", default=True)),
        })
    output.sort(key=lambda item: item["name"].lower())
    return {"organizations": output}


@workflow(name="grc_list_users", category="grc")
async def grc_v2_list_users(
    organization_id: str | None = None,
    include_inactive: bool = False,
) -> dict:
    """List users within the same all-clients/own-client boundary as GRC data."""
    caller_org_id = _caller_org_id()
    target_org_id = organization_id or caller_org_id
    if not _is_platform_scope():
        if not caller_org_id:
            return {"users": []}
        if target_org_id and target_org_id != caller_org_id:
            raise UserError("You can only list users in your own organization.")
        target_org_id = caller_org_id

    rows = await users.list(org_id=target_org_id) if target_org_id else await users.list()
    output = []
    for row in rows or []:
        if not include_inactive and _value(row, "is_active", default=True) is False:
            continue
        row_org_id = str(_value(row, "organization_id", "org_id") or "") or None
        # The execution SDK is provider-capable and may return a wider user
        # directory than requested. Enforce the target org again on the
        # serialized result so customer calls can never inherit that breadth.
        if target_org_id and row_org_id != target_org_id:
            continue
        user_id = _value(row, "id")
        if not user_id:
            continue
        role_values = _value(row, "role_names", "roles", "role_ids", default=[]) or []
        output.append({
            "id": str(user_id),
            "name": _value(row, "name", "full_name", "display_name"),
            "email": _value(row, "email"),
            "organization_id": row_org_id,
            "roles": [str(role) for role in role_values],
        })
    output.sort(key=lambda item: ((item["name"] or "").lower(), (item["email"] or "").lower()))
    return {"users": output}
