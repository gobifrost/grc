from pathlib import Path
import ast
import unittest

import yaml


ROOT = Path(__file__).parents[1]


class GrcPolicyFilesAndAgentTests(unittest.TestCase):
    def test_policy_files_are_declared_and_role_protected(self):
        locations = yaml.safe_load((ROOT / ".bifrost/files.yaml").read_text())["locations"]
        self.assertIn("grc-policy-files", locations)

        manifest = yaml.safe_load((ROOT / ".bifrost/file-policies.yaml").read_text())["file_policies"]
        policy = next(row for row in manifest.values() if row["location"] == "grc-policy-files")
        serialized = yaml.safe_dump(policy)
        for role in ("GRC Auditor", "GRC Contributor", "GRC Administrator"):
            self.assertIn(role, serialized)
        for action in ("read", "list", "write", "delete"):
            self.assertIn(action, serialized)

    def test_customer_contributors_cannot_hard_delete_grc_files(self):
        manifest = yaml.safe_load((ROOT / ".bifrost/file-policies.yaml").read_text())["file_policies"]
        policy = next(row for row in manifest.values() if row["location"] == "grc-policy-files")
        contributor_deletes = [
            rule
            for rule in policy["policies"]
            if "delete" in rule.get("actions", []) and "GRC Contributor" in yaml.safe_dump(rule.get("when", {}))
        ]
        self.assertTrue(contributor_deletes)
        for rule in contributor_deletes:
            serialized = yaml.safe_dump(rule["when"])
            self.assertIn("is_provider_org", serialized)
            self.assertIn("GRC Administrator", serialized)

    def test_direct_managed_file_access_is_provider_only(self):
        manifest = yaml.safe_load((ROOT / ".bifrost/file-policies.yaml").read_text())["file_policies"]
        for policy in manifest.values():
            for rule in policy["policies"]:
                if rule["name"] == "platform_admin_bypass":
                    continue
                serialized = yaml.safe_dump(rule.get("when", {}))
                self.assertIn("is_provider_org", serialized, f"{policy['location']}: {rule['name']}")

    def test_policy_schema_and_editor_support_managed_images(self):
        tables = yaml.safe_load((ROOT / ".bifrost/tables.yaml").read_text())["tables"]
        policy_table = next(row for row in tables.values() if row["name"] == "grc-policies")
        columns = {column["name"] for column in policy_table["schema"]["columns"]}
        self.assertIn("attachments_json", columns)

        detail = (ROOT / "apps/bifrost-grc-v2/src/pages/policies/[id].tsx").read_text()
        preview = (ROOT / "apps/bifrost-grc-v2/src/components/policy-builder/MarkdownPreview.tsx").read_text()
        self.assertIn("onPaste", detail)
        self.assertIn("bifrost-policy-file://", detail)
        self.assertIn("WF_GET_POLICY_UPLOAD_URL", detail)
        self.assertIn("WF_GET_POLICY_DOWNLOAD_URL", preview)

    def test_policy_file_workflows_validate_policy_membership(self):
        source = (ROOT / "workflows/grc_v2/grc_files.py").read_text()
        tree = ast.parse(source)
        functions = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        self.assertIn("grc_v2_get_policy_upload_url", functions)
        self.assertIn("grc_v2_get_policy_download_url", functions)
        self.assertIn("bifrost_grc_manage_policy_file", functions)
        self.assertIn('if path not in allowed_paths', source)
        self.assertIn('location=POLICY_LOCATION', source)

    def test_steward_has_full_app_query_and_fallback_mutation_tools(self):
        agents = yaml.safe_load((ROOT / ".bifrost/agents.yaml").read_text())["agents"]
        workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
        steward = next(agent for agent in agents.values() if agent["name"] == "GRC Steward")
        workflow_ids = {row["name"]: workflow_id for workflow_id, row in workflows.items()}
        self.assertIn(workflow_ids["bifrost_grc_query_records"], steward["tool_ids"])
        self.assertIn(workflow_ids["bifrost_grc_manage_record"], steward["tool_ids"])
        self.assertIn(workflow_ids["bifrost_grc_manage_policy_file"], steward["tool_ids"])

        table_manifest = yaml.safe_load((ROOT / ".bifrost/tables.yaml").read_text())["tables"]
        source = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()
        for table in table_manifest.values():
            self.assertIn(f'"{table["name"]}"', source, table["name"])


if __name__ == "__main__":
    unittest.main()
