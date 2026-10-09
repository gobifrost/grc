"""Delivery-result callback behavior for GRC policy notification events."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


sys.path.insert(0, str(Path(__file__).parents[1]))
from workflows.grc_v2 import grc_policy_notification as notification


class Tables:
    def __init__(self):
        self.rows = [{
            "id": "assignment-1",
            "data": {
                "organization_id": "org-1",
                "metadata_json": json.dumps({"notifications": [{
                    "notification_id": "notice-1", "kind": "invite", "status": "requested",
                    "requested_at": "2026-10-01T00:00:00+00:00", "subscribers_notified": 1,
                }]}),
            },
        }]

    async def query(self, _table, where=None, limit=1000, offset=0):
        documents = [
            SimpleNamespace(id=row["id"], data=dict(row["data"]))
            for row in self.rows
            if all(row["data"].get(key) == value for key, value in (where or {}).items())
        ]
        return SimpleNamespace(documents=documents[offset : offset + limit])

    async def update(self, _table, row_id, payload):
        row = next(row for row in self.rows if row["id"] == row_id)
        row["data"].update(payload)
        return SimpleNamespace(id=row_id, data=dict(row["data"]))


def _install(monkeypatch, *, actor_id="admin", is_platform_admin=True):
    monkeypatch.setattr(notification, "tables", Tables())
    monkeypatch.setattr(notification, "context", SimpleNamespace(
        org_id="org-1", user=SimpleNamespace(id=actor_id), user_id=actor_id, is_platform_admin=is_platform_admin,
    ))


def test_callback_authorizes_platform_admin_and_transitions_once(monkeypatch):
    _install(monkeypatch)

    result = asyncio.run(notification.grc_v2_record_notification_result(
        "notice-1", "sent", provider_message_id="message-1",
    ))

    assert result == {"notification_id": "notice-1", "assignment_id": "assignment-1", "status": "sent"}
    entry = json.loads(notification.tables.rows[0]["data"]["metadata_json"])["notifications"][0]
    assert entry["status"] == "sent"
    assert entry["provider_message_id"] == "message-1"
    assert entry["completed_at"]
    assert asyncio.run(notification.grc_v2_record_notification_result("notice-1", "sent"))["status"] == "sent"
    with pytest.raises(notification.UserError, match="transition"):
        asyncio.run(notification.grc_v2_record_notification_result("notice-1", "failed", error="Late failure"))


def test_callback_allows_engine_but_rejects_other_callers_and_unknown_ids(monkeypatch):
    _install(monkeypatch, actor_id=notification.ENGINE_USER_ID, is_platform_admin=False)
    assert asyncio.run(notification.grc_v2_record_notification_result("notice-1", "failed", error="Provider unavailable"))["status"] == "failed"

    _install(monkeypatch, actor_id="member", is_platform_admin=False)
    with pytest.raises(notification.UserError, match="platform administrator or event listener"):
        asyncio.run(notification.grc_v2_record_notification_result("notice-1", "sent"))

    _install(monkeypatch)
    with pytest.raises(notification.UserError, match="Unknown notification"):
        asyncio.run(notification.grc_v2_record_notification_result("missing", "sent"))


def test_callback_does_not_scan_notification_records_from_other_organizations(monkeypatch):
    _install(monkeypatch)
    notification.tables.rows.append({
        "id": "assignment-other",
        "data": {"organization_id": "org-2", "metadata_json": json.dumps({"notifications": [{
            "notification_id": "notice-other", "kind": "invite", "status": "requested",
        }]})},
    })

    with pytest.raises(notification.UserError, match="Unknown notification"):
        asyncio.run(notification.grc_v2_record_notification_result("notice-other", "sent"))
