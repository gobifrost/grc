from pathlib import Path
from types import SimpleNamespace
import unittest
import sys

import yaml

sys.path.insert(0, "/home/jack/GitHub/bifrost/api")
from shared.policies.probe import evaluate_action
from src.models.contracts.policies import TablePolicies


APP_TABLES = {
    "grc-applied-control-history",
    "grc-applied-controls",
    "grc-assessment-control-overrides",
    "grc-assessment-controls",
    "grc-assessments",
    "grc-control-crosswalks",
    "grc-control-mappings",
    "grc-controls",
    "grc-domains",
    "grc-evidence",
    "grc-evidence-links",
    "grc-exception-links",
    "grc-exceptions",
    "grc-frameworks",
    "grc-findings",
    "grc-policies",
    "grc-policy-links",
    "grc-questionnaire-control-links",
    "grc-questionnaire-items",
    "grc-questionnaire-proposals",
    "grc-questionnaire-recommendations",
    "grc-questionnaire-responses",
    "grc-questionnaire-runs",
    "grc-questionnaire-sections",
    "grc-questionnaires",
    "grc-risk-links",
    "grc-risks",
    "grc-source-documents",
}

ROLES = {"GRC Auditor", "GRC Contributor", "GRC Administrator"}
UNLINK_TABLES = {
    "grc-assessment-control-overrides",
    "grc-control-mappings",
    "grc-evidence-links",
    "grc-exception-links",
    "grc-policy-links",
    "grc-questionnaire-control-links",
    "grc-risk-links",
}
WORKFLOW_ONLY_TABLES = {
    "grc-policy-campaigns", "grc-policy-campaign-assignments", "grc-policy-acceptances",
    "grc-change-history", "grc-applied-control-history", "grc-policies", "grc-exceptions",
    "grc-findings", "grc-evidence", "grc-questionnaire-recommendations",
}


def load_tables() -> dict[str, dict]:
    manifest = Path(__file__).parents[1] / ".bifrost" / "tables.yaml"
    raw = yaml.safe_load(manifest.read_text())
    return {table["name"]: table for table in raw["tables"].values()}


def roles_in(policy: dict) -> set[str]:
    found: set[str] = set()

    def visit(value):
        if isinstance(value, dict):
            if value.get("call") == "has_role":
                found.update(str(role) for role in value.get("args", []))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(policy.get("when", {}))
    return found


def allows_customer_admin(condition):
    """Evaluate the policy forms used by routine-delete rules for an own-org admin."""
    if isinstance(condition, list):
        return all(allows_customer_admin(item) for item in condition)
    if not isinstance(condition, dict):
        return False
    if "and" in condition:
        return all(allows_customer_admin(item) for item in condition["and"])
    if "or" in condition:
        return any(allows_customer_admin(item) for item in condition["or"])
    if condition.get("call") == "has_role":
        return "GRC Administrator" in condition.get("args", [])
    if condition.get("user") == "is_provider_org":
        return False
    if "eq" in condition:
        return True  # own-organization row and caller are deliberately equal.
    if "is_null" in condition:
        return False
    return False


class GrcTablePolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tables = load_tables()

    def test_every_app_table_is_solution_owned(self):
        self.assertEqual(set(), APP_TABLES - set(self.tables))

    def test_every_app_table_has_platform_admin_bypass(self):
        for name in APP_TABLES:
            policies = self.tables[name]["policies"]
            bypasses = [policy for policy in policies if policy.get("when") == {"user": "is_platform_admin"}]
            self.assertTrue(bypasses, name)
            self.assertTrue({"read", "create", "update", "delete"}.issubset(set(bypasses[0]["actions"])), name)

    def test_auditors_read_and_customer_roles_do_not_hard_delete_routine_records(self):
        expected = {
            "GRC Auditor": {"read"},
            "GRC Contributor": {"read", "create", "update"},
            "GRC Administrator": {"read", "create", "update"},
        }
        for name in APP_TABLES:
            granted = {role: set() for role in ROLES}
            for policy in self.tables[name]["policies"]:
                for role in roles_in(policy):
                    if role in granted:
                        granted[role].update(policy.get("actions", []))
            for role, actions in expected.items():
                if name in WORKFLOW_ONLY_TABLES and role != "GRC Auditor":
                    actions = {"read"}
                self.assertTrue(actions.issubset(granted[role]), f"{name}: {role} has {granted[role]}")
            if name in UNLINK_TABLES:
                self.assertTrue(
                    any("delete" in policy.get("actions", []) for policy in self.tables[name]["policies"]),
                    name,
                )

    def test_customer_admin_cannot_hard_delete_routine_records(self):
        routine_delete_names = {
            "grc_tenant_delete",
            "grc_template_delete",
            "grc_fact_delete",
            "grc_policy_fact_snapshot_delete",
        }
        for name, table in self.tables.items():
            if name in UNLINK_TABLES:
                continue
            for policy in table["policies"]:
                if policy.get("name") in routine_delete_names:
                    self.assertFalse(
                        allows_customer_admin(policy["when"]),
                        f"{name}: {policy['name']} permits a customer GRC Administrator hard delete",
                    )

    def test_customer_contributor_updates_are_bound_to_their_existing_organization(self):
        for name, table in self.tables.items():
            update_policies = [
                policy for policy in table["policies"]
                if policy.get("name") in {"grc_tenant_update", "grc_tenant_write", "grc_template_update"}
            ]
            for policy in update_policies:
                serialized = yaml.safe_dump(policy["when"])
                self.assertIn("row: organization_id", serialized, f"{name}: {policy['name']}")
                self.assertIn("user: organization_id", serialized, f"{name}: {policy['name']}")

    def test_reads_are_tenant_or_global_scoped(self):
        for name in APP_TABLES:
            read_policies = [
                policy
                for policy in self.tables[name]["policies"]
                if "read" in policy.get("actions", []) and roles_in(policy)
            ]
            serialized = yaml.safe_dump(read_policies)
            self.assertIn("is_provider_org", serialized, name)
            self.assertIn("organization_id", serialized, name)
            organization_column = next((
                column for column in self.tables[name]["schema"]["columns"]
                if column.get("name") == "organization_id"
            ), None)
            if not organization_column or not organization_column.get("required"):
                self.assertIn("is_null", serialized, name)

    def test_authoritative_and_governed_records_are_read_only_outside_admin_recovery(self):
        for name in WORKFLOW_ONLY_TABLES:
            policies = [
                policy for policy in self.tables[name]["policies"]
                if policy.get("when") != {"user": "is_platform_admin"}
            ]
            actions = {action for policy in policies for action in policy.get("actions", [])}
            self.assertFalse({"create", "update", "delete"} & actions, name)

    def test_direct_forged_signoff_and_audit_writes_are_denied_by_the_policy_evaluator(self):
        user = SimpleNamespace(
            user_id="contributor", organization_id="customer-org", is_provider_org=False,
            is_platform_admin=False, role_names=["GRC Contributor"], role_ids=[], claims={},
        )
        forged_row = {"organization_id": "customer-org", "actor_id": "victim"}
        for name in {"grc-policy-campaigns", "grc-policy-campaign-assignments", "grc-policy-acceptances", "grc-change-history"}:
            policies = TablePolicies.model_validate({"policies": self.tables[name]["policies"]})
            for action in ("create", "update", "delete"):
                self.assertFalse(evaluate_action(action, policies, forged_row, user), f"{name}:{action}")

    def test_evidence_schema_supports_reviewable_open_items(self):
        columns = {column["name"] for column in self.tables["grc-evidence"]["schema"]["columns"]}
        self.assertTrue({
            "notes_markdown", "urls_json", "attachments_json", "provenance_json",
            "tags", "review_status", "last_reviewed_at", "review_due", "review_frequency_days",
        }.issubset(columns))

        policy_columns = {column["name"] for column in self.tables["grc-policies"]["schema"]["columns"]}
        self.assertTrue({"last_reviewed_at", "review_frequency_days", "review_date"}.issubset(policy_columns))


if __name__ == "__main__":
    unittest.main()
