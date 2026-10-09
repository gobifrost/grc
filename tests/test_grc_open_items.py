import ast
from pathlib import Path

import yaml

from workflows.grc_v2.grc_agent_tools import _fact_marker_keys, _resolve_fact_markers


ROOT = Path(__file__).resolve().parents[1]


def test_fact_tables_and_policy_snapshot_columns_are_declared():
    manifest = yaml.safe_load((ROOT / ".bifrost/tables.yaml").read_text())
    by_name = {table["name"]: table for table in manifest["tables"].values()}
    assert {"grc-fact-definitions", "grc-facts", "grc-fact-requirements", "grc-policy-fact-snapshots", "grc-policy-templates"} <= set(by_name)
    policy_columns = {column["name"] for column in by_name["grc-policies"]["schema"]["columns"]}
    assert {"fact_snapshot_json", "fact_snapshot_at", "template_id", "template_version"} <= policy_columns

    fact_policies = {policy["name"]: policy for policy in by_name["grc-facts"]["policies"]}
    assert "GRC Auditor" in str(fact_policies["grc_fact_read"])
    assert "GRC Contributor" in str(fact_policies["grc_fact_create"])
    assert "GRC Contributor" in str(fact_policies["grc_fact_update_delete"])
    assert "organization_id" in str(fact_policies["grc_fact_create"])
    assert "scope_kind" in str(fact_policies["grc_fact_update_delete"])
    fact_columns = {column["name"] for column in by_name["grc-facts"]["schema"]["columns"]}
    assert {"scope_id", "scope_kind", "scope_size", "applied_organizations"} <= fact_columns


def test_open_item_tools_are_registered_and_assigned_to_steward():
    workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
    agents = yaml.safe_load((ROOT / ".bifrost/agents.yaml").read_text())["agents"]
    expected = {
        "bifrost_grc_seed_standard_fact_pack",
        "bifrost_grc_get_open_items",
        "bifrost_grc_manage_fact",
        "bifrost_grc_snapshot_policy_facts",
    }
    workflow_ids = {
        row["name"]: workflow_id
        for workflow_id, row in workflows.items()
        if row.get("name") in expected
    }
    assert set(workflow_ids) == expected
    steward = next(agent for agent in agents.values() if agent["name"] == "GRC Steward")
    assert set(workflow_ids.values()) <= set(steward["tool_ids"])

    tree = ast.parse((ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text())
    functions = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert expected <= functions
    assert any(row.get("name") == "bifrost_grc_count_open_items" for row in workflows.values())
    assert "bifrost_grc_count_open_items" in functions


def test_every_agent_tool_id_references_a_registered_tool():
    workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
    agents = yaml.safe_load((ROOT / ".bifrost/agents.yaml").read_text())["agents"]
    for agent in agents.values():
        for workflow_id in agent.get("tool_ids", []):
            assert workflow_id in workflows, f"{agent['name']} references missing workflow {workflow_id}"
            assert workflows[workflow_id].get("type") == "tool", (
                f"{agent['name']} assigns {workflows[workflow_id].get('name')} as a tool, "
                "but the workflow manifest does not register it as type=tool"
            )


def test_frontend_registers_open_items_and_inline_fact_rendering():
    app = (ROOT / "apps/bifrost-grc-v2/src/App.tsx").read_text()
    layout = (ROOT / "apps/bifrost-grc-v2/src/_layout.tsx").read_text()
    preview = (ROOT / "apps/bifrost-grc-v2/src/components/policy-builder/MarkdownPreview.tsx").read_text()
    page = (ROOT / "apps/bifrost-grc-v2/src/pages/open-items/index.tsx").read_text()
    summary = (ROOT / "apps/bifrost-grc-v2/src/lib/open-items.ts").read_text()
    detail = (ROOT / "apps/bifrost-grc-v2/src/pages/policies/[id].tsx").read_text()
    fact_editor = (ROOT / "apps/bifrost-grc-v2/src/components/policy-builder/PolicyFactsEditor.tsx").read_text()
    org_bar = (ROOT / "apps/bifrost-grc-v2/src/components/shared/OrganizationViewBar.tsx").read_text()
    assert 'path="open-items"' in app
    assert 'label: "Open Items"' in layout
    assert "grc-fact:" in preview and "Open in Open Items" in preview
    assert "Confirm & next" in page and "onPrimaryKeyDown" in page
    assert "Start review" in page and "cv-open-item-flashcards" in page
    assert 'role="dialog"' in page and "moveSelection" in page
    assert "<MarkdownEditor" in page and "Save status" not in page
    assert 'ariaLabel="Open item notes"' in page and "Markdown formatting is preserved" in page
    assert "WF_RESOLVE_OPEN_ITEM" in page
    assert "useFactWorkspace" in page and "logicalScopeOrganizations(facts, fact" in page
    assert "expandsScope(originalScope, scope)" in page
    assert "WF_GET_FACT_WORKSPACE" in summary
    assert 'perspective: "all"' in summary and "page_size: 200" in summary
    assert "WF_COUNT_OPEN_ITEMS" in summary and "counts?.all" in summary
    assert "pageSize: 1000" not in summary and "pageSize: 1000" not in page
    assert 'title="All caught up"' in page
    assert "openItemsCount" in layout and "itemCount > 0" in layout
    assert "organizationIds.flatMap" in summary and "resolveEffectiveFacts" in summary
    assert "policy_template" in summary and "actual document" in summary
    assert "policies" in summary and "extractFactKeys" in summary
    assert "<PolicyFactsEditor" in detail and "onFactClick" in detail
    assert "WF_MANAGE_FACT" in fact_editor and "OrgScopeField" in fact_editor
    assert 'label: "All Customers"' in org_bar and "Filter all GRC pages by customer" in org_bar


def test_open_items_correlate_responses_to_the_customer_lens_and_handle_numeric_labels():
    page = (ROOT / "apps/bifrost-grc-v2/src/pages/open-items/index.tsx").read_text()
    workspace = (ROOT / "apps/bifrost-grc-v2/src/lib/open-items.ts").read_text()
    display_text = (ROOT / "apps/bifrost-grc-v2/src/lib/display-text.ts").read_text()
    agent = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()

    assert "responseMatchesLens" in page and "bifrost_organization_id" in page
    assert "Loading {organizationId" in page
    assert "!hasOpenItems && !deferredSearch" in page
    assert "counts[perspective] > 0" in page
    assert "titleCase(value: unknown" in display_text and "String(value)" in display_text
    assert "responseMatchesLens" in workspace and "bifrost_organization_id" in workspace
    assert 'next.set("item", item.id)' in page and "sourceLinkLabel" in page
    assert 'item=findings_issues:manual_finding:{organization_id}:{row_id}' in agent


def test_combobox_popovers_remain_interactive_inside_modal_dialogs():
    combobox = (ROOT / "apps/bifrost-grc-v2/src/components/bifrost/BfCombobox.tsx").read_text()
    assert 'anchorRef.current?.closest("dialog") ?? document.body' in combobox
    assert "portalRoot" in combobox


def test_fact_markers_survive_markdown_underscore_escaping():
    content = "{{fact:organization.legal\\_name|Customer}} {{fact:backup.recovery|Backup}}"
    assert _fact_marker_keys(content) == ["backup.recovery", "organization.legal_name"]
    resolved, unresolved = _resolve_fact_markers(
        content,
        {},
        {"organization.legal_name": {"value_json": '"Example Organization"'}},
    )
    assert resolved == "Example Organization Backup"
    assert unresolved == ["backup.recovery"]

    frontend = (ROOT / "apps/bifrost-grc-v2/src/lib/fact-markers.ts").read_text()
    editor = (ROOT / "apps/bifrost-grc-v2/src/components/shared/MarkdownEditor.tsx").read_text()
    assert "normalizeFactKey" in frontend and "normalizeFactMarkers" in frontend
    assert "normalizeFactMarkers(current.getMarkdown())" in editor


def test_standard_fact_pack_has_short_titles_and_actionable_guidance():
    source = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()
    assert '("incident.cyber_insurer", "Cyber insurance contact"' in source
    assert '"Current carrier or broker, policy reference, and 24/7 breach hotline."' in source
    assert '"description": description' in source
    assert "for key, title, fact_type, expected_from, category, description in STANDARD_FACTS" in source

    agents = (ROOT / ".bifrost/agents.yaml").read_text()
    assert "Review Open Items through the bundled tool" in agents
    assert "authoritative source record" in agents


def test_agent_open_items_are_derived_from_applicable_policy_content():
    source = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()
    assert "def _policy_fact_requirements" in source
    assert 'requirement.get("target_type") != "policy_template"' in source
    body = source.split("async def _build_open_items_feed", 1)[1].split("@workflow", 1)[0]
    assert "_policy_fact_requirements" in body
    assert "TABLE_POLICIES" in body


def test_open_items_are_derived_and_change_history_is_not_generic_mutation_state():
    source = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()
    assert "async def _build_open_items_feed" in source
    assert 'perspective="findings_issues"' in source
    assert 'perspective="risks_concerns"' in source
    assert 'perspective="needs_review"' in source
    assert 'perspective="expiring"' in source
    assert 'status in {"compliant", "not_assessed"}' in source
    assert "append_source_items(\"\", shared=True)" in source
    assert "Change history is append-only" in source
    assert 'status="base_changed"' in source
    assert 'payload["reviewed_base_version"]' in source


def test_ui_and_agent_create_customer_extensions_from_fact_templates():
    policy_page = (ROOT / "apps/bifrost-grc-v2/src/pages/policies/index.tsx").read_text()
    template_page = (ROOT / "apps/bifrost-grc-v2/src/pages/policy-templates/[id].tsx").read_text()
    app = (ROOT / "apps/bifrost-grc-v2/src/App.tsx").read_text()
    agent = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()
    workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
    agents = yaml.safe_load((ROOT / ".bifrost/agents.yaml").read_text())["agents"]
    tool = next(row for row in workflows.values() if row.get("name") == "bifrost_grc_manage_policy_template")
    steward = next(row for row in agents.values() if row.get("name") == "GRC Steward")
    assert "PolicySectionTabs" in policy_page and 'active="templates"' in policy_page
    assert "TABLE_POLICY_TEMPLATES" in policy_page and "template_version" in policy_page
    assert "<MarkdownEditor" in template_page and "Referenced Facts" in template_page
    assert 'path="policy-templates/:id"' in app
    assert tool["id"] in steward["tool_ids"]
    assert "async def bifrost_grc_manage_policy_template" in agent
    manage_policy = agent.split("async def bifrost_grc_manage_policy(", 1)[1]
    assert "template_id" in manage_policy and "TABLE_POLICY_TEMPLATES" in manage_policy
    assert "ADDENDUM_TEMPLATES" not in agent


def test_effective_policy_uses_a_quiet_addendum_and_fact_profile_preserves_markdown():
    frontend = (ROOT / "apps/bifrost-grc-v2/src/lib/effective-policy.ts").read_text()
    backend = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()
    preview = (ROOT / "apps/bifrost-grc-v2/src/components/policy-builder/MarkdownPreview.tsx").read_text()
    assert '"## Customer addendum"' in frontend
    assert '"## Customer addendum"' in backend
    assert "Effective for this organization" not in frontend
    assert "Customer extension:" not in frontend
    assert "grc-fact-label:" in preview and "factMarkdownSource" in preview


def test_selected_customer_is_never_reclassified_as_the_provider():
    source = (ROOT / "workflows/grc_v2/grc_directory.py").read_text()
    assert 'str(org_id) == PLATFORM_ORG_ID' in source
    assert 'str(org_id) == caller_org_id' not in source


def test_paginated_fact_workspace_is_registered_for_all_reader_roles():
    workflows = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
    workspace = next(row for row in workflows.values() if row.get("name") == "bifrost_grc_get_fact_workspace")
    assert set(workspace["role_names"]) == {"GRC Auditor", "GRC Administrator", "GRC Contributor"}
    source = (ROOT / "workflows/grc_v2/grc_agent_tools.py").read_text()
    assert "async def bifrost_grc_get_fact_workspace" in source
    assert "_query_all_rows(TABLE_FACTS" in source
    workspace_body = source.split("async def bifrost_grc_get_fact_workspace", 1)[1].split("@workflow", 1)[0]
    assert "if is_platform_scope():" in workspace_body
    assert "else:\n            bind_organization_scope(target" in workspace_body
