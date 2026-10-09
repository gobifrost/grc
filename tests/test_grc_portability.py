"""Public-package contracts for the Bifrost GRC Solution.

These checks exercise the shareable source boundary: a fresh install must carry
only self-contained GRC definitions and must not inherit this provider's SDK,
agent graph, customer material, or operational evidence.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess

import yaml


ROOT = Path(__file__).parents[1]


def _manifest(name: str) -> dict:
    return yaml.safe_load((ROOT / ".bifrost" / name).read_text())


def _published_environment_files() -> list[str]:
    """Inspect tracked files in a checkout, or package contents after unzip."""
    if not (ROOT / ".git").exists():
        return sorted(
            path.relative_to(ROOT).as_posix()
            for path in ROOT.rglob(".env*")
            if path.is_file()
        )

    result = subprocess.run(
        ["git", "-c", f"safe.directory={ROOT}", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return sorted(
        path for path in result.stdout.decode().split("\0")
        if Path(path).name.startswith(".env")
    )


def test_public_package_has_generic_setup_material_and_no_private_delivery_artifacts():
    assert (ROOT / "LICENSE").read_text().startswith("MIT License")
    assert (ROOT / "docs" / "setup.md").is_file()
    assert not _published_environment_files()
    for private_path in (
        "docs/delivery",
        "docs/policy-drafts",
        "docs/policy-signoff",
        "docs/pdf-examples",
        "docs/ux-captures",
        "scripts/capture_policy_signoff.py",
        "scripts/generate_pdf_examples.py",
        "scripts/grc_render_qa.mjs",
        "scripts/sync_pdf_branding.py",
        "scripts/verify_governed_writes.py",
        "scripts/verify_signoff_exports.py",
    ):
        assert not (ROOT / private_path).exists(), private_path


def test_solution_and_apps_do_not_pin_a_provider_sdk_or_url():
    solution = yaml.safe_load((ROOT / "bifrost.solution.yaml").read_text())
    assert solution["version"] == "0.14.4"
    assert solution["allow_outbound_access"] is False

    readme = (ROOT / "README.md").read_text()
    assert "bifrost solution install-repo https://github.com/gobifrost/grc" in readme
    assert "install-repo https://github.com/gobifrost/grc --global" not in readme
    assert "<repository-url>" not in readme

    for app in ("bifrost-grc-v2", "policies"):
        app_root = ROOT / "apps" / app
        package = json.loads((app_root / "package.json").read_text())
        assert "bifrost" not in package["dependencies"]
        lockfile = json.loads((app_root / "package-lock.json").read_text())
        assert "node_modules/bifrost" not in lockfile["packages"]
        assert "sdk/download" not in (app_root / "package-lock.json").read_text()


def test_optional_integration_shells_declare_only_required_connection_schema():
    connections = _manifest("connections.yaml")["connections"]

    openrouter = connections["OpenRouter"]["template"]["config_schema"]
    assert {
        field["key"]: (field["type"], field["required"])
        for field in openrouter
    } == {
        "api_key": ("secret", True),
        "default_model": ("string", True),
    }

    ciso = connections["CISO Assistant"]["template"]["config_schema"]
    assert {
        field["key"]: (field["type"], field["required"])
        for field in ciso
    } == {
        "base_url": ("string", True),
        "pat": ("secret", False),
        "username": ("string", False),
        "password": ("secret", False),
    }
    assert not any(
        "default" in field or "value" in field
        for connection in connections.values()
        for field in connection["template"]["config_schema"]
    )


def test_agent_graph_is_self_contained_and_tools_reference_bundled_workflows():
    agents = _manifest("agents.yaml")["agents"]
    workflows = _manifest("workflows.yaml")["workflows"]

    steward = next(agent for agent in agents.values() if agent["name"] == "GRC Steward")
    investigator = next(
        agent for agent in agents.values() if agent["name"] == "GRC Investigation Agent"
    )

    for agent in agents.values():
        assert set(agent["tool_ids"]) <= set(workflows)
        assert set(agent["delegated_agent_ids"]) <= set(agents)

    assert steward["delegated_agent_ids"] == [investigator["id"]]


def test_provider_access_policy_stays_explicit_in_the_portable_manifest():
    serialized = yaml.safe_dump(_manifest("file-policies.yaml"))
    assert "is_provider_org" in serialized
    assert "GRC Administrator" in serialized


def test_portable_runtime_source_contains_no_provider_or_customer_identifiers():
    source_roots = (ROOT / ".bifrost", ROOT / "apps", ROOT / "functions", ROOT / "modules", ROOT / "workflows")
    forbidden = ("covi", "gocovi", "big brothers", "bbbs")
    for source_root in source_roots:
        for path in source_root.rglob("*"):
            if not path.is_file() or "node_modules" in path.parts:
                continue
            text = path.read_text(errors="ignore").lower()
            assert not any(term in text for term in forbidden), path.relative_to(ROOT)
