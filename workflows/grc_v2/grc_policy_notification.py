"""Inbound delivery-result callback for GRC policy notification events."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from bifrost import UserError, context, tables, workflow


ASSIGNMENTS = "grc-policy-campaign-assignments"
ENGINE_USER_ID = "00000000-0000-0000-0000-000000000001"


def _row(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        return {"id": str(raw.get("id") or data.get("id") or ""), **data}
    data = dict(getattr(raw, "data", None) or {})
    return {"id": str(getattr(raw, "id", data.get("id") or "")), **data}


async def _assignments() -> list[dict[str, Any]]:
    organization_id = str(getattr(context, "org_id", "") or "").strip()
    if not organization_id:
        raise UserError("The callback requires an organization-scoped execution.")
    rows: list[dict[str, Any]] = []
    offset = 0
    while len(rows) < 10_000:
        result = await tables.query(ASSIGNMENTS, where={"organization_id": organization_id}, limit=1_000, offset=offset)
        page = [_row(document) for document in getattr(result, "documents", [])]
        rows.extend(page)
        if len(page) < 1_000:
            return rows
        offset += len(page)
    raise UserError("Policy assignments exceeded the safe callback read limit.")


def _metadata(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _actor_id() -> str:
    user = getattr(context, "user", None)
    return str(getattr(user, "id", None) or getattr(context, "user_id", "") or "")


def _authorize_callback() -> None:
    actor_id = _actor_id()
    if getattr(context, "is_platform_admin", False):
        return
    # Event subscribers execute as the engine. This callback can only advance
    # an existing request identified by an unguessable notification UUID.
    if actor_id == ENGINE_USER_ID:
        return
    raise UserError("A platform administrator or event listener is required to record notification delivery.")


@workflow(
    name="grc_v2_record_notification_result",
    description="Record the delivery result returned by a GRC policy notification listener.",
    category="grc",
)
async def grc_v2_record_notification_result(
    notification_id: str,
    status: str,
    error: str | None = None,
    provider_message_id: str | None = None,
) -> dict[str, str]:
    """Advance one requested notification to its listener-reported terminal state."""
    _authorize_callback()
    notification_id = str(notification_id or "").strip()
    status = str(status or "").strip().casefold()
    if not notification_id:
        raise UserError("notification_id is required.")
    if status not in {"sent", "failed"}:
        raise UserError("status must be sent or failed.")

    for assignment in await _assignments():
        metadata = _metadata(assignment.get("metadata_json"))
        notices = metadata.get("notifications")
        if not isinstance(notices, list):
            continue
        notice = next(
            (item for item in notices if isinstance(item, dict) and item.get("notification_id") == notification_id),
            None,
        )
        if notice is None:
            continue
        current = str(notice.get("status") or "")
        if current == status:
            return {"notification_id": notification_id, "assignment_id": str(assignment["id"]), "status": status}
        if current != "requested":
            raise UserError(f"Notification result cannot transition from {current or 'an unknown state'} to {status}.")
        notice["status"] = status
        notice["completed_at"] = datetime.now(UTC).isoformat()
        if error:
            notice["error"] = str(error)
        if provider_message_id:
            notice["provider_message_id"] = str(provider_message_id)
        await tables.update(ASSIGNMENTS, str(assignment["id"]), {
            "metadata_json": json.dumps(metadata, sort_keys=True, separators=(",", ":")),
        })
        return {"notification_id": notification_id, "assignment_id": str(assignment["id"]), "status": status}
    raise UserError("Unknown notification_id.")
