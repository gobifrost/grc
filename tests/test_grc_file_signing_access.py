import asyncio
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))

from functions import grc_auth
from workflows.grc_v2 import grc_files


class FakeTables:
    async def query(self, _table, where=None, limit=1000, **_kwargs):
        return SimpleNamespace(documents=[])


class FakeFiles:
    async def exists(self, *_args, **_kwargs):
        return True

    async def get_signed_url(self, *_args, **_kwargs):
        return {"url": "https://example.test/signed"}


def install_customer_context(monkeypatch):
    ctx = SimpleNamespace(
        org_id="customer-org",
        organization=SimpleNamespace(is_provider=False),
        is_platform_admin=False,
    )
    monkeypatch.setattr(grc_auth, "context", ctx)


def test_generic_download_requires_an_owning_grc_record(monkeypatch):
    install_customer_context(monkeypatch)
    monkeypatch.setattr(grc_files, "tables", FakeTables())
    monkeypatch.setattr(grc_files, "files", FakeFiles())

    with pytest.raises(grc_files.UserError, match="referenced"):
        asyncio.run(grc_files.grc_v2_get_download_url("unlinked.pdf", "customer-org"))


def test_generic_download_signs_a_file_referenced_by_the_callers_record(monkeypatch):
    class ReferencingTables(FakeTables):
        async def query(self, table, where=None, limit=1000, **_kwargs):
            if table == "grc-source-documents" and where and where.get("file_path") == "owned.pdf":
                return SimpleNamespace(documents=[SimpleNamespace(data={
                    "organization_id": "customer-org",
                    "file_path": "owned.pdf",
                })])
            return await super().query(table, where=where, limit=limit)

    install_customer_context(monkeypatch)
    monkeypatch.setattr(grc_files, "tables", ReferencingTables())
    monkeypatch.setattr(grc_files, "files", FakeFiles())

    result = asyncio.run(grc_files.grc_v2_get_download_url("owned.pdf", "customer-org"))

    assert result == {"url": "https://example.test/signed"}
