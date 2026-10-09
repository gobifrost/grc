import unittest

from functions.grc_scope import applies_to_organization, effective_control, inherited_scope, resolve_effective_facts


class GrcScopeTests(unittest.TestCase):
    def test_all_includes_new_customer_without_row_mutation(self):
        row = {"organization_id": "provider", "applied_organizations": None, "excluded_organizations": []}
        self.assertTrue(applies_to_organization(row, "customer-created-later"))

    def test_explicit_some_and_exclusion(self):
        row = {
            "organization_id": "provider",
            "applied_organizations": ["a", "b", "c"],
            "excluded_organizations": ["c"],
        }
        self.assertTrue(applies_to_organization(row, "a"))
        self.assertFalse(applies_to_organization(row, "c"))
        self.assertFalse(applies_to_organization(row, "d"))

    def test_relationship_inherits_scope_not_owner(self):
        self.assertEqual(
            inherited_scope({"organization_id": "provider", "applied_organizations": ["a", "b"]}),
            {"applied_organizations": ["a", "b"], "excluded_organizations": []},
        )

    def test_customer_override_wins_without_replacing_default(self):
        default = {"id": "default", "status": "compliant", "implementation_percentage": 100}
        override = {
            "id": "override",
            "customer_organization_id": "customer-b",
            "status": "partially_compliant",
            "implementation_percentage": 50,
        }
        effective = effective_control(default, override)
        self.assertEqual(effective["status"], "partially_compliant")
        self.assertEqual(default["status"], "compliant")
        self.assertTrue(effective["is_override"])

    def test_fact_resolution_prefers_one_then_narrowest_some_then_all(self):
        rows = [
            {"id": "global", "fact_key": "channel", "organization_id": None, "applied_organizations": None, "scope_kind": "all"},
            {"id": "some", "fact_key": "channel", "organization_id": "a", "applied_organizations": ["a"], "scope_kind": "some", "scope_id": "group", "scope_size": 3},
            {"id": "one", "fact_key": "channel", "organization_id": "a", "applied_organizations": ["a"], "scope_kind": "one", "scope_id": "one-a", "scope_size": 1},
        ]
        resolved, conflicts = resolve_effective_facts(rows, "a")
        self.assertEqual(resolved["channel"]["id"], "one")
        self.assertFalse(conflicts)
        self.assertEqual(resolve_effective_facts(rows[:2], "a")[0]["channel"]["id"], "some")
        self.assertEqual(resolve_effective_facts(rows[:1], "a")[0]["channel"]["id"], "global")

    def test_equal_specificity_fact_scopes_are_a_conflict(self):
        rows = [
            {"id": "one-a", "fact_key": "owner", "organization_id": "a", "scope_id": "scope-a", "scope_kind": "one", "scope_size": 1},
            {"id": "one-b", "fact_key": "owner", "organization_id": "a", "scope_id": "scope-b", "scope_kind": "one", "scope_size": 1},
        ]
        resolved, conflicts = resolve_effective_facts(rows, "a")
        self.assertNotIn("owner", resolved)
        self.assertEqual({row["id"] for row in conflicts["owner"]}, {"one-a", "one-b"})


if __name__ == "__main__":
    unittest.main()
