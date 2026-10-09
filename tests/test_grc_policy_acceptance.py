from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).parents[1]))

from functions.grc_policy_acceptance import is_genuine_policy_acceptance


CAMPAIGN = {
    "id": "campaign-1",
    "organization_id": "org-1",
    "policy_ids_json": '["policy-a","policy-b"]',
    "policy_versions_json": '{"policy-a":"1","policy-b":"2"}',
}
ASSIGNMENT = {
    "id": "assignment-1",
    "organization_id": "org-1",
    "campaign_id": "campaign-1",
    "actor_id": "recipient-1",
    "status": "accepted",
}
ACCEPTANCE = {
    "organization_id": "org-1",
    "campaign_id": "campaign-1",
    "assignment_id": "assignment-1",
    "actor_id": "recipient-1",
    "status": "accepted",
    "source_system": "bifrost_grc_policy_recipient",
    "accepted_at": "2026-10-06T12:00:00+00:00",
    "accepted_policy_ids_json": '["policy-a","policy-b"]',
    "accepted_policy_versions_json": '{"policy-a":"1","policy-b":"2"}',
}


def test_recipient_acceptance_requires_the_genuine_source_and_exact_assignment_binding():
    assert is_genuine_policy_acceptance(ACCEPTANCE, ASSIGNMENT, CAMPAIGN)

    assert not is_genuine_policy_acceptance(
        {**ACCEPTANCE, "source_system": "manual_import"}, ASSIGNMENT, CAMPAIGN
    )
    assert not is_genuine_policy_acceptance(
        {**ACCEPTANCE, "actor_id": "other-user"}, ASSIGNMENT, CAMPAIGN
    )
    assert not is_genuine_policy_acceptance(
        {**ACCEPTANCE, "accepted_policy_versions_json": '{"policy-a":"3","policy-b":"2"}'},
        ASSIGNMENT,
        CAMPAIGN,
    )
    assert not is_genuine_policy_acceptance(
        {**ACCEPTANCE, "accepted_policy_ids_json": '["policy-a","policy-b","policy-b"]'},
        ASSIGNMENT,
        CAMPAIGN,
    )
