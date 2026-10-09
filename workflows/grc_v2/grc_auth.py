"""Execution-time tenant guards for privileged GRC workflows.

Solution workflows execute through the engine, which is intentionally able to
reach Solution-owned resources. Row policies still protect direct app/API
traffic, while these guards bind every workflow-supplied organization or
tenant row back to the initiating user's organization. Provider-org users keep
the explicitly requested all-client behavior.
"""

from __future__ import annotations

from typing import Any

from bifrost import UserError, context


def caller_organization_id() -> str | None:
    value = getattr(context, "org_id", None)
    return str(value) if value else None


def is_platform_scope() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def require_provider(message: str = "Platform Org access is required.") -> None:
    if not is_platform_scope():
        raise UserError(message)


def require_organization_access(
    organization_id: str | None,
    *,
    resource: str = "GRC data",
) -> str:
    target = str(organization_id or "").strip()
    if not target:
        raise UserError(f"{resource} has no organization_id")
    if is_platform_scope():
        return target
    caller = caller_organization_id()
    if not caller or target != caller:
        raise UserError(f"You can only access {resource} for your own organization.")
    return target


def bind_organization_scope(
    organization_id: str | None,
    *,
    resource: str = "GRC data",
) -> str:
    """Authorize a target tenant and bind SDK calls to that effective scope."""
    target = require_organization_access(organization_id, resource=resource)
    context.set_scope(target)
    return target


def require_row_access(row: dict[str, Any] | None, *, resource: str) -> str:
    if not row:
        raise UserError(f"{resource} not found")
    return require_organization_access(row.get("organization_id"), resource=resource)
