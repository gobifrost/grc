from pathlib import Path
import re


ROOT = Path(__file__).parents[1]
APP = ROOT / "apps" / "bifrost-grc-v2" / "src"


def test_auditor_read_only_gate_has_one_authoritative_role_definition():
    source = (APP / "lib" / "current-user.ts").read_text()

    assert '"GRC Contributor"' in source
    assert '"GRC Administrator"' in source
    editor_roles = re.search(r'const GRC_EDITOR_ROLES = new Set\(\[(.*?)\]\)', source, re.DOTALL)
    assert editor_roles is not None
    assert '"GRC Auditor"' not in editor_roles.group(1)
    assert "export function canEditGrc" in source
    assert "export function useGrcPermissions" in source


def test_primary_grc_mutation_surfaces_use_the_auditor_gate():
    guarded_surfaces = [
        "pages/frameworks/index.tsx",
        "pages/applied-controls/index.tsx",
        "pages/assessments/index.tsx",
        "pages/evidence/index.tsx",
        "pages/policies/index.tsx",
        "pages/risks/index.tsx",
        "pages/exceptions/index.tsx",
        "pages/questionnaires/index.tsx",
        "pages/evidence/[id].tsx",
        "pages/policies/[id].tsx",
        "pages/policy-templates/[id].tsx",
        "pages/frameworks/[id].tsx",
        "pages/applied-controls/[id].tsx",
        "pages/assessments/[id].tsx",
        "pages/risks/[id].tsx",
        "pages/exceptions/[id].tsx",
        "pages/questionnaires/[id].tsx",
        "pages/settings/index.tsx",
    ]

    for relative_path in guarded_surfaces:
        source = (APP / relative_path).read_text()
        assert "useGrcPermissions" in source, relative_path
        assert "canEdit" in source, relative_path
