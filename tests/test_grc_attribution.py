from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from bifrost import UserError
from functions import grc_attribution as attribution
from workflows.grc_v2 import grc_record_mutations as records
from workflows.grc_v2 import grc_agent_tools as tools

@pytest.fixture
def actor(monkeypatch):
    ctx = SimpleNamespace(user=SimpleNamespace(id="caller", email="caller@example.com"), user_id="caller", is_function_key=False)
    monkeypatch.setattr(attribution, "context", ctx)
    return ctx

@pytest.mark.parametrize("field", sorted(attribution.PROTECTED_FIELDS))
def test_attribution_fields_cannot_be_supplied(actor, field):
    with pytest.raises(UserError, match="authenticated context"):
        attribution.attributed_payload("grc-policies", {field: "someone-else"})

@pytest.mark.parametrize("table,status,actor_key,time_key", [
    ("grc-policies", "active", "approved_by", "approved_at"),
    ("grc-exceptions", "approved", "approved_by", None),
    ("grc-findings", "resolved", "resolved_by", "resolved_at"),
    ("grc-questionnaire-recommendations", "done", "completed_by", "completed_at"),
])
def test_terminal_states_use_caller_and_server_time(actor, table, status, actor_key, time_key):
    result = attribution.attributed_payload(table, {"status":status})
    assert result[actor_key] == "caller"
    if time_key: assert result[time_key].endswith("+00:00")

def test_editing_approved_content_requires_review(actor):
    result = attribution.attributed_payload("grc-policies", {"content":"changed"}, {"status":"active", "content":"signed", "approved_by":"old"})
    assert result == {"content":"changed", "status":"draft", "approved_by":None,"approved_at":None}

def test_reopen_clears_completion(actor):
    result = attribution.attributed_payload("grc-questionnaire-recommendations", {"status":"open"}, {"status":"done"})
    assert result["completed_by"] is None and result["completed_at"] is None

def test_evidence_uploader_is_caller(actor):
    assert attribution.attributed_payload("grc-evidence", {"name":"test"})["uploaded_by"] == "caller"

@pytest.mark.parametrize("function_key,actor_id", [(True,"caller"),(False,"00000000-0000-0000-0000-000000000001"),(False,None)])
def test_non_human_attribution_rejected(actor,function_key,actor_id):
    actor.is_function_key = function_key
    actor.user.id = actor_id
    actor.user_id = actor_id
    with pytest.raises(UserError): attribution.authenticated_actor_id()

@pytest.mark.asyncio
async def test_cross_tenant_write_has_no_effect(actor,monkeypatch):
    backend=SimpleNamespace(get=AsyncMock(return_value={"id":"record","data":{"organization_id":"other"}}),update=AsyncMock())
    monkeypatch.setattr(records,"tables",backend)
    monkeypatch.setattr(records,"is_platform_scope",lambda:False)
    def authorize(org,**kwargs):
        if org!="own": raise UserError("own organization")
        return org
    monkeypatch.setattr(records,"require_organization_access",authorize)
    with pytest.raises(UserError): await records.grc_v2_mutate_record("grc-policies","update",{"status":"active"},"record")
    backend.update.assert_not_awaited()

@pytest.mark.asyncio
@pytest.mark.parametrize("table", ["grc-change-history","grc-applied-control-history","grc-policy-campaigns","grc-policy-campaign-assignments","grc-policy-acceptances"])
async def test_generic_tool_cannot_forge_audit_or_signoff(actor,monkeypatch,table):
    monkeypatch.setattr(tools,"_provider_owner_id",lambda:"provider")
    with pytest.raises(UserError, match="dedicated workflows"):
        await tools.bifrost_grc_manage_record(table,"create",{"actor_id":"victim"},apply=True,confirm_apply=True)


def test_content_change_cannot_keep_approval_by_supplying_active(actor):
    result = attribution.attributed_payload("grc-policies", {"content":"changed", "status":"active"}, {"status":"active", "content":"signed", "approved_by":"old"})
    assert result["status"] == "draft" and result["approved_by"] is None


@pytest.mark.asyncio
async def test_customer_hard_delete_has_no_effect(actor,monkeypatch):
    backend = SimpleNamespace(get=AsyncMock(return_value={"id":"record", "data":{"organization_id":"own"}}),delete_document=AsyncMock())
    monkeypatch.setattr(records,"tables",backend)
    monkeypatch.setattr(records,"require_organization_access",lambda org,**kwargs:org)
    monkeypatch.setattr(records,"is_platform_scope",lambda:False)
    def deny(*args,**kwargs): raise UserError("Only provider")
    monkeypatch.setattr(records,"require_provider",deny)
    with pytest.raises(UserError,match="Only provider"):
        await records.grc_v2_mutate_record("grc-policies","delete",row_id="record")
    backend.delete_document.assert_not_awaited()


@pytest.mark.asyncio
async def test_governed_approval_records_caller_and_history(actor,monkeypatch):
    backend = SimpleNamespace(get=AsyncMock(return_value={"id":"record","data":{"organization_id":"own","status":"draft"}}),update=AsyncMock(side_effect=lambda table,id,data:{"id":id,"data":{"organization_id":"own",**data}}))
    history = AsyncMock()
    monkeypatch.setattr(records,"tables",backend)
    monkeypatch.setattr(records,"require_organization_access",lambda org,**kwargs:org)
    monkeypatch.setattr(records,"is_platform_scope",lambda:False)
    monkeypatch.setattr(tools,"_record_change",history)
    result = await records.grc_v2_mutate_record("grc-policies","update",{"status":"active"},"record")
    assert result["data"]["approved_by"] == "caller"
    assert history.await_args.kwargs["before"]["status"] == "draft"
    assert history.await_args.kwargs["after"]["approved_by"] == "caller"
