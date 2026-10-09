"""Canonical organization-scope rules for provider-owned GRC records."""

from __future__ import annotations

from typing import Any


def normalized_scope(row: dict[str, Any] | None) -> tuple[list[str] | None, list[str]]:
    value = row or {}
    if "applied_organizations" in value:
        raw = value.get("applied_organizations")
        applied = None if raw is None else sorted({str(item) for item in raw if item})
    else:
        legacy_org = value.get("organization_id")
        applied = [str(legacy_org)] if legacy_org else None
    excluded = sorted({str(item) for item in (value.get("excluded_organizations") or []) if item})
    if applied is not None:
        applied = [item for item in applied if item not in excluded]
    return applied, excluded


def applies_to_organization(row: dict[str, Any] | None, organization_id: str) -> bool:
    applied, excluded = normalized_scope(row)
    return organization_id not in excluded and (applied is None or organization_id in applied)
