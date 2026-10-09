import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))

from functions import grc_auth
from workflows.grc_v2 import grc_files, grc_questionnaires, grc_source_documents
from workflows.grc_v2 import grc_source_files


def install_context(monkeypatch, *, provider: bool = False):
    monkeypatch.setattr(
        grc_auth,
        "context",
        SimpleNamespace(
            org_id="customer-org",
            organization=SimpleNamespace(is_provider=provider),
            is_platform_admin=False,
        ),
    )


class RecordingFiles:
    def __init__(self, existing: set[tuple[str, str, str | None]]):
        self.existing = existing
        self.calls: list[tuple[str, str, str | None]] = []

    async def exists(self, path, *, location, scope):
        self.calls.append((path, location, scope))
        return (path, location, scope) in self.existing

    async def read_bytes(self, path, *, location, scope):
        self.calls.append((path, location, scope))
        return b"source bytes"


def test_source_reference_rejects_traversal_before_any_storage_probe(monkeypatch):
    install_context(monkeypatch)
    files = RecordingFiles(set())

    with pytest.raises(grc_source_files.UserError, match="relative managed-file key"):
        asyncio.run(
            grc_source_files.read_source_file(
                files,
                {"id": "source-1", "organization_id": "customer-org", "file_path": "../other-org/secret.docx"},
            )
        )

    assert files.calls == []


def test_new_source_reference_binds_a_safe_key_to_the_callers_tenant(monkeypatch):
    install_context(monkeypatch)

    reference = grc_source_files.source_file_reference(
        "incoming/questionnaire.docx", "customer-org"
    )

    assert reference == grc_source_files.SourceFileReference(
        path="incoming/questionnaire.docx",
        location="grc-source-documents",
        scope="customer-org",
    )


def test_safe_source_filename_cannot_create_a_dot_path_segment():
    assert grc_source_files.safe_source_filename(".", fallback="upload.bin") == "upload.bin"


def test_canonical_source_reference_reads_only_its_tenant_scoped_location(monkeypatch):
    install_context(monkeypatch)
    path = "grc-sources/source-1/questionnaire.docx"
    files = RecordingFiles({(path, "grc-source-documents", "customer-org")})

    result = asyncio.run(
        grc_source_files.read_source_file(
            files,
            {"id": "source-1", "organization_id": "customer-org", "file_path": path},
        )
    )

    assert result == b"source bytes"
    assert files.calls == [
        (path, "grc-source-documents", "customer-org"),
        (path, "grc-source-documents", "customer-org"),
    ]


def test_legacy_global_location_requires_provider_migration_access(monkeypatch):
    install_context(monkeypatch)
    files = RecordingFiles({("imports/questionnaire.docx", "uploads", None)})

    with pytest.raises(grc_source_files.UserError, match="provider migration"):
        asyncio.run(
            grc_source_files.resolve_source_file_reference(
                files,
                {"organization_id": "customer-org", "file_path": "imports/questionnaire.docx"},
            )
        )

    assert ("imports/questionnaire.docx", "uploads", None) not in files.calls


def test_provider_migration_may_read_a_legacy_file_in_its_execution_scope(monkeypatch):
    install_context(monkeypatch, provider=True)
    files = RecordingFiles({("imports/questionnaire.docx", "uploads", None)})

    reference = asyncio.run(
        grc_source_files.resolve_source_file_reference(
            files,
            {"organization_id": "customer-org", "file_path": "imports/questionnaire.docx"},
        )
    )

    assert reference == grc_source_files.SourceFileReference(
        path="imports/questionnaire.docx", location="uploads", scope=None
    )


def test_generic_download_rejects_traversal_before_querying_records(monkeypatch):
    install_context(monkeypatch)
    tables = SimpleNamespace(query=lambda *_args, **_kwargs: pytest.fail("path validation must run first"))
    monkeypatch.setattr(grc_files, "tables", tables)

    with pytest.raises(grc_files.UserError, match="relative managed-file key"):
        asyncio.run(grc_files.grc_v2_get_download_url("../other-org/secret.pdf", "customer-org"))


def test_source_pdf_url_rejects_a_tampered_stored_path(monkeypatch):
    install_context(monkeypatch)

    class Tables:
        async def get(self, _table, _row_id):
            return SimpleNamespace(data={
                "organization_id": "customer-org",
                "file_name": "questionnaire.pdf",
                "mime_type": "application/pdf",
                "file_path": "grc-sources/source-1/questionnaire.pdf",
                "pdf_file_path": "../other-org/secret.pdf",
            }, id="source-1")

    files = RecordingFiles(set())
    monkeypatch.setattr(grc_source_documents, "tables", Tables())
    monkeypatch.setattr(grc_source_documents, "files", files)

    result = asyncio.run(grc_source_documents.get_grc_source_pdf_url("source-1"))

    assert result["status"] == "source_missing"
    assert "relative managed-file key" in result["error"]
    assert files.calls == []


def test_questionnaire_evidence_proposal_leaves_uploader_for_the_apply_operation(monkeypatch):
    install_context(monkeypatch, provider=True)

    async def upsert(_table, _row_id, payload):
        return {"id": "proposal-1", **payload}

    monkeypatch.setattr(grc_questionnaires, "_upsert_row", upsert)

    proposal = asyncio.run(
        grc_questionnaires._upsert_create_proposal(
            "questionnaire-1",
            "customer-org",
            {"id": "item-1", "question_text": "Provide endpoint evidence"},
            "response-1",
            {"kind": "evidence", "what": "Endpoint report"},
        )
    )

    draft = json.loads(proposal["draft_payload_json"])
    assert "uploaded_by" not in draft


def test_questionnaire_evidence_apply_uses_the_applying_actor(monkeypatch):
    install_context(monkeypatch, provider=True)
    created: list[tuple[str, dict]] = []
    proposal = {
        "id": "proposal-1",
        "questionnaire_id": "questionnaire-1",
        "response_id": "response-1",
        "item_id": "item-1",
        "action": "create",
        "target_type": "evidence",
        "status": "accepted",
        "content_hash": "source-hash",
        "draft_payload_json": json.dumps({
            "name": "Endpoint report",
            "uploaded_by": "proposal-author",
        }),
        "relationship_payloads_json": "[]",
    }

    class Tables:
        async def get(self, table, _row_id):
            if table == grc_questionnaires.TABLE_QUESTIONNAIRES:
                return SimpleNamespace(id="questionnaire-1", data={"organization_id": "customer-org"})
            raise AssertionError(f"unexpected table get: {table}")

        async def insert(self, table, _payload):
            assert table == grc_questionnaires.TABLE_QUESTIONNAIRE_RUNS
            return SimpleNamespace(id="run-1")

        async def update(self, *_args, **_kwargs):
            return None

    async def query_rows(table, **_kwargs):
        if table == grc_questionnaires.TABLE_QUESTIONNAIRE_RESPONSES:
            return [{"id": "response-1", "item_id": "item-1", "final_answer": "yes", "status": "accepted"}]
        if table == grc_questionnaires.TABLE_QUESTIONNAIRE_PROPOSALS:
            return [proposal]
        if table == grc_questionnaires.TABLE_QUESTIONNAIRE_CONTROL_LINKS:
            return []
        raise AssertionError(f"unexpected table query: {table}")

    async def upsert(table, row_id, payload):
        created.append((table, payload))
        return {"id": row_id, **payload}

    monkeypatch.setattr(grc_questionnaires, "tables", Tables())
    monkeypatch.setattr(grc_questionnaires, "_query_rows", query_rows)
    monkeypatch.setattr(grc_questionnaires, "_upsert_row", upsert)
    monkeypatch.setattr(grc_questionnaires, "_apply_relationship_payloads", lambda *_args: _zero())
    monkeypatch.setattr(grc_questionnaires, "bind_organization_scope", lambda org, **_kwargs: org)
    monkeypatch.setattr(grc_questionnaires, "require_row_access", lambda row, **_kwargs: row["organization_id"])
    monkeypatch.setattr(grc_questionnaires, "require_provider", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(grc_questionnaires, "caller_organization_id", lambda: "provider-org")
    monkeypatch.setattr(grc_questionnaires, "authenticated_actor_id", lambda: "applying-actor")

    asyncio.run(grc_questionnaires.grc_v2_apply_grc_questionnaire_answers("questionnaire-1"))

    evidence_payload = next(payload for table, payload in created if table == grc_questionnaires.TABLE_EVIDENCE)
    assert evidence_payload["uploaded_by"] == "applying-actor"


async def _zero():
    return 0
