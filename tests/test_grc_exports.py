import asyncio
import base64
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
import yaml


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

from functions import grc_auth  # noqa: E402
from workflows.grc_v2 import grc_exports as exports  # noqa: E402
from workflows.grc_v2 import grc_agent_tools, grc_policy_admin, grc_policy_recipient  # noqa: E402


class FakeTables:
    def __init__(self):
        self.rows = {
            exports.TABLE_POLICIES: [
                {"id": "base", "data": {"organization_id": "provider", "applied_organizations": None, "excluded_organizations": [], "name": "Security Policy", "content": "Base policy", "policy_role": "base", "version": "2", "status": "active"}},
                {"id": "addendum", "data": {"organization_id": "provider", "applied_organizations": ["customer"], "excluded_organizations": [], "name": "Customer Addendum", "content": "Customer additions", "policy_role": "extension", "base_policy_id": "base", "version": "1", "status": "active", "effective_date": "2026-01-01"}},
            ],
            exports.TABLE_ASSESSMENTS: [
                {"id": "assessment", "data": {"organization_id": "provider", "applied_organizations": ["customer"], "excluded_organizations": [], "framework_id": "framework", "name": "Annual review", "status": "in_progress", "progress_percentage": 50, "assigned_to": "Owner"}},
            ],
            exports.TABLE_FRAMEWORKS: [
                {"id": "framework", "data": {"name": "NIST CSF", "version": "2.0"}},
            ],
            exports.TABLE_ASSESSMENT_CONTROLS: [
                {"id": "assessment-control", "data": {"organization_id": "provider", "assessment_id": "assessment", "control_id": "control", "status": "not_assessed", "implementation_percentage": 0, "notes": "Default note"}},
            ],
            exports.TABLE_ASSESSMENT_CONTROL_OVERRIDES: [
                {"id": "override", "data": {"organization_id": "provider", "customer_organization_id": "customer", "assessment_id": "assessment", "control_id": "control", "status": "compliant", "implementation_percentage": 100, "notes": "Verified for customer"}},
            ],
            exports.TABLE_CONTROLS: [
                {"id": "control", "data": {"framework_id": "framework", "domain_id": "domain", "control_id": "AC-1", "title": "Access Control", "description": "Control description"}},
            ],
            exports.TABLE_DOMAINS: [
                {"id": "domain", "data": {"framework_id": "framework", "name": "Access management"}},
            ],
            exports.TABLE_EVIDENCE: [
                {"id": "evidence", "data": {"organization_id": "provider", "applied_organizations": ["customer"], "excluded_organizations": [], "assessment_id": "assessment", "control_id": "control", "name": "Access review", "type": "note", "notes": "Reviewed quarterly", "url": "https://example.test/evidence"}},
            ],
            exports.TABLE_CAMPAIGNS: [
                {"id": "campaign", "created_at": "2026-02-01T00:00:00+00:00", "data": {"organization_id": "customer", "title": "Annual policy sign-off", "status": "active", "due_date": "2026-03-01", "policy_ids_json": '["addendum"]', "policy_versions_json": '{"addendum":"1"}', "metadata_json": '{"policy_contents":{"addendum":"Sent copy only"}}'}},
            ],
            exports.TABLE_ASSIGNMENTS: [
                {"id": "mine", "data": {"organization_id": "customer", "campaign_id": "campaign", "actor_id": "viewer", "actor_display_name": "Viewer", "status": "assigned"}},
                {"id": "other", "data": {"organization_id": "customer", "campaign_id": "campaign", "actor_id": "other", "actor_display_name": "Other", "status": "assigned"}},
            ],
            exports.TABLE_ACCEPTANCES: [],
        }

    async def get(self, table, row_id):
        for row in self.rows.get(table, []):
            if row["id"] == row_id:
                return SimpleNamespace(id=row["id"], data=dict(row["data"]), created_at=row.get("created_at"), updated_at=row.get("updated_at"))
        return None

    async def query(self, table, where=None, limit=1000, offset=0):
        where = where or {}
        matching = [
            SimpleNamespace(id=row["id"], data=dict(row["data"]), created_at=row.get("created_at"), updated_at=row.get("updated_at"))
            for row in self.rows.get(table, [])
            if all(row["data"].get(key) == value for key, value in where.items())
        ]
        return SimpleNamespace(documents=matching[offset:offset + limit])


def install_context(monkeypatch, *, org_id="customer", user_id="viewer", roles=("GRC Auditor",), provider=False):
    ctx = SimpleNamespace(
        org_id=org_id,
        user=SimpleNamespace(id=user_id, display_name="Viewer", email="viewer@example.test", roles=list(roles)),
        organization=SimpleNamespace(name="Customer Co", is_provider=provider),
        is_platform_admin=False,
    )
    monkeypatch.setattr(exports, "context", ctx)
    monkeypatch.setattr(grc_auth, "context", ctx)
    monkeypatch.setattr(grc_policy_admin, "context", ctx)
    monkeypatch.setattr(grc_policy_recipient, "context", ctx)
    # Keep the authorization fallback inside the SDK boundary.  A workflow can
    # run with a caller context that has role IDs rather than names, so the
    # production path asks the roles SDK for memberships when needed.
    async def list_roles():
        return []

    async def list_users(_role_id):
        return []

    monkeypatch.setattr(
        grc_policy_admin,
        "roles",
        SimpleNamespace(list=list_roles, list_users=list_users),
    )
    return ctx


def install_renderers(monkeypatch):
    calls = []
    def renderer(kind):
        def render(payload):
            calls.append((kind, payload))
            return f"%PDF-{kind}".encode()
        return render
    monkeypatch.setattr(exports, "render_policy_pdf", renderer("policy"))
    monkeypatch.setattr(exports, "render_assessment_pdf", renderer("assessment"))
    monkeypatch.setattr(exports, "render_campaign_pdf", renderer("campaign"))
    return calls


def install_tables(monkeypatch):
    fake = FakeTables()
    monkeypatch.setattr(exports, "tables", fake)
    monkeypatch.setattr(grc_agent_tools, "tables", fake)
    return fake


def test_policy_export_resolves_customer_addendum_and_returns_download_contract(monkeypatch):
    install_context(monkeypatch)
    install_tables(monkeypatch)
    calls = install_renderers(monkeypatch)

    result = asyncio.run(exports.grc_v2_export_policy_pdf("addendum", "customer"))

    assert result["content_type"] == "application/pdf"
    assert base64.b64decode(result["content_base64"]) == b"%PDF-policy"
    assert result["filename"].endswith(".pdf")
    payload = calls[0][1]
    assert payload["organization_name"] == "Customer Co"
    assert payload["title"] == "Security Policy"
    assert payload["version"] == "2"
    assert payload["content"] == "Base policy"
    assert payload["addenda"] == [{"title": "Customer Addendum", "version": "1", "effective_date": "2026-01-01", "content": "Customer additions"}]


def test_assessment_export_applies_customer_override_and_includes_evidence(monkeypatch):
    install_context(monkeypatch)
    install_tables(monkeypatch)
    calls = install_renderers(monkeypatch)

    result = asyncio.run(exports.grc_v2_export_assessment_pdf("assessment", "customer"))

    assert base64.b64decode(result["content_base64"]) == b"%PDF-assessment"
    payload = calls[0][1]
    assert payload["framework_name"] == "NIST CSF"
    assert payload["summary"] == {"total": 1, "compliant": 1, "partially_compliant": 0, "non_compliant": 0, "not_assessed": 0, "not_applicable": 0}
    assert payload["controls"][0]["status"] == "compliant"
    assert payload["controls"][0]["notes"] == "Verified for customer"
    assert payload["controls"][0]["evidence"][0]["name"] == "Access review"


def test_viewer_can_export_only_own_assignment_from_sent_snapshot(monkeypatch):
    install_context(monkeypatch, roles=("GRC Viewer",))
    fake = install_tables(monkeypatch)
    image_uri = "bifrost-policy-file://base/policies%2Fbase%2Flogo.png"
    fake.rows[exports.TABLE_CAMPAIGNS][0]["data"]["metadata_json"] = '{"policy_contents":{"addendum":"Sent copy only ![logo](' + image_uri + ')"}}'
    fake.rows[exports.TABLE_POLICIES][0]["data"]["attachments_json"] = '[{"path":"policies/base/logo.png","kind":"image"}]'
    class Files:
        async def read_bytes(self, path, **kwargs):
            assert path == "policies/base/logo.png"
            assert kwargs == {"location": "grc-policy-files", "scope": "provider"}
            return b"logo"
    monkeypatch.setattr(exports, "files", Files())
    calls = install_renderers(monkeypatch)

    result = asyncio.run(exports.grc_v2_export_my_policy_assignment_pdf("mine"))

    assert base64.b64decode(result["content_base64"]) == b"%PDF-campaign"
    assert calls[0][0] == "campaign"
    assert calls[0][1]["policies"][0]["content"] == f"Sent copy only ![logo]({image_uri})"
    assert calls[0][1]["policies"][0]["images"] == {image_uri: b"logo"}
    with pytest.raises(exports.UserError, match="not assigned"):
        asyncio.run(exports.grc_v2_export_my_policy_assignment_pdf("other"))


def test_campaign_pdf_does_not_treat_assignment_state_as_signoff(monkeypatch):
    install_context(monkeypatch)
    fake = install_tables(monkeypatch)
    campaign = exports._row(fake.rows[exports.TABLE_CAMPAIGNS][0])
    fake.rows[exports.TABLE_ASSIGNMENTS][0]["data"].update(status="accepted", metadata_json='{"accepted_at":"forged"}')

    payload = asyncio.run(exports._campaign_payload(campaign, "customer"))

    unsigned_person = next(person for person in payload["people"] if person["name"] == "Viewer")
    assert unsigned_person["status"] in {"not_signed", "overdue"}
    assert unsigned_person["accepted_at"] is None

    fake.rows[exports.TABLE_ACCEPTANCES].append({"id": "accepted", "data": {
        "organization_id": "customer", "campaign_id": "campaign", "assignment_id": "mine",
        "actor_id": "viewer", "status": "accepted", "accepted_at": "2026-02-03T00:00:00+00:00",
        "source_system": "bifrost_grc_policy_recipient", "accepted_policy_ids_json": '["addendum"]',
        "accepted_policy_versions_json": '{"addendum":"1"}',
    }})
    signed = asyncio.run(exports._campaign_payload(campaign, "customer"))
    assert next(person for person in signed["people"] if person["name"] == "Viewer")["status"] == "signed"


def test_policy_export_refuses_ambiguous_customer_addenda(monkeypatch):
    install_context(monkeypatch)
    fake = install_tables(monkeypatch)
    fake.rows[exports.TABLE_POLICIES].append({
        "id": "addendum-two", "data": {
            "organization_id": "provider", "applied_organizations": ["customer"], "excluded_organizations": [],
            "name": "Second customer addendum", "content": "Competing content", "policy_role": "extension",
            "base_policy_id": "base", "version": "2", "status": "active",
        },
    })
    install_renderers(monkeypatch)

    with pytest.raises(exports.UserError, match="multiple applicable addenda"):
        asyncio.run(exports.grc_v2_export_policy_pdf("base", "customer"))


def test_admin_exports_reject_tenant_spoofing_and_viewer_role(monkeypatch):
    fake = install_tables(monkeypatch)
    install_context(monkeypatch, roles=("GRC Auditor",))
    install_renderers(monkeypatch)

    with pytest.raises(exports.UserError, match="own organization"):
        asyncio.run(exports.grc_v2_export_policy_pdf("base", "other-customer"))
    with pytest.raises(exports.UserError, match="own organization"):
        asyncio.run(exports.grc_v2_export_assessment_pdf("assessment", "other-customer"))

    install_context(monkeypatch, roles=("GRC Viewer",))
    with pytest.raises(exports.UserError, match="authorized GRC role"):
        asyncio.run(exports.grc_v2_export_campaign_pdf("campaign"))
    fake.rows[exports.TABLE_CAMPAIGNS][0]["data"]["organization_id"] = "other-customer"
    install_context(monkeypatch, roles=("GRC Auditor",))
    with pytest.raises(exports.UserError, match="own organization"):
        asyncio.run(exports.grc_v2_export_campaign_pdf("campaign"))


def test_blank_organization_id_cannot_bypass_customer_scope(monkeypatch):
    fake = install_tables(monkeypatch)
    fake.rows[exports.TABLE_POLICIES].append({
        "id": "other-policy", "data": {
            "organization_id": "provider", "applied_organizations": ["other-customer"], "excluded_organizations": [],
            "name": "Other customer policy", "content": "Private", "status": "active",
        },
    })
    fake.rows[exports.TABLE_ASSESSMENTS].append({
        "id": "other-assessment", "data": {
            "organization_id": "provider", "applied_organizations": ["other-customer"], "excluded_organizations": [],
            "framework_id": "framework", "name": "Other assessment", "status": "draft",
        },
    })
    install_context(monkeypatch, roles=("GRC Auditor",))
    install_renderers(monkeypatch)

    with pytest.raises(exports.UserError, match="not available"):
        asyncio.run(exports.grc_v2_export_policy_pdf("other-policy", "   "))
    with pytest.raises(exports.UserError, match="not available"):
        asyncio.run(exports.grc_v2_export_assessment_pdf("other-assessment", "   "))
    fake.rows[exports.TABLE_CAMPAIGNS][0]["data"].pop("organization_id")
    with pytest.raises(exports.UserError, match="no organization_id"):
        asyncio.run(exports.grc_v2_export_campaign_pdf("campaign"))


def test_provider_portfolio_export_includes_draft_without_selecting_addendum(monkeypatch):
    fake = install_tables(monkeypatch)
    fake.rows[exports.TABLE_POLICIES][0]["data"].update({"status": "draft", "applied_organizations": None})
    install_context(monkeypatch, org_id="provider", roles=("GRC Administrator",), provider=True)
    calls = install_renderers(monkeypatch)

    asyncio.run(exports.grc_v2_export_policy_pdf("base"))

    payload = calls[0][1]
    assert payload["status"] == "draft"
    assert payload["scope_label"] == "Portfolio view"
    assert payload["addenda"] == []


def test_portfolio_assessment_omits_unrelated_evidence_and_recalculates_effective_progress(monkeypatch):
    fake = install_tables(monkeypatch)
    fake.rows[exports.TABLE_EVIDENCE].append({
        "id": "unrelated", "data": {
            "organization_id": "provider", "applied_organizations": None, "excluded_organizations": [],
            "assessment_id": "different-assessment", "name": "Must not leak", "type": "note",
        },
    })
    install_context(monkeypatch, org_id="provider", roles=("GRC Administrator",), provider=True)

    portfolio = asyncio.run(exports._assessment_payload("assessment", None))
    install_context(monkeypatch)
    customer = asyncio.run(exports._assessment_payload("assessment", "customer"))

    assert portfolio["evidence"] == []
    assert portfolio["progress_percentage"] == 0
    assert customer["progress_percentage"] == 100


def test_policy_images_are_loaded_only_from_the_referenced_policy_attachment(monkeypatch):
    allowed_uri = "bifrost-policy-file://policy-a/policies%2Fpolicy-a%2Fimage.png"
    policy = {"id": "policy-a", "organization_id": "customer", "attachments_json": '[{"path":"policies/policy-a/image.png","kind":"image"}]'}
    calls = []
    class Files:
        async def read_bytes(self, path, **kwargs):
            calls.append((path, kwargs))
            return b"image-bytes"
    monkeypatch.setattr(exports, "files", Files())

    images = asyncio.run(exports._policy_images(f"![image]({allowed_uri}) ![bad](bifrost-policy-file://policy-b/nope.png)", [policy]))

    assert images == {allowed_uri: b"image-bytes"}
    assert calls == [("policies/policy-a/image.png", {"location": "grc-policy-files", "scope": "customer"})]


def test_export_query_reads_later_pages(monkeypatch):
    class Pages:
        async def query(self, _table, where=None, limit=1000, offset=0):
            count = 1000 if offset == 0 else 1 if offset == 1000 else 0
            return SimpleNamespace(documents=[SimpleNamespace(id=f"row-{offset + index}", data={}) for index in range(count)])
    monkeypatch.setattr(exports, "tables", Pages())

    rows = asyncio.run(exports._query_rows("records"))

    assert len(rows) == 1001
    assert rows[-1]["id"] == "row-1000"


def test_export_workflow_uses_shared_renderer_to_produce_a_real_pdf(monkeypatch):
    install_context(monkeypatch)
    install_tables(monkeypatch)

    result = asyncio.run(exports.grc_v2_export_policy_pdf("addendum", "customer"))

    pdf = base64.b64decode(result["content_base64"])
    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 1000


def test_branding_is_presentation_only_and_shared_by_all_export_entrypoints(monkeypatch):
    install_tables(monkeypatch)
    install_context(monkeypatch)
    calls = install_renderers(monkeypatch)
    branding = {"name": "Integration Services", "primary_color": "#0D577A", "logo_base64": "example", "organization_id": "other-customer", "logo_url": "https://example.test/track"}
    asyncio.run(exports.grc_v2_export_policy_pdf("base", branding=branding))
    asyncio.run(exports.grc_v2_export_assessment_pdf("assessment", branding=branding))
    asyncio.run(exports.grc_v2_export_campaign_pdf("campaign", branding=branding))
    install_context(monkeypatch, roles=("GRC Viewer",))
    asyncio.run(exports.grc_v2_export_my_policy_assignment_pdf("mine", branding=branding))
    for _, payload in calls:
        assert payload["branding"] == {"name": "", "primary_color": "#0D577A", "logo_base64": "example"}
        assert payload["organization_name"] == "Customer Co"
    with pytest.raises(exports.UserError, match="not assigned"):
        asyncio.run(exports.grc_v2_export_my_policy_assignment_pdf("other", branding=branding))
    assert exports._export_branding({"primary_color": "url(https://example.test/track)", "logo_base64": "a" * 1_400_001}) == {"name": ""}
    assert exports._export_branding({"name": "A" * 1000})["name"] == ""


def test_export_workflows_register_role_specific_access_without_file_write_grants():
    workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"].values()
    registered = {row["function_name"]: row for row in workflows if row.get("function_name", "").startswith("grc_v2_export_")}
    assert set(registered) >= {
        "grc_v2_export_policy_pdf",
        "grc_v2_export_assessment_pdf",
        "grc_v2_export_my_policy_assignment_pdf",
        "grc_v2_export_campaign_pdf",
    }
    assert registered["grc_v2_export_my_policy_assignment_pdf"]["role_names"] == ["GRC Viewer"]
    assert set(registered["grc_v2_export_policy_pdf"]["role_names"]) == {"GRC Auditor", "GRC Administrator", "GRC Contributor"}
    assert set(registered["grc_v2_export_assessment_pdf"]["role_names"]) == {"GRC Auditor", "GRC Administrator", "GRC Contributor"}
