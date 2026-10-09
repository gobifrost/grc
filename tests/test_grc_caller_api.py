import asyncio
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from workflows.grc_v2 import grc_caller_api as caller


class Config:
    def __init__(self, values=None):
        self.values = values or {}
    async def get(self, key, default=None):
        return self.values.get(key, default)


class Roles:
    def __init__(self, memberships=None):
        self.memberships = memberships or {}
    async def list(self):
        return [SimpleNamespace(id=name, name=name) for name in self.memberships]
    async def list_users(self, role_id):
        return self.memberships[role_id]


def setup(monkeypatch, user_id='person', memberships=None, values=None):
    ctx = SimpleNamespace(org_id='org', user=SimpleNamespace(id=user_id), organization=SimpleNamespace(is_provider=False), is_platform_admin=False)
    monkeypatch.setattr(caller, 'context', ctx)
    monkeypatch.setattr('functions.grc_auth.context', ctx)
    monkeypatch.setattr(caller, 'roles', Roles(memberships))
    monkeypatch.setattr(caller, 'config', Config(values))


def test_caller_denies_engine_and_missing_role(monkeypatch):
    setup(monkeypatch, user_id=caller.ENGINE_ID, memberships={'GRC Administrator': [caller.ENGINE_ID]})
    with pytest.raises(caller.UserError, match='real user'):
        asyncio.run(caller.grc_caller_policy_signoff('org'))
    setup(monkeypatch, memberships={'Other': ['person']})
    with pytest.raises(caller.UserError, match='authorized GRC role'):
        asyncio.run(caller.grc_caller_policy_signoff('org'))


def test_configured_reader_and_administrator_are_allowed(monkeypatch):
    setup(monkeypatch, memberships={'Portal Reader': ['person']}, values={'grc_caller_reader_roles': ['Portal Reader']})
    asyncio.run(caller._authorize('org', 'grc_caller_reader_roles'))
    setup(monkeypatch, memberships={'GRC Administrator': ['person']})
    asyncio.run(caller._authorize('org', 'grc_caller_reader_roles'))
    caller.context.user = None
    caller.context.user_id = 'person'
    asyncio.run(caller._authorize('org', 'grc_caller_reader_roles'))


def test_sender_role_is_separate_from_reader_and_org_is_bound(monkeypatch):
    setup(monkeypatch, memberships={'Portal Reader': ['person']}, values={'grc_caller_reader_roles': ['Portal Reader']})
    with pytest.raises(caller.UserError, match='authorized GRC role'):
        asyncio.run(caller._authorize('org', 'grc_caller_sender_roles'))
    with pytest.raises(caller.UserError, match='own organization'):
        asyncio.run(caller._authorize('other', 'grc_caller_reader_roles'))


def test_caller_reads_latest_matching_policy_type(monkeypatch):
    setup(monkeypatch, memberships={'Portal Reader': ['person']}, values={'grc_caller_reader_roles': ['Portal Reader']})
    async def rows(*_args, **_kwargs):
        return [{'id': 'old'}, {'id': 'new'}]
    async def details(row):
        return {'campaign_id': row['id'], 'sent_date': '2026-09-20' if row['id'] == 'old' else '2026-09-30', 'policies': [{'policy_type': 'ai_acceptable_use'}], 'people': []}
    monkeypatch.setattr(caller, '_query_rows', rows)
    monkeypatch.setattr(caller, '_details', details)
    result = asyncio.run(caller.grc_caller_policy_signoff('org'))
    assert result['campaign_id'] == 'new'
    assert asyncio.run(caller.grc_caller_policy_signoff('org', 'other')) == {'status': 'not_sent'}


def test_caller_prepares_and_sends_only_after_sender_role_check(monkeypatch):
    setup(monkeypatch, memberships={'Portal Sender': ['person']}, values={'grc_caller_sender_roles': ['Portal Sender']})
    calls = []
    async def prepare(*args):
        calls.append(('prepare', args))
        return {'policy_id': 'policy', 'version': '1.0', 'content': 'Text'}
    async def send(*args):
        calls.append(('send', args))
        return {'campaign_id': 'campaign', 'assigned': 1, 'requested': 1, 'failed_notifications': []}
    monkeypatch.setattr(caller, 'prepare_policy_for_authorized_caller', prepare)
    monkeypatch.setattr(caller, 'send_policy_campaign_for_authorized_caller', send)
    result = asyncio.run(caller.grc_caller_prepare_and_send('org', 'template', {'organization_name': 'Example'}, [{'email': 'a@example.test', 'name': 'A'}]))
    assert result['campaign']['campaign_id'] == 'campaign'
    assert calls[0][0] == 'prepare' and calls[1][0] == 'send'


def test_caller_previews_and_sends_parent_plus_addendum(monkeypatch):
    setup(monkeypatch, memberships={'Portal Sender': ['person'], 'Portal Reader': ['person']}, values={'grc_caller_sender_roles': ['Portal Sender'], 'grc_caller_reader_roles': ['Portal Reader']})
    calls = []
    async def prepare(*args):
        return {'base_policy_id': 'base', 'base_version': '2.0', 'addendum_policy_id': 'addendum', 'addendum_version': '1.0', 'content': 'Addendum'}
    async def send(*args):
        calls.append(args)
        return {'campaign_id': 'campaign'}
    async def preview(*args):
        return {'parent_markdown': 'Parent', 'addendum_markdown': 'Addendum'}
    monkeypatch.setattr(caller, 'prepare_policy_for_authorized_caller', prepare)
    monkeypatch.setattr(caller, 'send_policy_campaign_for_authorized_caller', send)
    monkeypatch.setattr(caller, 'preview_policy_addendum_for_authorized_caller', preview)

    result = asyncio.run(caller.grc_caller_prepare_and_send('org', 'addendum-template', {}, [{'email': 'a@example.test', 'name': 'A'}]))
    assert calls[0][1] == ['base', 'addendum']
    assert result['policy']['base_policy_id'] == 'base'
    assert asyncio.run(caller.grc_caller_preview_addendum('org', 'addendum-template', {})) == {'parent_markdown': 'Parent', 'addendum_markdown': 'Addendum'}


def test_caller_lists_active_available_templates_with_declared_fields(monkeypatch):
    setup(monkeypatch, memberships={'Portal Reader': ['person']}, values={'grc_caller_reader_roles': ['Portal Reader']})

    async def templates(*_args, **_kwargs):
        return [
            {'id': 'ai', 'name': 'AI Acceptable Use Policy', 'version': '1.1', 'policy_type': 'ai_acceptable_use', 'status': 'active', 'applied_organizations': None, 'default_policy_role': 'extension', 'base_template_id': 'parent', 'field_schema': '[{"key":"organization_name","required":true,"description":"Organization name","type":"string"},{"key":"meeting_rule","required":false,"description":"Meeting rule","type":"enum","enum":["ask_first"],"default":"ask_first"}]'},
            {'id': 'inactive', 'name': 'Inactive', 'version': '1.0', 'policy_type': 'ai_acceptable_use', 'status': 'inactive', 'applied_organizations': None},
            {'id': 'other-org', 'name': 'Other', 'version': '1.0', 'policy_type': 'other', 'status': 'active', 'applied_organizations': ['other']},
        ]

    monkeypatch.setattr(caller, '_campaign_query_rows', templates)

    result = asyncio.run(caller.grc_caller_list_policy_templates('ai_acceptable_use'))

    assert result == [{
        'id': 'ai', 'name': 'AI Acceptable Use Policy', 'version': '1.1',
        'policy_type': 'ai_acceptable_use',
        'policy_role': 'extension', 'base_template_id': 'parent',
        'fields': [{'key': 'organization_name', 'required': True, 'description': 'Organization name', 'type': 'string'}, {'key': 'meeting_rule', 'required': False, 'description': 'Meeting rule', 'type': 'enum', 'enum': ['ask_first'], 'default': 'ask_first'}],
    }]


def test_caller_reissue_authorizes_sender_binds_campaign_and_reports_carryover(monkeypatch):
    setup(monkeypatch, memberships={'Portal Sender': ['person']}, values={'grc_caller_sender_roles': ['Portal Sender']})
    calls = []

    class Tables:
        async def get(self, table, row_id):
            assert table == 'grc-policy-campaigns'
            return {'id': row_id, 'organization_id': 'org', 'status': 'active'}

    async def reissue(campaign, send_campaign):
        calls.append((campaign, send_campaign))
        return {'campaign_id': 'campaign-new', 'reasked_signed': [{'assignment_id': 'new-signed', 'email': 'person@example.test'}], 'waivers_carried_over': [{'assignment_id': 'new-waived', 'email': 'leave@example.test', 'reason': 'Leave'}]}

    monkeypatch.setattr(caller, 'tables', Tables())
    monkeypatch.setattr(caller, '_reissue', reissue)

    result = asyncio.run(caller.grc_caller_reissue('org', 'campaign'))

    assert result['campaign_id'] == 'campaign-new'
    assert result['reasked_signed'][0]['email'] == 'person@example.test'
    assert result['waivers_carried_over'][0]['reason'] == 'Leave'
    assert calls[0][0]['organization_id'] == 'org'
    assert calls[0][1] is caller.send_policy_campaign_for_authorized_caller


def test_caller_default_recipients_uses_reader_authorization_and_campaign_helper(monkeypatch):
    setup(monkeypatch, memberships={'Portal Reader': ['person']}, values={'grc_caller_reader_roles': ['Portal Reader']})
    calls = []

    async def recipients(organization_id):
        calls.append(organization_id)
        return {'included': [{'email': 'a@example.test', 'name': 'A'}], 'excluded': []}

    monkeypatch.setattr(caller, '_default_policy_recipients', recipients)

    result = asyncio.run(caller.grc_caller_default_recipients('org'))

    assert result['included'][0]['email'] == 'a@example.test'
    assert calls == ['org']


def test_caller_remind_authorizes_sender_and_binds_campaign_to_organization(monkeypatch):
    setup(monkeypatch, memberships={'Portal Sender': ['person']}, values={'grc_caller_sender_roles': ['Portal Sender']})
    calls = []

    class Tables:
        async def get(self, table, row_id):
            assert table == 'grc-policy-campaigns'
            return {'id': row_id, 'organization_id': 'org'}

    async def remind(campaign, assignment_ids):
        calls.append((campaign, assignment_ids))
        return {'requested': ['assignment'], 'skipped': [], 'failed_notifications': []}

    monkeypatch.setattr(caller, 'tables', Tables())
    monkeypatch.setattr(caller, '_remind', remind)

    result = asyncio.run(caller.grc_caller_remind('org', 'campaign', ['assignment']))

    assert result['requested'] == ['assignment']
    assert calls == [({'id': 'campaign', 'organization_id': 'org'}, ['assignment'])]


def test_caller_waive_authorizes_sender_and_binds_assignment_to_organization(monkeypatch):
    setup(monkeypatch, memberships={'Portal Sender': ['person']}, values={'grc_caller_sender_roles': ['Portal Sender']})
    updates = []

    class Tables:
        async def get(self, table, row_id):
            assert table == 'grc-policy-campaign-assignments'
            return {'id': row_id, 'organization_id': 'org', 'status': 'assigned', 'metadata_json': '{}'}

        async def update(self, table, row_id, values):
            updates.append((table, row_id, values))

    monkeypatch.setattr(caller, 'tables', Tables())
    monkeypatch.setattr(caller, '_now', lambda: SimpleNamespace(isoformat=lambda: '2026-09-30T00:00:00+00:00'))

    result = asyncio.run(caller.grc_caller_waive('org', 'assignment', 'Approved exception'))

    assert result == {'assignment_id': 'assignment', 'status': 'waived', 'reason': 'Approved exception'}
    assert updates[0][0:2] == ('grc-policy-campaign-assignments', 'assignment')


def test_caller_refuses_campaigns_and_assignments_from_other_organizations(monkeypatch):
    setup(monkeypatch, memberships={'Portal Sender': ['person']}, values={'grc_caller_sender_roles': ['Portal Sender']})

    class Tables:
        async def get(self, table, row_id):
            return {'id': row_id, 'organization_id': 'other', 'status': 'assigned'}

    monkeypatch.setattr(caller, 'tables', Tables())

    with pytest.raises(caller.UserError, match='Campaign does not belong'):
        asyncio.run(caller.grc_caller_remind('org', 'campaign'))
    with pytest.raises(caller.UserError, match='Assignment does not belong'):
        asyncio.run(caller.grc_caller_waive('org', 'assignment', 'Approved exception'))


def test_caller_prepares_addendum_only_for_sender_roles(monkeypatch):
    setup(monkeypatch, memberships={'Portal Reader': ['person']}, values={'grc_caller_reader_roles': ['Portal Reader'], 'grc_caller_sender_roles': []})
    with pytest.raises(caller.UserError, match='authorized GRC role'):
        asyncio.run(caller.grc_caller_prepare_addendum('org', 'addendum-template', {'organization_name': 'Example'}))

    setup(monkeypatch, memberships={'Portal Sender': ['person']}, values={'grc_caller_sender_roles': ['Portal Sender']})
    prepared = []
    async def prepare(organization_id, template_id, fields):
        prepared.append((organization_id, template_id, fields))
        return {'addendum_policy_id': 'addendum', 'addendum_version': '1.1'}
    monkeypatch.setattr(caller, '_prepare_policy_addendum', prepare)
    monkeypatch.setattr(caller, '_authorize_campaign_operator', lambda organization_id: organization_id)
    result = asyncio.run(caller.grc_caller_prepare_addendum('org', 'addendum-template', {'organization_name': 'Example'}))
    assert result['addendum_version'] == '1.1'
    assert prepared == [('org', 'addendum-template', {'organization_name': 'Example'})]
