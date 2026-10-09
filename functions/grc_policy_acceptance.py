"""Validate recipient sign-off evidence before presenting it as a signature."""

from __future__ import annotations

import json
from typing import Any


RECIPIENT_ACCEPTANCE_SOURCE = "bifrost_grc_policy_recipient"
_ACTIVE_ASSIGNMENT_STATUSES = {"assigned", "accepted"}


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


def is_genuine_policy_acceptance(
    acceptance: dict[str, Any], assignment: dict[str, Any] | None, campaign: dict[str, Any] | None,
) -> bool:
    """Return whether a persisted recipient acknowledgement proves this sign-off.

    The immutable recipient workflow is the evidence source. Assignment status is
    operational state only, so it never establishes a signature by itself.
    """
    if not assignment or not campaign:
        return False
    if (
        acceptance.get("status") != "accepted"
        or acceptance.get("revoked_at")
        or acceptance.get("superseded_by")
        or acceptance.get("source_system") != RECIPIENT_ACCEPTANCE_SOURCE
        or not acceptance.get("accepted_at")
    ):
        return False
    campaign_id = str(campaign.get("id") or "")
    organization_id = str(campaign.get("organization_id") or "")
    assignment_id = str(assignment.get("id") or "")
    actor_id = str(assignment.get("actor_id") or "")
    if not all((campaign_id, organization_id, assignment_id, actor_id)):
        return False
    if (
        str(acceptance.get("organization_id") or "") != organization_id
        or str(assignment.get("organization_id") or "") != organization_id
        or str(acceptance.get("campaign_id") or "") != campaign_id
        or str(assignment.get("campaign_id") or "") != campaign_id
        or str(acceptance.get("assignment_id") or "") != assignment_id
        or str(acceptance.get("actor_id") or "") != actor_id
        or assignment.get("status") not in _ACTIVE_ASSIGNMENT_STATUSES
    ):
        return False
    policy_ids = [str(value) for value in _json_list(campaign.get("policy_ids_json")) if str(value)]
    accepted_policy_ids = [str(value) for value in _json_list(acceptance.get("accepted_policy_ids_json")) if str(value)]
    if (
        not policy_ids
        or len(policy_ids) != len(set(policy_ids))
        or len(accepted_policy_ids) != len(set(accepted_policy_ids))
        or set(policy_ids) != set(accepted_policy_ids)
    ):
        return False
    versions = _json_object(campaign.get("policy_versions_json"))
    accepted_versions = _json_object(acceptance.get("accepted_policy_versions_json"))
    return set(versions) == set(policy_ids) and versions == accepted_versions
