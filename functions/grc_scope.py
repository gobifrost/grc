"""Canonical organization-scope rules for the MSP GRC model.

Multi-customer records are owned by the provider organization in
``organization_id``. Applicability is independent: ``applied_organizations``
is ``None`` for every current and future customer or an explicit list for
one/some customers. ``excluded_organizations`` narrows either form.
"""

from __future__ import annotations

from typing import Any, Iterable

from bifrost import UserError


GLOBAL_SCOPE_SIZE = 2**31 - 1


def normalized_scope(row: dict[str, Any] | None) -> tuple[list[str] | None, list[str]]:
    value = row or {}
    if "applied_organizations" in value:
        raw_applied = value.get("applied_organizations")
        applied = None if raw_applied is None else sorted({str(item) for item in raw_applied if item})
    else:
        legacy_org = value.get("organization_id")
        applied = [str(legacy_org)] if legacy_org else None
    excluded = sorted({str(item) for item in (value.get("excluded_organizations") or []) if item})
    if applied is not None:
        applied = [item for item in applied if item not in excluded]
    return applied, excluded


def validate_scope(applied: list[str] | None, excluded: Iterable[str] | None = None) -> None:
    if applied is not None and not applied:
        raise UserError("Choose at least one organization or select All.")
    overlap = set(applied or []).intersection(excluded or [])
    if overlap:
        raise UserError("An organization cannot be both applied and excluded.")


def applies_to_organization(row: dict[str, Any] | None, organization_id: str) -> bool:
    applied, excluded = normalized_scope(row)
    return organization_id not in excluded and (applied is None or organization_id in applied)


def fact_scope_size(row: dict[str, Any], organization_id: str) -> int | None:
    """Return fact specificity, or ``None`` when the row does not apply.

    A logical Some scope is materialized as one tenant-owned row per customer,
    sharing ``scope_id`` and ``scope_size``. That preserves tenant table policy
    isolation while retaining one logical reusable value.
    """
    if not applies_to_organization(row, organization_id):
        return None
    if row.get("scope_kind") == "all":
        return GLOBAL_SCOPE_SIZE
    if row.get("organization_id") is None and row.get("applied_organizations") is None:
        return GLOBAL_SCOPE_SIZE
    try:
        size = int(row.get("scope_size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size > 0:
        return size
    applied, _ = normalized_scope(row)
    return max(1, len(applied or []))


def resolve_effective_facts(
    rows: list[dict[str, Any]], organization_id: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Resolve one > narrowest Some > All without arbitrary tie-breaking."""
    candidates: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for row in rows:
        key = str(row.get("fact_key") or "")
        if not key:
            continue
        size = fact_scope_size(row, organization_id)
        if size is not None:
            candidates.setdefault(key, []).append((size, row))

    resolved: dict[str, dict[str, Any]] = {}
    conflicts: dict[str, list[dict[str, Any]]] = {}
    for key, matches in candidates.items():
        best_size = min(size for size, _ in matches)
        best = [row for size, row in matches if size == best_size]
        by_scope: dict[str, list[dict[str, Any]]] = {}
        for row in best:
            scope_id = str(row.get("scope_id") or row.get("id") or "legacy")
            by_scope.setdefault(scope_id, []).append(row)
        if len(by_scope) > 1:
            conflicts[key] = [scope_rows[0] for scope_rows in by_scope.values()]
            continue
        selected = max(
            next(iter(by_scope.values())),
            key=lambda item: (int(item.get("revision") or 0), str(item.get("updated_at") or "")),
        )
        resolved[key] = {
            **selected,
            "effective_scope_kind": selected.get("scope_kind") or ("all" if best_size == GLOBAL_SCOPE_SIZE else "one"),
            "effective_scope_size": None if best_size == GLOBAL_SCOPE_SIZE else best_size,
        }
    return resolved, conflicts


def inherited_scope(source: dict[str, Any]) -> dict[str, Any]:
    """Copy a parent's applicability onto a relationship row."""
    applied, excluded = normalized_scope(source)
    return {
        "applied_organizations": applied,
        "excluded_organizations": excluded,
    }


def effective_control(default: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    """Resolve the sparse customer override over a provider default."""
    if not override:
        return {**default, "is_override": False}
    protected = {"id", "assessment_id", "control_id", "organization_id"}
    patch = {key: value for key, value in override.items() if key not in protected}
    return {
        **default,
        **patch,
        "customer_organization_id": override.get("customer_organization_id"),
        "override_id": override.get("id"),
        "is_override": True,
    }
