"""Authorized managed-file references for GRC source documents.

Source-document rows predate explicit storage-location metadata.  This module
keeps those rows readable while making the location and tenant used for every
read explicit.  ``scope=None`` below means the current execution scope; it is
never treated as a global bypass and is reserved for provider-led migrations.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from bifrost import UserError

from functions.grc_auth import is_platform_scope, require_organization_access


SOURCE_LOCATION = "grc-source-documents"
EVIDENCE_LOCATION = "grc-evidence"
PDF_LOCATION = "grc-source-pdfs"

_TENANT_SOURCE_LOCATIONS = (SOURCE_LOCATION, EVIDENCE_LOCATION)
_LEGACY_MIGRATION_LOCATIONS = ("grc-source-docs", "uploads")
_ALLOWED_LOCATIONS = frozenset((*_TENANT_SOURCE_LOCATIONS, *_LEGACY_MIGRATION_LOCATIONS, PDF_LOCATION))
_MAX_FILE_KEY_LENGTH = 1024


@dataclass(frozen=True)
class SourceFileReference:
    path: str
    location: str
    scope: str | None


def source_file_reference(path: Any, organization_id: str | None) -> SourceFileReference:
    """Validate a new source reference before its source-document row exists.

    The upload/import workflow performs the later storage existence check.  New
    rows default to the declared tenant-scoped source location; callers cannot
    choose a location by embedding it in the path.
    """
    tenant = require_organization_access(organization_id, resource="source document")
    return SourceFileReference(
        path=validate_source_file_path(path),
        location=SOURCE_LOCATION,
        scope=tenant,
    )


def validate_source_file_path(value: Any) -> str:
    """Return a safe relative managed-file key or reject an untrusted path."""
    if not isinstance(value, str):
        raise UserError("source file_path must be a string")
    path = value.strip()
    if not path or len(path) > _MAX_FILE_KEY_LENGTH:
        raise UserError("source file_path is missing or too long")
    if "\\" in path or "\x00" in path or path.startswith("/") or "//" in path:
        raise UserError("source file_path must be a relative managed-file key")
    parts = path.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise UserError("source file_path must be a relative managed-file key")
    return path


def safe_source_filename(value: Any, *, fallback: str = "source.bin") -> str:
    """Normalize a display filename before it becomes a fixed-layout path leaf."""
    name = str(value or "").replace("/", "_").replace("\\", "_").strip()
    name = name.replace("..", "_")
    name = name[:200]
    return fallback if name in {"", ".", ".."} else name


def _metadata(source: dict[str, Any]) -> dict[str, Any]:
    raw = source.get("metadata_json")
    if not isinstance(raw, str):
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _declared_location(source: dict[str, Any], *, key: str) -> str | None:
    value = source.get(key) or _metadata(source).get(key)
    if value is None:
        return None
    if not isinstance(value, str) or value not in _ALLOWED_LOCATIONS:
        raise UserError("source file location is not authorized")
    return value


def _reference(path: str, location: str, organization_id: str) -> SourceFileReference:
    if location in _LEGACY_MIGRATION_LOCATIONS:
        if not is_platform_scope():
            raise UserError("legacy source files require provider migration access")
        # None intentionally inherits the authenticated provider execution
        # scope. It does not select global storage.
        return SourceFileReference(path=path, location=location, scope=None)
    return SourceFileReference(path=path, location=location, scope=organization_id)


def _candidate_locations(source: dict[str, Any], *, location_key: str, is_pdf: bool) -> tuple[str, ...]:
    declared = _declared_location(source, key=location_key)
    if declared:
        return (declared,)

    path = validate_source_file_path(source.get("pdf_file_path") if is_pdf else source.get("file_path"))
    source_id = str(source.get("id") or "")
    raw_path = source.get("file_path")
    if is_pdf and source_id and path.startswith(f"{source_id}/"):
        return (PDF_LOCATION,)
    if not is_pdf and source_id and path.startswith(f"grc-sources/{source_id}/"):
        return (SOURCE_LOCATION,)
    if is_pdf and path == raw_path:
        return _candidate_locations(source, location_key="source_file_location", is_pdf=False)
    # Older rows did not persist a location. Tenant locations remain compatible;
    # legacy provider stores are only considered by provider migration runs.
    return (*((PDF_LOCATION,) if is_pdf else ()), *_TENANT_SOURCE_LOCATIONS, *_LEGACY_MIGRATION_LOCATIONS)


async def _resolve(
    files_client: Any,
    source: dict[str, Any],
    *,
    path_key: str,
    location_key: str,
    is_pdf: bool,
) -> SourceFileReference:
    organization_id = require_organization_access(source.get("organization_id"), resource="source document")
    path = validate_source_file_path(source.get(path_key))
    candidates = _candidate_locations(source, location_key=location_key, is_pdf=is_pdf)
    skipped_legacy = False
    for location in candidates:
        if location in _LEGACY_MIGRATION_LOCATIONS and not is_platform_scope():
            skipped_legacy = True
            continue
        reference = _reference(path, location, organization_id)
        if await files_client.exists(path, location=reference.location, scope=reference.scope):
            return reference
    if skipped_legacy:
        raise UserError("legacy source files require provider migration access")
    raise UserError("source file was not found in an authorized storage location")


async def resolve_source_file_reference(files_client: Any, source: dict[str, Any]) -> SourceFileReference:
    """Resolve an authorized raw source-document reference and verify it exists."""
    return await _resolve(
        files_client,
        source,
        path_key="file_path",
        location_key="source_file_location",
        is_pdf=False,
    )


async def read_source_file(files_client: Any, source: dict[str, Any]) -> bytes:
    reference = await resolve_source_file_reference(files_client, source)
    return await files_client.read_bytes(reference.path, location=reference.location, scope=reference.scope)


async def resolve_source_pdf_reference(files_client: Any, source: dict[str, Any]) -> SourceFileReference:
    """Resolve an authorized viewer-PDF reference and verify it exists."""
    return await _resolve(
        files_client,
        source,
        path_key="pdf_file_path",
        location_key="pdf_file_location",
        is_pdf=True,
    )
