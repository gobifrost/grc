"""
GRC: signed-URL helpers for direct browser file upload/download.

Apps call `Get Upload URL` to get a signed PUT URL, then PUT the file
straight to storage from the browser; afterwards they store the returned
`path` on whichever row (evidence, etc.) and use `Get Download URL` to
hand out a short-lived GET URL when the user clicks the file.
"""
import logging
import json
import base64
import re
import uuid as _uuid

from bifrost import workflow, files, tables, UserError

from functions.grc_auth import is_platform_scope, require_organization_access, require_provider, require_row_access
from workflows.grc_v2.grc_source_files import validate_source_file_path

logger = logging.getLogger(__name__)

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
EVIDENCE_LOCATION = "grc-evidence"
TEXT_LOCATION = "grc-questionnaire-text"
POLICY_LOCATION = "grc-policy-files"
DOWNLOAD_LOCATIONS = (
    (EVIDENCE_LOCATION, True),
    ("grc-source-documents", True),
    ("grc-source-pdfs", True),
    # Pre-migration global locations. Only provider/platform callers may probe
    # them; a shared Solution install cannot safely expose them to customers.
    ("uploads", False),
    ("grc-source-docs", False),
    ("grc-source-pdfs", False),
)


def _sanitize(name: str) -> str:
    name = (name or "").strip() or "file"
    name = _SAFE_NAME.sub("_", name)
    return name[:200]


def _row_data(raw) -> dict:
    return getattr(raw, "data", None) or (raw.get("data", {}) if isinstance(raw, dict) else {})


def _attachment_paths(row: dict) -> set[str]:
    try:
        attachments = json.loads(row.get("attachments_json") or "[]")
    except (TypeError, ValueError):
        attachments = []
    return {
        str(item.get("path"))
        for item in attachments
        if isinstance(item, dict) and item.get("path")
    }


async def _has_authorized_file_reference(path: str, organization_id: str) -> bool:
    """Bind a generic download URL to a GRC row owned by the caller's org."""
    for table in ("grc-evidence", "grc-source-documents"):
        direct = await tables.query(
            table,
            where={"organization_id": organization_id, "file_path": path},
            limit=1,
        )
        for raw in getattr(direct, "documents", []):
            row = _row_data(raw)
            require_row_access(row, resource="GRC file record")
            if row.get("file_path") == path:
                return True

    # Evidence may retain multiple managed attachments. Scan bounded pages so a
    # later row cannot cause a caller to fall back to an arbitrary path.
    offset = 0
    while offset < 10_000:
        result = await tables.query(
            "grc-evidence",
            where={"organization_id": organization_id},
            limit=1000,
            offset=offset,
        )
        page = list(getattr(result, "documents", []))
        for raw in page:
            row = _row_data(raw)
            require_row_access(row, resource="evidence")
            if path in _attachment_paths(row):
                return True
        if len(page) < 1000:
            break
        offset += len(page)
    return False


async def _authorized_policy(policy_id: str) -> dict:
    raw = await tables.get("grc-policies", policy_id)
    row = _row_data(raw)
    if not row:
        raise UserError("policy not found")
    if row.get("organization_id"):
        require_organization_access(row["organization_id"], resource="policy file")
    else:
        require_provider("Provider access is required for files on a global policy.")
    return row


@workflow(
    name="Get Upload URL",
    description="Return a signed PUT URL for direct browser-to-storage uploads under grc/<uuid>/<filename>.",
    category="grc",
)
async def grc_v2_get_upload_url(
    filename: str,
    organization_id: str,
    content_type: str = "application/octet-stream",
) -> dict:
    if not filename:
        raise UserError("filename is required")
    if not organization_id:
        raise UserError("organization_id is required")
    organization_id = require_organization_access(organization_id, resource="evidence file")
    safe = _sanitize(filename)
    path = f"grc/{_uuid.uuid4().hex}/{safe}"
    signed = await files.get_signed_url(
        path,
        method="PUT",
        content_type=content_type or "application/octet-stream",
        location=EVIDENCE_LOCATION,
        scope=organization_id,
    )
    url = signed.get("url") if isinstance(signed, dict) else signed
    fields = signed.get("fields") if isinstance(signed, dict) else None
    return {"url": url, "path": path, "fields": fields}


@workflow(
    name="Get Download URL",
    description="Return a short-lived signed GET URL for a previously uploaded file path.",
    category="grc",
)
async def grc_v2_get_download_url(path: str, organization_id: str) -> dict:
    path = validate_source_file_path(path)
    if not organization_id:
        raise UserError("organization_id is required")
    organization_id = require_organization_access(organization_id, resource="GRC file")
    if not await _has_authorized_file_reference(path, organization_id):
        raise UserError("File is not referenced by a GRC record in your organization.")
    signed = None
    for candidate, tenant_scoped in DOWNLOAD_LOCATIONS:
        if not tenant_scoped and not is_platform_scope():
            continue
        try:
            scope = organization_id if tenant_scoped else None
            if await files.exists(path, location=candidate, scope=scope):
                signed = await files.get_signed_url(
                    path,
                    method="GET",
                    location=candidate,
                    scope=scope,
                )
                break
        except Exception:
            continue
    if signed is None:
        raise UserError("file not found")
    url = signed.get("url") if isinstance(signed, dict) else signed
    return {"url": url}


@workflow(
    name="Get Policy Upload URL",
    description="Return an authorized signed PUT URL for an attachment or pasted image on a GRC policy.",
    category="grc",
)
async def grc_v2_get_policy_upload_url(
    policy_id: str,
    filename: str,
    content_type: str = "application/octet-stream",
) -> dict:
    if not policy_id or not filename:
        raise UserError("policy_id and filename are required")
    row = await _authorized_policy(policy_id)
    safe = _sanitize(filename)
    path = f"policies/{policy_id}/{_uuid.uuid4().hex}/{safe}"
    scope = row.get("organization_id") or None
    signed = await files.get_signed_url(
        path,
        method="PUT",
        content_type=content_type or "application/octet-stream",
        location=POLICY_LOCATION,
        scope=scope,
    )
    return {
        "url": signed.get("url") if isinstance(signed, dict) else signed,
        "path": path,
        "fields": signed.get("fields") if isinstance(signed, dict) else None,
    }


@workflow(
    name="Get Policy Download URL",
    description="Return an authorized signed GET URL for a managed file referenced by a GRC policy.",
    category="grc",
)
async def grc_v2_get_policy_download_url(policy_id: str, path: str) -> dict:
    if not policy_id or not path:
        raise UserError("policy_id and path are required")
    path = validate_source_file_path(path)
    row = await _authorized_policy(policy_id)
    try:
        attachments = json.loads(row.get("attachments_json") or "[]")
    except (TypeError, ValueError):
        attachments = []
    allowed_paths = {
        item.get("path") for item in attachments
        if isinstance(item, dict) and item.get("path")
    }
    if path not in allowed_paths:
        raise UserError("file is not attached to this policy")
    scope = row.get("organization_id") or None
    if not await files.exists(path, location=POLICY_LOCATION, scope=scope):
        raise UserError("file not found")
    signed = await files.get_signed_url(path, method="GET", location=POLICY_LOCATION, scope=scope)
    return {"url": signed.get("url") if isinstance(signed, dict) else signed}


@workflow(
    name="bifrost_grc_manage_policy_file",
    description=(
        "List, add, or remove managed files and pasted images on a GRC policy. "
        "Add/remove operations are dry-run-first and require explicit confirmation."
    ),
    category="grc",
    is_tool=True,
)
async def bifrost_grc_manage_policy_file(
    policy_id: str,
    operation: str = "list",
    filename: str | None = None,
    content_type: str = "application/octet-stream",
    content_base64: str | None = None,
    attachment_id: str | None = None,
    insert_image_markdown: bool = False,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict:
    if operation not in {"list", "add", "remove"}:
        raise UserError("operation must be list, add, or remove")
    if apply and operation != "list" and not confirm_apply:
        raise UserError("confirm_apply=true is required before changing policy files")
    row = await _authorized_policy(policy_id)
    try:
        attachments = json.loads(row.get("attachments_json") or "[]")
    except (TypeError, ValueError):
        attachments = []
    attachments = [item for item in attachments if isinstance(item, dict)]
    if operation == "list":
        return {"mode": "read_only", "policy_id": policy_id, "attachments": attachments}

    scope = row.get("organization_id") or None
    if operation == "add":
        if not filename or not content_base64:
            raise UserError("filename and content_base64 are required for add")
        try:
            content = base64.b64decode(content_base64, validate=True)
        except Exception as exc:
            raise UserError("content_base64 is not valid base64") from exc
        if len(content) > 25 * 1024 * 1024:
            raise UserError("policy files are limited to 25 MB")
        path = f"policies/{policy_id}/{_uuid.uuid4().hex}/{_sanitize(filename)}"
        attachment = {
            "id": _uuid.uuid4().hex,
            "path": path,
            "name": filename,
            "contentType": content_type or "application/octet-stream",
            "sizeBytes": len(content),
            "kind": "image" if (content_type or "").startswith("image/") else "file",
        }
        preview = {"mode": "apply" if apply else "dry_run", "operation": "add", "policy_id": policy_id, "attachment": attachment}
        if not apply:
            return preview
        await files.write_bytes(path, content, location=POLICY_LOCATION, scope=scope, create_only=True)
        attachments.append(attachment)
        patch = {"attachments_json": json.dumps(attachments, separators=(",", ":"))}
        if insert_image_markdown and attachment["kind"] == "image":
            uri = f"bifrost-policy-file://{policy_id}/{path}"
            patch["content"] = f"{str(row.get('content') or '').rstrip()}\n\n![{filename}]({uri})\n"
        await tables.update("grc-policies", policy_id, patch)
        return preview

    attachment = next((item for item in attachments if item.get("id") == attachment_id), None)
    if not attachment:
        raise UserError("attachment not found on policy")
    preview = {"mode": "apply" if apply else "dry_run", "operation": "remove", "policy_id": policy_id, "attachment": attachment}
    if not apply:
        return preview
    await files.delete(attachment["path"], location=POLICY_LOCATION, scope=scope)
    attachments = [item for item in attachments if item.get("id") != attachment_id]
    await tables.update("grc-policies", policy_id, {"attachments_json": json.dumps(attachments, separators=(",", ":"))})
    return preview


@workflow(
    name="Read GRC Workspace Text File",
    description="Read a bounded UTF-8 text file from Bifrost GRC workspace storage for document review previews.",
    category="grc",
)
async def read_grc_workspace_text_file(source_document_id: str, max_chars: int = 120000) -> dict:
    if not source_document_id:
        raise UserError("source_document_id is required")
    if max_chars < 1:
        raise UserError("max_chars must be at least 1")
    raw = await tables.get("grc-source-documents", source_document_id)
    data = getattr(raw, "data", None) or (raw.get("data", {}) if isinstance(raw, dict) else {})
    require_row_access(data, resource="source document")
    path = data.get("extracted_text_path")
    organization_id = data.get("organization_id")
    if not path or not organization_id:
        raise UserError("source document has no tenant-scoped extracted text")
    path = validate_source_file_path(path)
    try:
        text = await files.read(path, location=TEXT_LOCATION, scope=organization_id)
    except Exception as exc:
        logger.warning(
            "Tenant-scoped questionnaire text could not be read for source document %s",
            source_document_id,
        )
        raise UserError(
            "Extracted text is unavailable. Re-run questionnaire extraction to regenerate it."
        ) from exc
    truncated = len(text) > max_chars
    return {
        "text": text[:max_chars],
        "chars": len(text),
        "truncated": truncated,
        "returned_chars": min(len(text), max_chars),
    }
