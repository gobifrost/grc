from pathlib import Path
from types import SimpleNamespace
import asyncio
import sys

import yaml
import pytest


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

from workflows.grc_v2 import grc_integration


def test_gateway_is_a_protected_solution_endpoint():
    rows = yaml.safe_load((ROOT / '.bifrost/workflows.yaml').read_text())['workflows'].values()
    entry = next((row for row in rows if row.get('function_name') == 'grc_integration_gateway'), None)
    assert entry is not None, 'Portable GRC integration gateway is missing'
    assert entry['endpoint_enabled'] is False
    assert entry['public_endpoint'] is False
    assert entry['access_level'] == 'role_based'
    assert entry['role_names'] == ['GRC Administrator', 'GRC Contributor']


def test_contract_contains_no_provider_or_product_fields():
    """The generic endpoint remains portable and knows no caller product."""
    source = (ROOT / 'workflows/grc_v2/grc_integration.py').read_text().lower()
    workflows = yaml.safe_load((ROOT / '.bifrost/workflows.yaml').read_text())['workflows'].values()
    gateway = next(row for row in workflows if row.get('function_name') == 'grc_integration_gateway')
    manifest = yaml.safe_dump(gateway).lower()

    assert 'covi' not in source
    assert 'halo' not in source
    assert 'covi' not in manifest
    assert 'halo' not in manifest


def test_campaign_tables_are_solution_owned_and_tenant_scoped():
    rows = yaml.safe_load((ROOT / '.bifrost/tables.yaml').read_text())['tables'].values()
    tables = {row['name']: row for row in rows}
    for name in ['grc-policy-campaigns', 'grc-policy-campaign-assignments', 'grc-policy-acceptances']:
        assert name in tables, f'Missing campaign table: {name}'
        table = tables[name]
        assert any(column['name'] == 'organization_id' and column.get('required') for column in table['schema']['columns'])
        assert 'organization_id' in yaml.safe_dump(table['policies'])

    for name in ['grc-policy-campaigns', 'grc-policy-campaign-assignments', 'grc-policy-acceptances']:
        role_policies = [
            policy for policy in tables[name]['policies']
            if policy.get('when') != {'user': 'is_platform_admin'}
        ]
        role_actions = {action for policy in role_policies for action in policy.get('actions', [])}
        assert not {'create', 'update', 'delete'} & role_actions


class FakeTables:
    def __init__(self):
        self.rows = {
            grc_integration.TABLE_CAMPAIGNS: [],
            grc_integration.TABLE_ASSIGNMENTS: [],
            grc_integration.TABLE_ACCEPTANCES: [],
            grc_integration.TABLE_POLICIES: [
                {
                    'id': 'policy-a',
                    'data': {
                        'organization_id': 'org-1',
                        'name': 'Acceptable Use',
                        'status': 'active',
                    },
                    'updated_at': '2026-09-15T10:00:00+00:00',
                },
                {
                    'id': 'policy-b',
                    'data': {
                        'organization_id': 'org-1',
                        'name': 'Incident Response',
                        'status': 'active',
                    },
                    'updated_at': '2026-09-15T10:00:00+00:00',
                },
            ],
        }
        self.inserts = []
        self.updates = []

    async def query(self, table, where=None, limit=1000, **_kwargs):
        where = where or {}
        docs = [
            SimpleNamespace(
                id=row['id'],
                data=dict(row.get('data') or {}),
                created_at=row.get('created_at'),
                updated_at=row.get('updated_at'),
            )
            for row in self.rows.get(table, [])
            if all((row.get('data') or {}).get(key) == value for key, value in where.items())
        ][:limit]
        return SimpleNamespace(documents=docs)

    async def insert(self, table, payload, id=None):
        row_id = id or f'{table}-{len(self.rows.setdefault(table, [])) + 1}'
        row = {
            'id': row_id,
            'data': dict(payload),
            'created_at': '2026-09-16T00:00:00+00:00',
            'updated_at': '2026-09-16T00:00:00+00:00',
        }
        self.rows.setdefault(table, []).append(row)
        self.inserts.append((table, row_id, dict(payload)))
        return SimpleNamespace(**row)

    async def update(self, table, row_id, payload):
        self.updates.append((table, row_id, dict(payload)))
        for row in self.rows.get(table, []):
            if row['id'] == row_id:
                row['data'].update(payload)
                row['updated_at'] = '2026-09-16T00:00:00+00:00'
                return SimpleNamespace(**row)
        raise AssertionError(f'missing row {table}:{row_id}')


class DenyingTables(FakeTables):
    async def query(self, table, where=None, limit=1000, **_kwargs):
        raise PermissionError(f'denied {table}')


def install_context(monkeypatch, *, org_id='org-1', user_id='ctx-user'):
    context = SimpleNamespace(
        org_id=org_id,
        user=SimpleNamespace(
            id=user_id,
            email='ctx-user@example.test',
            display_name='Context User',
        ),
        organization=SimpleNamespace(is_provider=False),
        is_platform_admin=False,
        is_function_key=False,
    )
    monkeypatch.setattr(grc_integration, 'context', context)
    return context


def test_gateway_rejects_non_version_one_contract(monkeypatch):
    install_context(monkeypatch)
    monkeypatch.setattr(grc_integration, 'tables', FakeTables())

    with pytest.raises(grc_integration.UserError, match='contract_version'):
        asyncio.run(grc_integration.grc_integration_gateway(
            contract_version='2',
            operation='get_campaign_status',
            organization_id='org-1',
            actor={'id': 'request-user'},
            idempotency_key='status-1',
            payload={},
        ))


def test_gateway_rejects_missing_actor_and_wrong_tenant(monkeypatch):
    install_context(monkeypatch)
    monkeypatch.setattr(grc_integration, 'tables', FakeTables())

    with pytest.raises(grc_integration.UserError, match='actor is required'):
        asyncio.run(grc_integration.grc_integration_gateway(
            contract_version='1',
            operation='get_campaign_status',
            organization_id='org-1',
            actor=None,
            idempotency_key='status-1',
            payload={},
        ))

    with pytest.raises(grc_integration.UserError, match='organization_id must match'):
        asyncio.run(grc_integration.grc_integration_gateway(
            contract_version='1',
            operation='get_campaign_status',
            organization_id='attacker-org',
            actor={'id': 'ctx-user'},
            idempotency_key='status-2',
            payload={},
        ))


def test_gateway_rejects_actor_spoof_without_trusted_integration(monkeypatch):
    install_context(monkeypatch, user_id='ctx-user')
    monkeypatch.setattr(grc_integration, 'tables', FakeTables())

    with pytest.raises(grc_integration.UserError, match='actor.id must match'):
        asyncio.run(grc_integration.grc_integration_gateway(
            contract_version='1',
            operation='get_campaign_status',
            organization_id='org-1',
            actor={'id': 'spoofed-user'},
            idempotency_key='status-1',
            payload={},
        ))


def test_platform_provider_can_target_explicit_org_with_matching_actor(monkeypatch):
    context = install_context(monkeypatch, org_id='provider-org', user_id='ctx-user')
    context.organization = SimpleNamespace(is_provider=True)
    fake_tables = FakeTables()
    fake_tables.rows[grc_integration.TABLE_CAMPAIGNS].append({
        'id': 'campaign-1',
        'data': {
            'organization_id': 'org-1',
            'title': 'Quarterly policy acknowledgement',
            'status': 'active',
            'policy_ids_json': '["policy-a"]',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    fake_tables.rows[grc_integration.TABLE_ASSIGNMENTS].append({
        'id': 'assignment-1',
        'data': {
            'organization_id': 'org-1',
            'campaign_id': 'campaign-1',
            'actor_id': 'ctx-user',
            'status': 'assigned',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    monkeypatch.setattr(grc_integration, 'tables', fake_tables)

    result = asyncio.run(grc_integration.grc_integration_gateway(
        contract_version='1',
        operation='get_campaign_status',
        organization_id='org-1',
        actor={'id': 'ctx-user', 'email': 'ctx-user@example.test'},
        idempotency_key='status-key-1',
        payload={},
    ))

    assert result['organization_id'] == 'org-1'
    assert result['data']['campaigns'][0]['current_actor_status'] == 'assigned'
    assert context.org_id == 'provider-org'


def test_function_key_call_without_a_delegated_human_identity_is_rejected(monkeypatch):
    context = install_context(monkeypatch, org_id=None, user_id='system-user')
    context.is_function_key = True
    fake_tables = FakeTables()
    fake_tables.rows[grc_integration.TABLE_CAMPAIGNS].append({
        'id': 'campaign-1',
        'data': {
            'organization_id': 'org-1',
            'title': 'Quarterly policy acknowledgement',
            'status': 'active',
            'policy_ids_json': '["policy-a"]',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    fake_tables.rows[grc_integration.TABLE_ASSIGNMENTS].append({
        'id': 'assignment-1',
        'data': {
            'organization_id': 'org-1',
            'campaign_id': 'campaign-1',
            'actor_id': 'integration-user',
            'status': 'assigned',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    monkeypatch.setattr(grc_integration, 'tables', fake_tables)

    with pytest.raises(grc_integration.UserError, match='delegated human'):
        asyncio.run(grc_integration.grc_integration_gateway(
            contract_version='1',
            operation='get_campaign_status',
            organization_id='org-1',
            actor={'id': 'integration-user', 'email': 'integration-user@example.test'},
            idempotency_key='status-key-1',
            payload={},
        ))


def test_function_key_call_is_rejected_before_any_table_access(monkeypatch):
    context = install_context(monkeypatch, org_id=None, user_id='system-user')
    context.is_function_key = True
    monkeypatch.setattr(grc_integration, 'tables', DenyingTables())

    with pytest.raises(grc_integration.UserError, match='delegated human'):
        asyncio.run(grc_integration.grc_integration_gateway(
            contract_version='1',
            operation='get_campaign_status',
            organization_id='org-1',
            actor={'id': 'integration-user', 'email': 'integration-user@example.test'},
            idempotency_key='status-key-1',
            payload={},
        ))


def test_ensure_campaign_is_idempotent_and_uses_effective_context_actor(monkeypatch):
    install_context(monkeypatch, user_id='ctx-user')
    fake_tables = FakeTables()
    monkeypatch.setattr(grc_integration, 'tables', fake_tables)

    request = {
        'contract_version': '1',
        'operation': 'ensure_campaign',
        'organization_id': 'org-1',
        'actor': {'id': 'ctx-user', 'email': 'ctx-user@example.test'},
        'idempotency_key': 'campaign-key-1',
        'payload': {
            'campaign': {
                'title': 'Quarterly policy acknowledgement',
                'due_date': '2026-10-15',
                'link_url': 'https://grc.example.test/campaigns/campaign-key-1',
            },
            'policy_ids': ['policy-a', 'policy-b'],
            'audience': [{'actor': {'id': 'ctx-user', 'email': 'ctx-user@example.test'}}],
        },
    }

    first = asyncio.run(grc_integration.grc_integration_gateway(**request))
    second = asyncio.run(grc_integration.grc_integration_gateway(**request))

    assert first['contract_version'] == '1'
    assert first['operation'] == 'ensure_campaign'
    assert first['organization_id'] == 'org-1'
    assert first['status'] == 'ok'
    assert first['data']['campaign_count'] == 1
    assert first['data']['assignment_count'] == 1
    assert first['data']['campaigns'][0]['current_actor_status'] == 'assigned'
    assert fake_tables.rows[grc_integration.TABLE_CAMPAIGNS][0]['data']['created_by_actor_id'] == 'ctx-user'
    assert fake_tables.rows[grc_integration.TABLE_CAMPAIGNS][0]['data']['created_by_actor_email'] == 'ctx-user@example.test'
    assert len(fake_tables.rows[grc_integration.TABLE_CAMPAIGNS]) == 1
    assert len(fake_tables.rows[grc_integration.TABLE_ASSIGNMENTS]) == 1
    assert second['data']['campaigns'][0]['required_count'] == 1


def test_ensure_campaign_replay_rejects_changed_payload_and_uses_stored_audience(monkeypatch):
    install_context(monkeypatch, user_id='ctx-user')
    fake_tables = FakeTables()
    monkeypatch.setattr(grc_integration, 'tables', fake_tables)
    base_request = {
        'contract_version': '1',
        'operation': 'ensure_campaign',
        'organization_id': 'org-1',
        'actor': {'id': 'ctx-user', 'email': 'ctx-user@example.test'},
        'idempotency_key': 'campaign-key-1',
        'payload': {
            'campaign': {'title': 'Quarterly policy acknowledgement'},
            'policy_ids': ['policy-a'],
            'audience': [
                {'actor': {'id': 'ctx-user', 'email': 'ctx-user@example.test'}},
                {'actor': {'id': 'ctx-user', 'email': 'duplicate@example.test'}},
            ],
        },
    }

    asyncio.run(grc_integration.grc_integration_gateway(**base_request))
    fake_tables.rows[grc_integration.TABLE_ASSIGNMENTS].clear()
    asyncio.run(grc_integration.grc_integration_gateway(**base_request))

    assert len(fake_tables.rows[grc_integration.TABLE_ASSIGNMENTS]) == 1

    changed = {
        **base_request,
        'payload': {
            'campaign': {'title': 'Quarterly policy acknowledgement'},
            'policy_ids': ['policy-a'],
            'audience': [{'actor': {'id': 'other-user'}}],
        },
    }
    with pytest.raises(grc_integration.UserError, match='idempotency_key conflicts'):
        asyncio.run(grc_integration.grc_integration_gateway(**changed))


def test_ensure_campaign_rejects_unsafe_link_url(monkeypatch):
    install_context(monkeypatch, user_id='ctx-user')
    monkeypatch.setattr(grc_integration, 'tables', FakeTables())

    with pytest.raises(grc_integration.UserError, match='link_url'):
        asyncio.run(grc_integration.grc_integration_gateway(
            contract_version='1',
            operation='ensure_campaign',
            organization_id='org-1',
            actor={'id': 'ctx-user', 'email': 'ctx-user@example.test'},
            idempotency_key='campaign-key-1',
            payload={
                'campaign': {'title': 'Quarterly policy acknowledgement', 'link_url': 'javascript:alert(1)'},
                'policy_ids': ['policy-a'],
                'audience': [{'actor': {'id': 'ctx-user'}}],
            },
        ))


def test_get_campaign_status_is_customer_safe_and_tenant_bound(monkeypatch):
    install_context(monkeypatch, user_id='ctx-user')
    fake_tables = FakeTables()
    fake_tables.rows[grc_integration.TABLE_CAMPAIGNS].append({
        'id': 'campaign-1',
        'data': {
            'organization_id': 'org-1',
            'title': 'Quarterly policy acknowledgement',
            'status': 'active',
            'policy_ids_json': '["policy-a","policy-b"]',
            'policy_versions_json': '{"policy-a":null,"policy-b":null}',
            'due_date': '2026-10-15',
            'link_url': 'https://grc.example.test/campaigns/campaign-1',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    fake_tables.rows[grc_integration.TABLE_ASSIGNMENTS].append({
        'id': 'assignment-1',
        'data': {
            'organization_id': 'org-1',
            'campaign_id': 'campaign-1',
            'actor_id': 'ctx-user',
            'actor_email': 'ctx-user@example.test',
            'status': 'accepted',
            'metadata_json': '{"accepted_at":"2026-09-16T00:00:00+00:00"}',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    fake_tables.rows[grc_integration.TABLE_ACCEPTANCES].append({
        'id': 'acceptance-1',
        'data': {
            'organization_id': 'org-1',
            'campaign_id': 'campaign-1',
            'actor_id': 'other-user',
            'accepted_policy_ids_json': '["policy-a","policy-b"]',
            'accepted_policy_versions_json': '{"policy-a":null,"policy-b":null}',
            'accepted_at': '2026-09-16T00:00:00+00:00',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    fake_tables.rows[grc_integration.TABLE_ACCEPTANCES].append({
        'id': 'acceptance-2',
        'data': {
            'organization_id': 'org-1',
            'campaign_id': 'campaign-1',
            'actor_id': 'ctx-user',
            'accepted_policy_ids_json': '["policy-a"]',
            'accepted_policy_versions_json': '{"policy-a":null}',
            'accepted_at': '2026-09-16T00:00:00+00:00',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    fake_tables.rows[grc_integration.TABLE_ACCEPTANCES].append({
        'id': 'acceptance-3',
        'data': {
            'organization_id': 'org-1',
            'campaign_id': 'campaign-1',
            'actor_id': 'ctx-user',
            'accepted_policy_ids_json': '["policy-a","policy-b"]',
            'accepted_policy_versions_json': '{"policy-a":null,"policy-b":null}',
            'status': 'revoked',
            'accepted_at': '2026-09-16T00:00:00+00:00',
        },
        'updated_at': '2026-09-16T00:00:00+00:00',
    })
    monkeypatch.setattr(grc_integration, 'tables', fake_tables)

    result = asyncio.run(grc_integration.grc_integration_gateway(
        contract_version='1',
        operation='get_campaign_status',
        organization_id='org-1',
        actor={'id': 'ctx-user', 'email': 'ctx-user@example.test'},
        idempotency_key='status-key-1',
        payload={},
    ))

    assert result['organization_id'] == 'org-1'
    campaign = result['data']['campaigns'][0]
    assert set(campaign) == {
        'campaign_id',
        'title',
        'status',
        'required_count',
        'accepted_count',
        'current_actor_status',
        'due_date',
        'updated_at',
        'link_url',
    }
    assert campaign['required_count'] == 1
    assert campaign['accepted_count'] == 0
    assert campaign['current_actor_status'] == 'assigned'
    assert 'ctx-user@example.test' not in str(result)
