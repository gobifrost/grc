from pathlib import Path
from types import SimpleNamespace
import asyncio
import sys

import pytest
import yaml


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

from functions import grc_auth
from workflows.grc_v2 import grc_policy_recipient as recipient


class FakeTables:
    def __init__(self):
        self.rows = {
            recipient.TABLE_POLICIES: [
                {
                    "id": "policy-global",
                    "data": {
                        "organization_id": "provider-org",
                        "applied_organizations": None,
                        "excluded_organizations": [],
                        "name": "Acceptable use",
                        "content": "Approved for every customer.",
                        "status": "active",
                        "version": "1.0",
                    },
                },
                {
                    "id": "policy-customer",
                    "data": {
                        "organization_id": "provider-org",
                        "applied_organizations": ["customer-org"],
                        "excluded_organizations": [],
                        "name": "Customer-specific policy",
                        "content": "Approved for this customer.",
                        "status": "active",
                        "version": "1.1",
                    },
                },
                {
                    "id": "policy-other-customer",
                    "data": {
                        "organization_id": "provider-org",
                        "applied_organizations": ["other-customer"],
                        "excluded_organizations": [],
                        "name": "Other customer policy",
                        "content": "Must not be returned.",
                        "status": "active",
                    },
                },
                {
                    "id": "policy-draft",
                    "data": {
                        "organization_id": "provider-org",
                        "applied_organizations": None,
                        "excluded_organizations": [],
                        "name": "Draft policy",
                        "content": "Must not be returned.",
                        "status": "draft",
                    },
                },
            ],
            recipient.TABLE_CAMPAIGNS: [
                {
                    "id": "campaign-1",
                    "data": {
                        "organization_id": "customer-org",
                        "status": "active",
                        "policy_ids_json": '["policy-global", "policy-customer"]',
                        "policy_versions_json": '{"policy-global":"1.0","policy-customer":"1.1"}',
                    },
                },
            ],
            recipient.TABLE_ASSIGNMENTS: [
                {
                    "id": "assignment-1",
                    "data": {
                        "organization_id": "customer-org",
                        "campaign_id": "campaign-1",
                        "actor_id": "recipient-user",
                        "status": "assigned",
                    },
                },
            ],
            recipient.TABLE_ACCEPTANCES: [],
        }
        self.inserts = []

    async def query(self, table, where=None, limit=1000, **_kwargs):
        where = where or {}
        documents = []
        for row in self.rows.get(table, []):
            data = row["data"]
            if all(data.get(key) == value for key, value in where.items()):
                documents.append(SimpleNamespace(id=row["id"], data=dict(data)))
        return SimpleNamespace(documents=documents[:limit])

    async def get(self, table, row_id):
        for row in self.rows.get(table, []):
            if row["id"] == row_id:
                return SimpleNamespace(id=row_id, data=dict(row["data"]))
        return None

    async def insert(self, table, payload, id=None):
        row_id = id or f"{table}-{len(self.rows.setdefault(table, [])) + 1}"
        row = {"id": row_id, "data": dict(payload)}
        self.rows.setdefault(table, []).append(row)
        self.inserts.append((table, row_id, dict(payload)))
        return SimpleNamespace(**row)

    async def update(self, table, row_id, payload):
        for row in self.rows.get(table, []):
            if row["id"] == row_id:
                row["data"].update(payload)
                return SimpleNamespace(id=row_id, data=dict(row["data"]))
        raise AssertionError(f"missing row {table}:{row_id}")


def install_context(monkeypatch, *, org_id="customer-org", user_id="recipient-user", is_provider=False):
    ctx = SimpleNamespace(
        org_id=org_id,
        user=SimpleNamespace(
            id=user_id,
            email="recipient@example.test",
            display_name="Policy Recipient",
        ),
        organization=SimpleNamespace(is_provider=is_provider),
        is_platform_admin=False,
    )
    monkeypatch.setattr(recipient, "context", ctx)
    monkeypatch.setattr(grc_auth, "context", ctx)
    return ctx


def test_recipient_reads_only_active_policies_applicable_to_its_organization(monkeypatch):
    install_context(monkeypatch)
    monkeypatch.setattr(recipient, "tables", FakeTables())

    result = asyncio.run(recipient.grc_v2_get_recipient_policies())

    assert [policy["id"] for policy in result["policies"]] == ["policy-global", "policy-customer"]
    assert {"content", "attachments"} <= set(result["policies"][0])


def test_recipient_acceptance_requires_its_active_campaign_assignment(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    monkeypatch.setattr(recipient, "tables", fake_tables)

    result = asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))

    assert result["status"] == "accepted"
    assert result["acceptance"]["actor_id"] == "recipient-user"
    assert len(fake_tables.inserts) == 1
    table, _, inserted = fake_tables.inserts[0]
    assert table == recipient.TABLE_ACCEPTANCES
    assert inserted == {
        "organization_id": "customer-org",
        "campaign_id": "campaign-1",
        "assignment_id": "assignment-1",
        "actor_id": "recipient-user",
        "actor_email": "recipient@example.test",
        "actor_display_name": "Policy Recipient",
        "accepted_policy_ids_json": '["policy-customer","policy-global"]',
        "accepted_policy_versions_json": '{"policy-customer":"1.1","policy-global":"1.0"}',
        "status": "accepted",
        "accepted_at": result["acceptance"]["accepted_at"],
        "source_system": "bifrost_grc_policy_recipient",
    }
    assignment = fake_tables.rows[recipient.TABLE_ASSIGNMENTS][0]["data"]
    assert assignment["status"] == "accepted"
    assert assignment["metadata_json"] == '{"accepted_at":"' + result["acceptance"]["accepted_at"] + '"}'


def test_recipient_lists_only_own_active_assignments_and_acceptance_is_idempotent(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[recipient.TABLE_ASSIGNMENTS].append({
        "id": "assignment-other", "data": {"organization_id": "customer-org", "campaign_id": "campaign-1", "actor_id": "other-user", "status": "assigned"},
    })
    monkeypatch.setattr(recipient, "tables", fake_tables)
    listed = asyncio.run(recipient.grc_v2_get_my_policy_assignments())
    assert [item["assignment_id"] for item in listed["assignments"]] == ["assignment-1"]
    assert [policy["version"] for policy in listed["assignments"][0]["policies"]] == ["1.0", "1.1"]
    asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))
    second = asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))
    assert second["status"] == "already_accepted"
    assert len(fake_tables.inserts) == 1
    fake_tables.rows[recipient.TABLE_POLICIES][0]["data"]["version"] = "2.0"
    fake_tables.rows[recipient.TABLE_CAMPAIGNS][0]["data"]["status"] = "closed"
    assert asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))["status"] == "already_accepted"


def test_assignment_uses_sent_content_snapshot_and_flags_changed_version(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    campaign = fake_tables.rows[recipient.TABLE_CAMPAIGNS][0]["data"]
    campaign["metadata_json"] = '{"policy_contents":{"policy-global":"Original approved text"}}'
    fake_tables.rows[recipient.TABLE_POLICIES][0]["data"].update(content="Revised text", version="1.1")
    monkeypatch.setattr(recipient, "tables", fake_tables)
    result = asyncio.run(recipient.grc_v2_get_my_policy_assignments())
    assignment = result["assignments"][0]
    assert assignment["stale"] is True
    assert assignment["policies"][0]["version"] == "1.0"
    assert assignment["policies"][0]["content"] == "Original approved text"


def test_assignment_preserves_base_addendum_order_and_role_metadata(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[recipient.TABLE_POLICIES][0]["data"].update(policy_role="base")
    fake_tables.rows[recipient.TABLE_POLICIES][1]["data"].update(policy_role="extension", base_policy_id="policy-global")
    monkeypatch.setattr(recipient, "tables", fake_tables)

    policies = asyncio.run(recipient.grc_v2_get_my_policy_assignments())["assignments"][0]["policies"]

    assert [policy["policy_role"] for policy in policies] == ["base", "extension"]
    assert policies[1]["base_policy_id"] == "policy-global"
    assert policies[1]["organization_name"] == "customer-org"


def test_recipient_cannot_accept_a_campaign_assigned_to_another_person(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[recipient.TABLE_ASSIGNMENTS][0]["data"]["actor_id"] = "other-user"
    monkeypatch.setattr(recipient, "tables", fake_tables)

    with pytest.raises(recipient.UserError, match="assigned"):
        asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))

    assert not fake_tables.inserts


def test_recipient_rejects_function_key_context(monkeypatch):
    ctx = install_context(monkeypatch)
    ctx.is_function_key = True
    monkeypatch.setattr(recipient, "tables", FakeTables())

    with pytest.raises(recipient.UserError, match="authenticated user"):
        asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))


def test_recipient_cannot_accept_an_assignment_in_an_unknown_state(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[recipient.TABLE_ASSIGNMENTS][0]["data"]["status"] = "pending"
    monkeypatch.setattr(recipient, "tables", fake_tables)

    with pytest.raises(recipient.UserError, match="assigned"):
        asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))

    assert not fake_tables.inserts


def test_recipient_rejects_campaign_when_current_policy_version_has_drifted(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[recipient.TABLE_POLICIES][0]["data"]["version"] = "2.0"
    monkeypatch.setattr(recipient, "tables", fake_tables)

    with pytest.raises(recipient.UserError, match="stale"):
        asyncio.run(recipient.grc_v2_record_policy_acceptance("campaign-1"))

    assert not fake_tables.inserts


def test_recipient_policy_listing_paginates_past_the_first_thousand_rows(monkeypatch):
    install_context(monkeypatch)

    class PagedTables(FakeTables):
        async def query(self, table, where=None, limit=1000, offset=0, **_kwargs):
            result = await super().query(table, where=where, limit=10_000)
            return SimpleNamespace(documents=result.documents[offset : offset + limit])

    fake_tables = PagedTables()
    fake_tables.rows[recipient.TABLE_POLICIES] = [
        {
            "id": f"irrelevant-{index}",
            "data": {
                "organization_id": "provider-org",
                "applied_organizations": ["other-customer"],
                "excluded_organizations": [],
                "name": f"Irrelevant {index}",
                "status": "active",
            },
        }
        for index in range(1_000)
    ] + [
        {
            "id": "policy-late",
            "data": {
                "organization_id": "provider-org",
                "applied_organizations": ["customer-org"],
                "excluded_organizations": [],
                "name": "Late policy",
                "status": "active",
                "version": "1.0",
            },
        }
    ]
    monkeypatch.setattr(recipient, "tables", fake_tables)

    result = asyncio.run(recipient.grc_v2_get_recipient_policies())

    assert [policy["id"] for policy in result["policies"]] == ["policy-late"]


def test_recipient_role_is_workflow_only_and_has_no_broad_table_or_app_access():
    tables = yaml.safe_load((ROOT / ".bifrost/tables.yaml").read_text())["tables"]
    tables_by_name = {table["name"]: table for table in tables.values()}
    workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
    app = next(
        row for row in yaml.safe_load((ROOT / ".bifrost/apps.yaml").read_text())["apps"].values()
        if row.get("slug") == "bifrost-grc"
    )

    recipient_workflows = {
        row["function_name"]: row
        for row in workflows.values()
        if row.get("function_name") in {
            "grc_v2_get_recipient_policies",
            "grc_v2_record_policy_acceptance",
            "grc_v2_get_recipient_policy_download_url",
        }
    }
    assert set(recipient_workflows) == {
        "grc_v2_get_recipient_policies",
        "grc_v2_record_policy_acceptance",
        "grc_v2_get_recipient_policy_download_url",
    }
    assert all(row["role_names"] == ["GRC Viewer"] for row in recipient_workflows.values())
    assert "GRC Viewer" not in app["role_names"]

    policy_roles = yaml.safe_dump(tables_by_name[recipient.TABLE_POLICIES]["policies"])
    assert "GRC Viewer" not in policy_roles
    acceptance_policies = tables_by_name[recipient.TABLE_ACCEPTANCES]["policies"]
    recipient_policies = [policy for policy in acceptance_policies if "GRC Viewer" in yaml.safe_dump(policy)]
    assert len(recipient_policies) == 1
    assert recipient_policies[0]["actions"] == ["read"]
    assert "actor_id" in yaml.safe_dump(recipient_policies[0]["when"])
