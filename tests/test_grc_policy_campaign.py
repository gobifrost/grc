"""Focused behavior tests for GRC policy sign-off campaign preparation."""

from __future__ import annotations

import re

import asyncio
import json
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

from functions import grc_auth
from workflows.grc_v2 import grc_policy_campaign as campaign


class FakeTables:
    def __init__(self):
        self.rows = {
            campaign.TABLE_TEMPLATES: [],
            campaign.TABLE_POLICIES: [],
            campaign.TABLE_CAMPAIGNS: [],
            campaign.TABLE_ASSIGNMENTS: [],
            campaign.TABLE_ACCEPTANCES: [],
        }
        self.inserts: list[tuple[str, str, dict]] = []
        self.updates: list[tuple[str, str, dict]] = []

    async def query(self, table, where=None, limit=1000, offset=0, **_kwargs):
        where = where or {}
        rows = [
            SimpleNamespace(id=row["id"], data=dict(row["data"]))
            for row in self.rows.get(table, [])
            if all(row["data"].get(key) == value for key, value in where.items())
        ]
        return SimpleNamespace(documents=rows[offset : offset + limit])

    async def get(self, table, row_id, **_kwargs):
        for row in self.rows.get(table, []):
            if row["id"] == row_id:
                return SimpleNamespace(id=row_id, data=dict(row["data"]))
        return None

    async def insert(self, table, payload, id=None, **_kwargs):
        row_id = id or f"{table}-{len(self.rows.setdefault(table, [])) + 1}"
        row = {"id": row_id, "data": dict(payload)}
        self.rows.setdefault(table, []).append(row)
        self.inserts.append((table, row_id, dict(payload)))
        return SimpleNamespace(id=row_id, data=dict(payload))

    async def update(self, table, row_id, payload, **_kwargs):
        for row in self.rows.get(table, []):
            if row["id"] == row_id:
                row["data"].update(payload)
                self.updates.append((table, row_id, dict(payload)))
                return SimpleNamespace(id=row_id, data=dict(row["data"]))
        raise AssertionError(f"missing {table}/{row_id}")


def install_context(monkeypatch, *, org_id="org-1", provider=True):
    ctx = SimpleNamespace(
        org_id=org_id,
        user=SimpleNamespace(id="admin-1", email="admin@example.test", display_name="Policy Owner"),
        organization=SimpleNamespace(id="provider-org", name="Provider", is_provider=provider),
        is_platform_admin=False,
        public_url="https://bifrost.example.test/",
    )
    ctx.set_scope = lambda value: setattr(ctx, "org_id", value)
    monkeypatch.setattr(campaign, "context", ctx)
    monkeypatch.setattr(grc_auth, "context", ctx)
    return ctx


def fields(**overrides):
    values = {
        "organization_name": "Example Co",
        "policy_owner_name": "Pat Owner",
        "policy_owner_title": "Operations Manager",
        "approved_ai_tools": "ChatGPT Enterprise",
        "approved_tool_note": "It is covered by our organization agreement.",
        "it_contact": "the IT team",
        "additional_restricted_data": "customer case files",
    }
    values.update(overrides)
    return values


def test_render_policy_template_validates_required_fields_unknown_markers_and_optional_lines():
    content = "Use {{approved_ai_tools}}. {{approved_tool_note}}\n\n- {{additional_restricted_data}}\n\nAsk {{it_contact}} at {{organization_name}}."

    rendered = campaign.render_policy_template(
        content,
        fields(approved_tool_note="", additional_restricted_data=""),
    )

    assert "  " not in rendered
    assert "additional_restricted_data" not in rendered
    assert "\n- \n" not in rendered
    with pytest.raises(campaign.UserError, match="organization_name"):
        campaign.render_policy_template(content, fields(organization_name=""))
    with pytest.raises(campaign.UserError, match="unknown placeholder"):
        campaign.render_policy_template("{{not_a_field}}", fields())
    with pytest.raises(campaign.UserError, match="Unknown template field"):
        campaign.render_policy_template(content, fields(unexpected="value"))


@pytest.mark.parametrize("tools,expected", [
    (["A"], "A"),
    (["A", "B"], "A and B"),
    (["A", "B", "C"], "A, B, and C"),
    ("A", "A"),
])
def test_v11_rendering_preserves_approved_text_and_list_spacing(tools, expected):
    rendered = campaign.render_policy_template(
        {"content": campaign.AI_TEMPLATE_CONTENT, "field_schema": campaign.AI_TEMPLATE_FIELD_SCHEMA,
         "content_updated_at": "2026-10-01"},
        fields(approved_ai_tools=tools, approved_tool_note="", additional_restricted_data=""),
    )
    assert rendered.startswith("**Example Co** · Owner: Pat Owner, Operations Manager · Effective October 1, 2026")
    assert f"**{expected}**." in rendered
    assert "  " not in rendered
    assert ";\n" not in rendered
    assert "- health or medical information about any person\n\nUse client or customer information" in rendered
    assert "- \n" not in rendered
    assert "## Decisions About People" in rendered
    assert "## Meetings and Recordings" in rendered
    assert "## Report Problems Right Away" in rendered
    assert "- an AI tool does something you did not ask it to do\n\nReporting a mistake" in rendered
    assert "{{" not in rendered


def test_template_field_schema_supports_other_templates():
    template = {"content": "Hello {{contact}}.", "field_schema": [{"key": "contact", "required": True, "description": "Contact"}]}
    assert campaign.render_policy_template(template, {"contact": "Ada"}) == "Hello Ada.\n"
    with pytest.raises(campaign.UserError, match="organization_name|Unknown template field"):
        campaign.render_policy_template(template, fields())


def test_seed_template_contains_exact_employee_parent_body(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    monkeypatch.setattr(campaign, "tables", fake_tables)

    result = asyncio.run(campaign.grc_v2_seed_ai_acceptable_use_template())
    repeated = asyncio.run(campaign.grc_v2_seed_ai_acceptable_use_template())

    assert result["template_id"] == repeated["template_id"]
    assert len(fake_tables.rows[campaign.TABLE_TEMPLATES]) == 2
    content = next(row["data"]["content"] for row in fake_tables.rows[campaign.TABLE_TEMPLATES] if row["data"]["source_id"] == campaign.AI_PARENT_TEMPLATE_SOURCE_ID)
    assert content.startswith("## Approved AI Tools")
    assert "Addendum fields" not in content
    assert "This is the short policy" not in content
    assert "Gemini" not in content
    row = next(row for row in fake_tables.rows[campaign.TABLE_TEMPLATES] if row["data"]["source_id"] == campaign.AI_PARENT_TEMPLATE_SOURCE_ID)
    assert row["data"]["version"] == "2.1"
    # Bullets start with a capital (Jack, October 1).
    assert all(line[2:3].isupper() for line in content.splitlines() if line.startswith("- "))
    assert row["data"]["name"] == campaign.AI_PARENT_TEMPLATE_NAME
    assert row["data"]["field_schema"] == []


def test_seed_archives_legacy_template_without_rewriting_its_history(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    template_id = campaign._stable_id(campaign.TABLE_TEMPLATES, campaign.AI_TEMPLATE_SOURCE_ID)
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({"id": template_id, "data": {
        "source_id": campaign.AI_TEMPLATE_SOURCE_ID, "name": "Old name", "content": "Old body", "version": "1.0",
    }})
    monkeypatch.setattr(campaign, "tables", fake_tables)
    result = asyncio.run(campaign.grc_v2_seed_ai_acceptable_use_template())
    assert result["parent_template_id"] == campaign._stable_id(campaign.TABLE_TEMPLATES, campaign.AI_PARENT_TEMPLATE_SOURCE_ID)
    assert len(fake_tables.rows[campaign.TABLE_TEMPLATES]) == 3
    assert fake_tables.rows[campaign.TABLE_TEMPLATES][0]["data"]["content"] == "Old body"
    assert fake_tables.rows[campaign.TABLE_TEMPLATES][0]["data"]["status"] == "archived"
    assert fake_tables.updates[0][1] == template_id


def test_v20_seed_creates_deterministic_parent_and_addendum_and_retires_v11(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    legacy_id = campaign._stable_id(campaign.TABLE_TEMPLATES, campaign.AI_TEMPLATE_SOURCE_ID)
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({"id": legacy_id, "data": {
        "source_id": campaign.AI_TEMPLATE_SOURCE_ID, "status": "active", "content": "Historical policy",
    }})
    monkeypatch.setattr(campaign, "tables", fake_tables)

    first = asyncio.run(campaign.grc_v2_seed_ai_acceptable_use_template())
    second = asyncio.run(campaign.grc_v2_seed_ai_acceptable_use_template())

    assert first == second
    by_source = {row["data"].get("source_id"): row for row in fake_tables.rows[campaign.TABLE_TEMPLATES]}
    parent = by_source[campaign.AI_PARENT_TEMPLATE_SOURCE_ID]["data"]
    addendum = by_source[campaign.AI_ADDENDUM_TEMPLATE_SOURCE_ID]["data"]
    assert parent["version"] == "2.1" and parent["field_schema"] == []
    assert parent["content"] == campaign.AI_PARENT_TEMPLATE_CONTENT
    assert addendum["default_policy_role"] == "extension"
    # Preview and send refuse a template that is not active.
    assert parent["status"] == "active" and addendum["status"] == "active"
    assert addendum["base_policy_type"] == "ai_acceptable_use"
    assert addendum["field_schema"] == campaign.AI_ADDENDUM_TEMPLATE_FIELD_SCHEMA
    assert by_source[campaign.AI_TEMPLATE_SOURCE_ID]["data"]["status"] == "archived"
    assert len(fake_tables.rows[campaign.TABLE_POLICIES]) == 1
    base = fake_tables.rows[campaign.TABLE_POLICIES][0]
    assert base["id"] == campaign._stable_id(campaign.TABLE_POLICIES, campaign.AI_PARENT_TEMPLATE_SOURCE_ID)
    assert base["data"]["policy_role"] == "base"
    assert base["data"]["applied_organizations"] is None


@pytest.mark.parametrize("meeting_rule,expected", [
    ("allowed_with_notice", "You may use AI to take notes in meetings and calls when you tell everyone first, and you stop if anyone objects."),
    ("ask_first", "Ask the IT team before you use AI to record, transcribe, or summarize a meeting or call."),
    ("not_allowed", "Do not use AI to record, transcribe, or summarize meetings or calls."),
])
def test_addendum_rendering_applies_all_enum_and_omission_rules(meeting_rule, expected):
    addendum_fields = {
        "organization_name": "Example Co", "policy_owner_name": "Pat Owner", "policy_owner_title": "Operations Manager",
        "approved_ai_tools": ["Tool A", "Tool B", "Tool C"], "approved_tool_note": "", "approved_connections": ["Email", "Files"],
        "additional_restricted_data": ["Client case files", "Source code"], "client_contracts": "manager_approval",
        "meeting_rule": meeting_rule, "it_contact": "the IT team",
    }
    rendered = campaign.render_policy_template(campaign._addendum_template(), addendum_fields, effective_date=date(2026, 10, 1))
    assert "**Tool A, Tool B, and Tool C**." in rendered
    assert "**Tool A, Tool B, and Tool C**. The approved tools may connect to: Email, Files." in rendered
    assert "## Also Never Enter\n\n- Client case files\n- Source code" in rendered
    assert "## Client Information" in rendered
    assert expected in rendered
    assert "  " not in rendered and ";\n" not in rendered and "{{" not in rendered
    assert "- Source code\n\n## Client Information" in rendered

    omitted = campaign.render_policy_template(campaign._addendum_template(), {
        **addendum_fields, "approved_ai_tools": ["Tool A", "Tool B"], "approved_connections": [],
        "additional_restricted_data": [], "client_contracts": "none", "meeting_rule": "allowed_with_notice",
    }, effective_date=date(2026, 10, 1))
    assert "## Also Never Enter" not in omitted
    assert "## Client Information" not in omitted
    assert "may connect to:" not in omitted
    assert "**Tool A and Tool B**." in omitted

    with pytest.raises(campaign.UserError, match="meeting_rule"):
        campaign.render_policy_template(campaign._addendum_template(), {**addendum_fields, "meeting_rule": "unknown"})


def test_prepare_addendum_is_idempotent_and_links_the_active_parent(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    parent_id = "parent"
    template_id = "addendum-template"
    fake_tables.rows[campaign.TABLE_POLICIES].append({"id": parent_id, "data": {
        "name": campaign.AI_PARENT_TEMPLATE_NAME, "status": "active", "version": "2.0", "policy_type": "ai_acceptable_use",
        "policy_role": "base", "applied_organizations": None,
    }})
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({"id": template_id, "data": {
        **campaign._addendum_template(), "status": "active", "applied_organizations": None,
    }})
    monkeypatch.setattr(campaign, "tables", fake_tables)
    addendum_fields = {"organization_name": "Example Co", "policy_owner_name": "Pat", "policy_owner_title": "Owner", "approved_ai_tools": ["Tool A"], "approved_tool_note": "", "approved_connections": [], "additional_restricted_data": [], "client_contracts": "none", "meeting_rule": "allowed_with_notice", "it_contact": "IT"}

    first = asyncio.run(campaign.grc_v2_prepare_policy_addendum("org-1", template_id, addendum_fields))
    same = asyncio.run(campaign.grc_v2_prepare_policy_addendum("org-1", template_id, addendum_fields))
    changed = asyncio.run(campaign.grc_v2_prepare_policy_addendum("org-1", template_id, {**addendum_fields, "it_contact": "Support"}))

    assert first["base_policy_id"] == parent_id and first["base_version"] == "2.0"
    assert first["addendum_policy_id"] == same["addendum_policy_id"] == changed["addendum_policy_id"]
    assert same["addendum_version"] == "1.0" and changed["addendum_version"] == "1.1"
    row = fake_tables.rows[campaign.TABLE_POLICIES][1]["data"]
    assert row["base_policy_id"] == parent_id and row["policy_role"] == "extension"


def test_addendum_preview_keeps_the_existing_effective_date_without_saving(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    parent_id = "parent"
    template_id = "addendum-template"
    addendum_fields = {"organization_name": "Example Co", "policy_owner_name": "Pat", "policy_owner_title": "Owner", "approved_ai_tools": ["Tool A"], "approved_tool_note": "", "approved_connections": [], "additional_restricted_data": [], "client_contracts": "none", "meeting_rule": "allowed_with_notice", "it_contact": "IT"}
    template = {**campaign._addendum_template(), "status": "active", "applied_organizations": None}
    original = campaign.render_policy_template(template, addendum_fields, effective_date=date(2026, 10, 1))
    fake_tables.rows[campaign.TABLE_POLICIES].extend([
        {"id": parent_id, "data": {"status": "active", "version": "2.0", "policy_type": "ai_acceptable_use", "policy_role": "base", "applied_organizations": None}},
        {"id": "addendum", "data": {"status": "active", "version": "1.0", "policy_role": "extension", "base_policy_id": parent_id, "template_id": template_id, "applied_organizations": ["org-1"], "content": original}},
    ])
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({"id": template_id, "data": template})
    monkeypatch.setattr(campaign, "tables", fake_tables)
    monkeypatch.setattr(campaign, "_today", lambda: date(2026, 10, 2))

    preview = asyncio.run(campaign.preview_policy_addendum_for_authorized_caller("org-1", template_id, addendum_fields))

    assert preview["addendum_markdown"] == original
    # Unchanged content keeps the stored addendum version; callers read this shape.
    assert preview["addendum"]["content"] == original
    assert set(preview["parent"]) == {"name", "version", "content"}
    assert not fake_tables.updates


def test_generic_prepare_rejects_extension_template_without_parent_link(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({"id": "addendum-template", "data": {
        **campaign._addendum_template(), "status": "active", "applied_organizations": None,
    }})
    monkeypatch.setattr(campaign, "tables", fake_tables)

    with pytest.raises(campaign.UserError, match="grc_v2_prepare_policy_addendum"):
        asyncio.run(campaign.grc_v2_prepare_policy("org-1", "addendum-template", {}))
    assert not fake_tables.rows[campaign.TABLE_POLICIES]


def test_addendum_workflows_are_registered_and_solution_version_advances():
    import yaml
    workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
    registered = {row["function_name"]: row for row in workflows.values()}
    assert registered["grc_v2_prepare_policy_addendum"]["role_names"] == ["GRC Administrator", "GRC Contributor"]
    assert registered["grc_caller_preview_addendum"]["access_level"] == "authenticated"
    assert registered["grc_v2_reissue_for_base_policy"]["access_level"] == "authenticated"
    version = re.search(r"^version: (\d+)\.(\d+)\.(\d+)$", (ROOT / "bifrost.solution.yaml").read_text(), re.M)
    assert version and tuple(int(part) for part in version.groups()) >= (0, 13, 0)


def test_prepare_policy_is_idempotent_and_bumps_minor_on_changed_content(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({
        "id": "template-1",
        "data": {
            "name": "AI Acceptable Use (small business)",
            "default_name": "AI Acceptable Use",
            "content": "## Policy\n{{organization_name}} may use {{approved_ai_tools}}. {{it_contact}}.",
            "version": "1.0",
            "status": "active",
            "applied_organizations": None,
        },
    })
    monkeypatch.setattr(campaign, "tables", fake_tables)

    first = asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template-1", fields()))
    repeated = asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template-1", fields()))
    changed = asyncio.run(campaign.grc_v2_prepare_policy(
        "org-1", "template-1", fields(approved_ai_tools="Claude Enterprise"),
    ))

    assert first["policy_id"] == repeated["policy_id"] == changed["policy_id"]
    assert first["version"] == repeated["version"] == "1.0"
    assert changed["version"] == "1.1"
    assert len(fake_tables.rows[campaign.TABLE_POLICIES]) == 1


def test_effective_date_changes_only_when_policy_content_changes(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({"id": "template", "data": {
        "name": campaign.AI_TEMPLATE_NAME, "default_name": campaign.AI_TEMPLATE_NAME,
        "content": campaign.AI_TEMPLATE_CONTENT, "field_schema": campaign.AI_TEMPLATE_FIELD_SCHEMA,
        "content_updated_at": "2026-10-01", "version": "1.1", "status": "active",
    }})
    monkeypatch.setattr(campaign, "tables", fake_tables)
    monkeypatch.setattr(campaign, "_today", lambda: date(2026, 10, 1))
    first = asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template", fields()))
    monkeypatch.setattr(campaign, "_today", lambda: date(2026, 10, 2))
    same = asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template", fields()))
    changed = asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template", fields(it_contact="Support")))
    assert "Effective October 1, 2026" in first["content"]
    assert same == first
    assert changed["version"] == "1.1"
    assert "Effective October 2, 2026" in changed["content"]


def test_prepare_rejects_inactive_template_and_unknown_caller_field(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[campaign.TABLE_TEMPLATES].append({"id": "template", "data": {
        "content": campaign.AI_TEMPLATE_CONTENT, "field_schema": campaign.AI_TEMPLATE_FIELD_SCHEMA,
        "status": "draft", "applied_organizations": None,
    }})
    monkeypatch.setattr(campaign, "tables", fake_tables)
    with pytest.raises(campaign.UserError, match="not available"):
        asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template", fields()))
    fake_tables.rows[campaign.TABLE_TEMPLATES][0]["data"]["status"] = "active"
    with pytest.raises(campaign.UserError, match="Unknown template field.*surprise"):
        asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template", fields(surprise="No")))


def test_default_recipients_filters_active_bifrost_users(monkeypatch):
    install_context(monkeypatch)
    listed_org_ids = []

    async def list_users(*, org_id, include_inactive=False):
        listed_org_ids.append((org_id, include_inactive))
        return [
            SimpleNamespace(id="ada", email="ada@example.test", display_name="Ada Member", is_active=True),
            SimpleNamespace(id=campaign.ENGINE_USER_ID, email="engine@example.test", display_name="Engine", is_active=True),
            SimpleNamespace(id="inactive", email="inactive@example.test", display_name="Inactive", is_active=False),
            SimpleNamespace(id="no-email", email="", display_name="No Email", is_active=True),
            SimpleNamespace(id="other-org", email="other@example.test", display_name="Other Org", is_active=True, organization_id="org-2"),
            SimpleNamespace(id="global-admin", email="global@example.test", display_name="Global Admin", is_active=True, organization_id=None),
        ]

    monkeypatch.setattr(campaign, "users", SimpleNamespace(list=list_users))

    result = asyncio.run(campaign.grc_v2_default_policy_recipients("org-1"))

    assert listed_org_ids == [("org-1", True)]
    assert result["included"] == [{"email": "ada@example.test", "name": "Ada Member"}]
    assert {(row["name"], row["reason"]) for row in result["excluded"]} == {
        ("Inactive", "Inactive user"),
        ("No Email", "No email address"),
    }


def test_viewer_user_lookup_does_not_reuse_another_organizations_user(monkeypatch):
    created = []
    assigned = []

    async def list_users(*, org_id):
        assert org_id == "org-1"
        return [SimpleNamespace(id="other", email="person@example.test", organization_id="org-2")]

    async def create(email, name, *, org_id):
        created.append((email, name, org_id))
        return SimpleNamespace(id="new", email=email, organization_id=org_id)

    monkeypatch.setattr(campaign, "users", SimpleNamespace(list=list_users, create=create))
    monkeypatch.setattr(campaign, "roles", SimpleNamespace(assign_users=lambda role_id, user_ids: _async(assigned.append((role_id, user_ids)))))

    resolved = asyncio.run(campaign._ensure_viewer_user("org-1", {"email": "person@example.test", "name": "Person"}, "viewer"))

    assert resolved["id"] == "new"
    assert created == [("person@example.test", "Person", "org-1")]
    assert assigned == [("viewer", ["new"])]


def test_direct_campaign_workflows_enforce_grc_role_when_manifest_gates_are_skipped(monkeypatch):
    install_context(monkeypatch, provider=False)
    monkeypatch.setattr(campaign, "roles", SimpleNamespace(
        list=lambda: _async([SimpleNamespace(id="contributor", name="GRC Contributor")]),
        list_users=lambda _role_id: _async([]),
    ))

    with pytest.raises(campaign.UserError, match="authorized GRC role"):
        asyncio.run(campaign.grc_v2_prepare_policy("org-1", "template", fields()))
    with pytest.raises(campaign.UserError, match="authorized GRC role"):
        asyncio.run(campaign.grc_v2_default_policy_recipients("org-1"))
    with pytest.raises(campaign.UserError, match="authorized GRC role"):
        asyncio.run(campaign.grc_v2_send_policy_campaign("org-1", [], []))

    monkeypatch.setattr(campaign, "roles", SimpleNamespace(
        list=lambda: _async([SimpleNamespace(id="contributor", name="GRC Contributor")]),
        list_users=lambda _role_id: _async(["admin-1"]),
    ))
    monkeypatch.setattr(campaign, "users", SimpleNamespace(list=lambda **_kwargs: _async([])))
    assert asyncio.run(campaign.grc_v2_default_policy_recipients("org-1")) == {"included": [], "excluded": []}


def test_send_campaign_publishes_one_notification_per_recipient_and_records_no_listener(monkeypatch):
    install_context(monkeypatch)
    fake_tables = FakeTables()
    fake_tables.rows[campaign.TABLE_POLICIES].append({
        "id": "policy-1",
        "data": {
            "name": "AI Acceptable Use",
            "status": "active",
            "version": "1.0",
            "applied_organizations": ["org-1"],
        },
    })
    monkeypatch.setattr(campaign, "tables", fake_tables)
    monkeypatch.setattr(campaign.grc_integration, "tables", fake_tables)
    monkeypatch.setattr(campaign, "users", SimpleNamespace(list=lambda **_kwargs: _async([]), create=lambda email, name, org_id: _async(SimpleNamespace(id=f"user-{email}", email=email, name=name))))
    assigned_roles = []
    monkeypatch.setattr(campaign, "roles", SimpleNamespace(
        list=lambda: _async([SimpleNamespace(id="viewer-role", name="GRC Viewer")]),
        assign_users=lambda role_id, user_ids: _async(assigned_roles.append((role_id, user_ids))),
    ))
    monkeypatch.setattr(campaign, "organizations", SimpleNamespace(get=lambda _id: _async(SimpleNamespace(name="Example Co"))))
    emitted = []
    persisted_notification_ids = []

    async def emit(topic, payload, *, scope):
        emitted.append((topic, payload, scope))
        assignment = next(row for row in fake_tables.rows[campaign.TABLE_ASSIGNMENTS] if row["id"] == payload["assignment_id"])
        records = json.loads(assignment["data"]["metadata_json"])["notifications"]
        persisted_notification_ids.append(records[-1]["notification_id"])
        return {"event_id": None, "subscribers_notified": 0}

    monkeypatch.setattr(campaign, "events", SimpleNamespace(emit=emit), raising=False)
    # Never read live instance config from a unit test.
    monkeypatch.setattr(campaign, "config", SimpleNamespace(get=lambda _key, default=None: _async(default)))

    result = asyncio.run(campaign.grc_v2_send_policy_campaign(
        "org-1",
        ["policy-1"],
        [{"email": "good@example.test", "name": "Good Person"}, {"email": "bad@example.test", "name": "Bad Person"}, {"email": "waived@example.test", "name": "Waived Person"}],
        waived_reasons={"waived@example.test": "Leave"},
    ))

    assert result["assigned"] == 3
    assert result["requested"] == 0
    assert {entry["email"] for entry in result["failed_notifications"]} == {"good@example.test", "bad@example.test"}
    assert {entry["reason"] for entry in result["failed_notifications"]} == {"No notification listener is configured on this instance."}
    assert len(emitted) == 2
    assert persisted_notification_ids == [payload["notification_id"] for _, payload, _ in emitted]
    assert {topic for topic, _, _ in emitted} == {campaign.NOTIFICATION_TOPIC}
    assert {scope for _, _, scope in emitted} == {"org-1"}
    expected_keys = {"notification_id", "kind", "organization_id", "organization_name", "campaign_id", "assignment_id", "recipient", "policy_name", "due_date", "link_url", "subject", "greeting", "content_html", "content_text", "requested_at"}
    assert all(set(payload) == expected_keys for _, payload, _ in emitted)
    assert {payload["recipient"]["email"] for _, payload, _ in emitted} == {"good@example.test", "bad@example.test"}
    assert all(payload["kind"] == "invite" and payload["organization_name"] == "Example Co" for _, payload, _ in emitted)
    assert all("Review and Sign" in payload["content_html"] and "Review and Sign" in payload["content_text"] for _, payload, _ in emitted)
    assert assigned_roles == [("viewer-role", ["user-good@example.test"]), ("viewer-role", ["user-bad@example.test"]), ("viewer-role", ["user-waived@example.test"])]
    assignments = fake_tables.rows[campaign.TABLE_ASSIGNMENTS]
    notifications = [json.loads(row["data"]["metadata_json"])["notifications"] for row in assignments if row["data"]["status"] != "waived"]
    assert {item[0]["status"] for item in notifications} == {"no_listener"}
    assert all(item[0]["kind"] == "invite" and item[0]["error"] == "No notification listener is configured on this instance." for item in notifications)
    waived = next(row for row in assignments if row["data"]["actor_email"] == "waived@example.test")
    assert waived["data"]["status"] == "waived"
    assert json.loads(waived["data"]["metadata_json"])["waiver_reason"] == "Leave"
    assert result["carried_waivers"] == [{"assignment_id": waived["id"], "email": "waived@example.test", "reason": "Leave"}]


async def _async(value):
    return value


def test_campaign_title_names_parent_for_addendum_pair():
    pair = [{"name": "AI Acceptable Use Policy Addendum", "policy_role": "extension"}, {"name": "AI Acceptable Use Policy", "policy_role": "base"}]
    assert campaign._campaign_title(pair) == "AI Acceptable Use Policy"
    assert campaign._campaign_title([{"name": "Information Security"}]) == "Information Security"
    assert campaign._campaign_title([{"name": "A"}, {"name": "B"}]) == "Policy Sign-Off"


def test_grc_workflows_do_not_import_instance_extension_modules():
    source = "\n".join(
        path.read_text()
        for directory in ("workflows", "functions", "modules")
        for path in (ROOT / directory).rglob("*.py")
    )
    assert "modules" + ".extensions" not in source


def test_addendum_restricted_items_start_with_a_capital():
    assert campaign._capitalize("client network passwords") == "Client network passwords"
    assert campaign._capitalize("SSN exports") == "SSN exports"
