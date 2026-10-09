import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from workflows.grc_v2 import grc_policy_admin as admin


class Tables:
    def __init__(self):
        self.rows = {
            admin.CAMPAIGNS: [dict(id="campaign", data=dict(organization_id="org", status="active", title="Sign policy", policy_ids_json='["policy"]', policy_versions_json='{"policy":"1.0"}', due_date="2026-10-20"), created_at="2026-09-20T00:00:00+00:00")],
            admin.POLICIES: [dict(id="policy", data=dict(name="AI policy", policy_type="ai_acceptable_use", version="1.0"))],
            admin.ASSIGNMENTS: [dict(id="one", data=dict(organization_id="org", campaign_id="campaign", actor_id="u1", actor_email="a@example.test", actor_display_name="Alice", status="assigned", metadata_json='{"notifications":[{"type":"invite","at":"2026-09-20T00:00:00+00:00","status":"sent"}]}')), dict(id="two", data=dict(organization_id="org", campaign_id="campaign", actor_id="u2", actor_email="b@example.test", actor_display_name="Bob", status="accepted", metadata_json='{"accepted_at":"2026-09-21T00:00:00+00:00"}')), dict(id="three", data=dict(organization_id="org", campaign_id="campaign", actor_id="u3", actor_email="c@example.test", actor_display_name="Chris", status="waived", metadata_json='{"waiver_reason":"Leave"}'))],
            admin.ACCEPTANCES: [dict(id="accept", data=dict(organization_id="org", campaign_id="campaign", assignment_id="two", actor_id="u2", status="accepted", accepted_at="2026-09-21T00:00:00+00:00", source_system="bifrost_grc_policy_recipient", accepted_policy_ids_json='["policy"]', accepted_policy_versions_json='{"policy":"1.0"}'))],
            admin.EVIDENCE: [],
            admin.EVIDENCE_LINKS: [],
        }
        self.updates = []

    async def query(self, table, where=None, limit=1000, offset=0):
        return SimpleNamespace(documents=[SimpleNamespace(id=r['id'], data=dict(r['data']), created_at=r.get('created_at')) for r in self.rows[table] if all(r['data'].get(k) == v for k, v in (where or {}).items())][offset:offset+limit])

    async def get(self, table, row_id):
        return next((SimpleNamespace(id=r['id'], data=dict(r['data']), created_at=r.get('created_at')) for r in self.rows[table] if r['id'] == row_id), None)

    async def update(self, table, row_id, payload):
        row = next(r for r in self.rows[table] if r['id'] == row_id)
        row['data'].update(payload)
        self.updates.append((table, row_id, payload))
        return SimpleNamespace(id=row_id, data=dict(row['data']))

    async def insert(self, table, payload):
        self.rows[table].append(dict(id="evidence", data=payload))
        return SimpleNamespace(id="evidence", data=payload)


def setup(monkeypatch):
    fake = Tables()
    monkeypatch.setattr(admin, 'tables', fake)
    monkeypatch.setattr(admin, 'context', SimpleNamespace(org_id='org', user=SimpleNamespace(id='admin', roles=['GRC Administrator']), organization=SimpleNamespace(is_provider=False), is_platform_admin=False))
    monkeypatch.setattr('functions.grc_auth.context', admin.context)
    return fake


def test_tracking_counts_and_waiver(monkeypatch):
    fake = setup(monkeypatch)
    fake.rows[admin.CAMPAIGNS][0]['data']['link_url'] = 'https://bifrost.example.test/apps/policies'
    fake.rows[admin.ASSIGNMENTS][0]['data']['metadata_json'] = json.dumps({'notifications': [
        {'notification_id': 'old', 'kind': 'invite', 'status': 'no_listener', 'requested_at': '2026-09-20T00:00:00+00:00', 'error': 'No notification listener is configured on this instance.'},
        {'notification_id': 'new', 'kind': 'reminder', 'status': 'sent', 'requested_at': '2026-09-21T00:00:00+00:00', 'completed_at': '2026-09-21T00:01:00+00:00'},
    ]})
    detail = asyncio.run(admin.grc_v2_get_policy_campaign('campaign'))
    assert detail['counts'] == {'required': 2, 'accepted': 1, 'waived': 1, 'outstanding': 1}
    assert [p['status'] for p in detail['people']] == ['not_signed', 'signed', 'waived']
    assert detail['has_no_listener'] is True
    assert detail['link_url'] == 'https://bifrost.example.test/apps/policies'
    assert detail['people'][0]['last_notice'] == {
        'kind': 'reminder', 'status': 'sent', 'requested_at': '2026-09-21T00:00:00+00:00', 'completed_at': '2026-09-21T00:01:00+00:00',
    }
    listed = asyncio.run(admin.grc_v2_list_policy_campaigns('org'))
    assert listed['campaigns'][0]['counts'] == detail['counts']
    with pytest.raises(admin.UserError, match='reason'):
        asyncio.run(admin.grc_v2_waive_policy_assignment('one', ' '))
    asyncio.run(admin.grc_v2_waive_policy_assignment('one', 'Exception'))
    assert fake.rows[admin.ASSIGNMENTS][0]['data']['status'] == 'waived'
    assert json.loads(fake.rows[admin.ASSIGNMENTS][0]['data']['metadata_json'])['waived_by'] == 'admin'


def test_rejects_engine_and_other_org(monkeypatch):
    setup(monkeypatch)
    admin.context.user.id = '00000000-0000-0000-0000-000000000001'
    with pytest.raises(admin.UserError, match='human'):
        asyncio.run(admin.grc_v2_list_policy_campaigns('org'))
    admin.context.user.id = 'admin'
    with pytest.raises(admin.UserError, match='own organization'):
        asyncio.run(admin.grc_v2_list_policy_campaigns('other'))


def test_platform_execution_context_user_id_is_authorized_by_role_membership(monkeypatch):
    setup(monkeypatch)
    admin.context.user = None
    admin.context.user_id = 'admin'
    class Roles:
        async def list(self): return [SimpleNamespace(id='role-admin', name='GRC Administrator')]
        async def list_users(self, role_id): return ['admin']
    monkeypatch.setattr(admin, 'roles', Roles())
    assert asyncio.run(admin.grc_v2_list_policy_campaigns('org'))['campaigns'][0]['campaign_id'] == 'campaign'


def test_reminder_skips_signed_waived_and_recent(monkeypatch):
    fake = setup(monkeypatch)
    import workflows.grc_v2.grc_policy_campaign as campaign_module
    calls = []
    async def prepare(*args, **kwargs):
        calls.append(args[2])
        return ({'notification_id': 'notice-2'}, {'notification_id': 'notice-2', 'kind': 'reminder', 'status': 'requested', 'requested_at': admin._now().isoformat()})
    async def emit(*args, **kwargs):
        return {'subscribers_notified': 1}
    monkeypatch.setattr(campaign_module, 'prepare_policy_notification', prepare)
    monkeypatch.setattr(campaign_module, 'emit_policy_notification', emit)
    result = asyncio.run(admin.grc_v2_remind_policy_assignees('campaign'))
    assert result['requested'] == ['one']
    assert calls == ['a@example.test']
    again = asyncio.run(admin.grc_v2_remind_policy_assignees('campaign'))
    assert again['requested'] == []
    assert len(calls) == 1
    note = json.loads(fake.rows[admin.ASSIGNMENTS][0]['data']['metadata_json'])['notifications'][-1]
    assert note['kind'] == 'reminder' and note['status'] == 'requested'


def test_scheduled_reminder_sends_on_day_three_only(monkeypatch):
    setup(monkeypatch)
    admin.context.user.id = '00000000-0000-0000-0000-000000000001'
    admin.context.event = SimpleNamespace(type='schedule.fired')
    monkeypatch.setattr(admin, '_now', lambda: datetime(2026, 9, 23, 12, tzinfo=UTC))
    import workflows.grc_v2.grc_policy_campaign as campaign_module
    calls = []
    async def prepare(*args, **kwargs):
        calls.append(args[2])
        return ({'notification_id': 'notice-2'}, {'notification_id': 'notice-2', 'kind': 'reminder', 'status': 'requested', 'requested_at': '2026-09-23T12:00:00+00:00'})
    async def emit(*args, **kwargs):
        return {'subscribers_notified': 1}
    monkeypatch.setattr(campaign_module, 'prepare_policy_notification', prepare)
    monkeypatch.setattr(campaign_module, 'emit_policy_notification', emit)
    result = asyncio.run(admin.grc_v2_send_due_policy_reminders())
    assert result['requested'] == 1
    assert calls == ['a@example.test']


def test_reissue_requires_changed_version_then_closes_old_campaign(monkeypatch):
    fake = setup(monkeypatch)
    import workflows.grc_v2.grc_policy_campaign as campaign_module
    with pytest.raises(admin.UserError, match='version'):
        asyncio.run(admin.grc_v2_reissue_policy_campaign('campaign'))
    fake.rows[admin.POLICIES][0]['data']['version'] = '1.1'
    async def send(*args):
        assert len(args[2]) == 3
        return {'campaign_id': 'campaign-new', 'assigned': 3, 'requested': 3, 'failed_notifications': []}
    monkeypatch.setattr(campaign_module, 'grc_v2_send_policy_campaign', send)
    result = asyncio.run(admin.grc_v2_reissue_policy_campaign('campaign'))
    assert result['campaign_id'] == 'campaign-new'
    assert fake.rows[admin.CAMPAIGNS][0]['data']['status'] == 'closed'


def test_reissue_reasks_signed_people_and_carries_reasoned_waivers(monkeypatch):
    fake = setup(monkeypatch)
    fake.rows[admin.POLICIES][0]['data']['version'] = '1.1'

    async def send(organization_id, policy_ids, recipients, due_date, message, waived_reasons):
        assert organization_id == 'org'
        assert policy_ids == ['policy']
        assert {recipient['email'] for recipient in recipients} == {
            'a@example.test', 'b@example.test', 'c@example.test',
        }
        assert waived_reasons == {'c@example.test': 'Leave'}
        fake.rows[admin.CAMPAIGNS].append(dict(
            id='campaign-new',
            data=dict(organization_id='org', status='active'),
        ))
        for old in fake.rows[admin.ASSIGNMENTS][:3]:
            data = old['data']
            fake.rows[admin.ASSIGNMENTS].append(dict(
                id=f"new-{old['id']}",
                data=dict(
                    organization_id='org', campaign_id='campaign-new',
                    actor_id=data['actor_id'], actor_email=data['actor_email'],
                    actor_display_name=data['actor_display_name'],
                    status='waived' if data['status'] == 'waived' else 'assigned',
                    metadata_json='{"waiver_reason":"Leave"}' if data['status'] == 'waived' else '{}',
                ),
            ))
        return {'campaign_id': 'campaign-new', 'assigned': 3, 'requested': 3, 'failed_notifications': []}

    result = asyncio.run(admin._reissue(
        asyncio.run(admin._campaign('campaign')),
        send,
    ))

    new_assignments = {row['id']: row['data'] for row in fake.rows[admin.ASSIGNMENTS] if row['data'].get('campaign_id') == 'campaign-new'}
    assert new_assignments['new-two']['status'] == 'assigned'
    assert new_assignments['new-three']['status'] == 'waived'
    assert json.loads(new_assignments['new-three']['metadata_json'])['waiver_reason'] == 'Leave'
    assert result['reasked_signed'] == [{'assignment_id': 'new-two', 'email': 'b@example.test'}]
    assert result['waivers_carried_over'] == [{'assignment_id': 'new-three', 'email': 'c@example.test', 'reason': 'Leave'}]
    assert fake.rows[admin.CAMPAIGNS][0]['data']['status'] == 'closed'


def test_export_writes_csv_and_evidence(monkeypatch):
    fake = setup(monkeypatch)
    fake.rows[admin.ASSIGNMENTS][0]['data']['actor_display_name'] = '=HYPERLINK("bad")'
    writes = []
    async def write_bytes(path, content, **kwargs):
        writes.append((path, content, kwargs))
    async def get_signed_url(path, **kwargs):
        return {'url': 'https://example.test/download'}
    monkeypatch.setattr(admin, 'files', SimpleNamespace(write_bytes=write_bytes, get_signed_url=get_signed_url))
    result = asyncio.run(admin.grc_v2_export_policy_campaign_evidence('campaign'))
    assert result['download_url'] == 'https://example.test/download'
    assert b'waiver_reason' in writes[0][1]
    assert b'Chris' in writes[0][1]
    assert b"'=HYPERLINK" in writes[0][1]
    assert fake.rows[admin.EVIDENCE_LINKS][0]['data']['target_id'] == 'policy'


def test_provider_lists_base_policy_organizations_and_reissues_only_after_confirmation(monkeypatch):
    fake = setup(monkeypatch)
    admin.context.organization.is_provider = True
    fake.rows[admin.POLICIES] = [
        dict(id='base', data=dict(name='AI Acceptable Use Policy', policy_type='ai_acceptable_use', policy_role='base', version='2.1', status='active')),
        dict(id='addendum', data=dict(name='AI Acceptable Use Policy Addendum', policy_type='ai_acceptable_use', policy_role='extension', base_policy_id='base', version='1.0', applied_organizations=['org'], status='active')),
    ]
    fake.rows[admin.CAMPAIGNS][0]['data']['policy_ids_json'] = '["base","addendum"]'
    fake.rows[admin.CAMPAIGNS][0]['data']['policy_versions_json'] = '{"base":"2.0","addendum":"1.0"}'
    fake.rows[admin.CAMPAIGNS].append(dict(id='current', created_at='2026-10-01T00:00:00+00:00', data=dict(
        organization_id='org', status='active', title='Current', policy_ids_json='["base","addendum"]', policy_versions_json='{"base":"2.1","addendum":"1.0"}', due_date='2026-10-20',
    )))
    monkeypatch.setattr(admin, 'organizations', SimpleNamespace(get=lambda _id: _async(SimpleNamespace(name='Example Co'))))

    summary = asyncio.run(admin.grc_v2_list_base_policy_organizations('base'))
    assert summary == {'organizations': [{'organization_id': 'org', 'organization_name': 'Example Co', 'addendum_policy_id': 'addendum', 'addendum_version': '1.0', 'accepted': 0, 'required': 0, 'last_sent': '2026-10-01T00:00:00+00:00'}]}

    dry_run = asyncio.run(admin.grc_v2_reissue_for_base_policy('base'))
    assert dry_run['mode'] == 'dry_run'
    assert dry_run['affected_organizations'][0]['open_campaigns'][0]['campaign_id'] == 'campaign'
    assert len(dry_run['affected_organizations'][0]['open_campaigns']) == 1
    calls = []
    async def reissue(row, sender):
        calls.append((row['id'], sender))
        return {'campaign_id': 'campaign-new'}
    monkeypatch.setattr(admin, '_reissue', reissue)
    applied = asyncio.run(admin.grc_v2_reissue_for_base_policy('base', confirm=True))
    assert applied['mode'] == 'confirmed' and applied['reissued'][0]['campaign_id'] == 'campaign-new'
    assert calls[0][0] == 'campaign'


def test_provider_base_workflows_refuse_the_engine_identity(monkeypatch):
    setup(monkeypatch)
    admin.context.organization.is_provider = True
    admin.context.user.id = admin.ENGINE_USER_ID
    with pytest.raises(admin.UserError, match='real provider user'):
        asyncio.run(admin.grc_v2_list_base_policy_organizations('base'))


async def _async(value):
    return value
