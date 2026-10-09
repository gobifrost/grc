"""Source-document helpers for Bifrost GRC.

The questionnaire viewer needs a PDF for the right pane. PDF sources pass through
unchanged; DOCX sources are converted to PDF on demand using mammoth (DOCX → HTML)
+ xhtml2pdf (HTML → PDF via reportlab — pure-python, no system deps).

Convert workflow updates the source-document row's `pdf_file_path` so the viewer
just reads that field.
"""
import io
import logging
import uuid
from typing import Any

from bifrost import UserError, files, tables, workflow

from functions.grc_auth import require_row_access
from workflows.grc_v2.grc_source_files import (
    read_source_file,
    resolve_source_pdf_reference,
    safe_source_filename,
)


TABLE_SOURCE_DOCUMENTS = "grc-source-documents"
SOURCE_LOCATION = "grc-source-documents"  # raw uploaded bytes (DOCX/PDF/etc.)
PDF_LOCATION = "grc-source-pdfs"     # converted viewer-ready PDFs (dedicated bucket)
DEFAULT_HTML_HEAD = """<html><head><meta charset="utf-8"><style>
body { font-family: Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.4; color: #111; }
h1, h2, h3, h4 { color: #222; margin-top: 1.2em; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
th { background: #eee; }
ul, ol { margin: 0.5em 0 0.5em 1.5em; }
code { font-family: Menlo, Consolas, monospace; background: #f4f4f4; padding: 1px 4px; }
</style></head><body>"""
HTML_TAIL = "</body></html>"

logger = logging.getLogger(__name__)


def _row(doc: Any) -> dict | None:
    if doc is None:
        return None
    data = getattr(doc, "data", None)
    if data is None and isinstance(doc, dict):
        data = doc.get("data", doc)
    if not isinstance(data, dict):
        return None
    out = dict(data)
    out["id"] = getattr(doc, "id", None) or (doc.get("id") if isinstance(doc, dict) else out.get("id"))
    return out


def _is_docx(file_name: str | None, mime_type: str | None) -> bool:
    if mime_type and mime_type.endswith("wordprocessingml.document"):
        return True
    return bool(file_name and file_name.lower().endswith(".docx"))


def _is_pdf(file_name: str | None, mime_type: str | None) -> bool:
    if mime_type == "application/pdf":
        return True
    return bool(file_name and file_name.lower().endswith(".pdf"))


def _docx_to_pdf_bytes(docx_blob: bytes) -> bytes:
    """Convert a DOCX byte blob to a PDF byte blob.

    Strategy: mammoth converts DOCX → HTML, then a tiny BeautifulSoup-based parser
    walks the HTML and emits reportlab Platypus flowables. Uses only reportlab +
    mammoth (no xhtml2pdf), since xhtml2pdf currently fails to install on workers.
    Fidelity is limited (headings, paragraphs, bullet/numbered lists, basic tables,
    bold/italic). Good enough for a viewer pane that just needs to show the source
    text alongside the questions.
    """
    try:
        import mammoth  # type: ignore
    except ModuleNotFoundError as exc:
        raise UserError("DOCX→PDF requires the 'mammoth' workflow dependency.") from exc
    try:
        from bs4 import BeautifulSoup  # type: ignore
    except ModuleNotFoundError as exc:
        raise UserError("DOCX→PDF requires the 'beautifulsoup4' workflow dependency.") from exc
    try:
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.lib import colors
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem, Table, TableStyle, PageBreak
    except ModuleNotFoundError as exc:
        raise UserError("DOCX→PDF requires the 'reportlab' workflow dependency.") from exc

    html_result = mammoth.convert_to_html(io.BytesIO(docx_blob))
    soup = BeautifulSoup(html_result.value or "", "html.parser")

    styles = getSampleStyleSheet()
    body_style = ParagraphStyle("body", parent=styles["BodyText"], fontSize=10, leading=13, spaceAfter=6)
    h_styles = {
        1: ParagraphStyle("h1", parent=styles["Heading1"], fontSize=18, spaceBefore=14, spaceAfter=8),
        2: ParagraphStyle("h2", parent=styles["Heading2"], fontSize=14, spaceBefore=12, spaceAfter=6),
        3: ParagraphStyle("h3", parent=styles["Heading3"], fontSize=12, spaceBefore=10, spaceAfter=4),
    }

    def inline_markup(el) -> str:
        """Convert inline HTML to reportlab's mini-markup (<b>, <i>, <br/>)."""
        if hasattr(el, "name") and el.name is None:
            return str(el).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if not hasattr(el, "name"):
            return str(el).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if el.name in ("b", "strong"):
            return "<b>" + "".join(inline_markup(c) for c in el.children) + "</b>"
        if el.name in ("i", "em"):
            return "<i>" + "".join(inline_markup(c) for c in el.children) + "</i>"
        if el.name == "br":
            return "<br/>"
        return "".join(inline_markup(c) for c in el.children)

    def para_text(el) -> str:
        return "".join(inline_markup(c) for c in el.children) or "&nbsp;"

    flow: list = []
    body = soup.body or soup
    for child in body.children:
        if not hasattr(child, "name"):
            text = str(child).strip()
            if text:
                flow.append(Paragraph(text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), body_style))
            continue
        name = (child.name or "").lower()
        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = min(int(name[1]), 3)
            flow.append(Paragraph(para_text(child), h_styles[level]))
        elif name == "p":
            flow.append(Paragraph(para_text(child), body_style))
        elif name in ("ul", "ol"):
            items = []
            for li in child.find_all("li", recursive=False):
                items.append(ListItem(Paragraph(para_text(li), body_style)))
            flow.append(
                ListFlowable(
                    items,
                    bulletType="bullet" if name == "ul" else "1",
                    leftIndent=18,
                )
            )
            flow.append(Spacer(1, 4))
        elif name == "table":
            rows = []
            for tr in child.find_all("tr", recursive=True):
                cells = [Paragraph(para_text(td), body_style) for td in tr.find_all(["td", "th"], recursive=False)]
                if cells:
                    rows.append(cells)
            if rows:
                t = Table(rows, repeatRows=1)
                t.setStyle(TableStyle([
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]))
                flow.append(t)
                flow.append(Spacer(1, 6))
        else:
            flow.append(Paragraph(para_text(child), body_style))

    if not flow:
        flow.append(Paragraph("(empty document)", body_style))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.75 * inch, rightMargin=0.75 * inch, topMargin=0.75 * inch, bottomMargin=0.75 * inch)
    doc.build(flow)
    return buf.getvalue()


@workflow(
    name="start_grc_source_upload",
    description="Create a Bifrost GRC source-document row and return a signed PUT URL for direct browser upload.",
    category="grc",
)
async def start_grc_source_upload(
    questionnaire_id: str | None,
    file_name: str,
    mime_type: str,
    name: str | None = None,
) -> dict:
    """Create the source-document record + return a signed PUT URL.

    The browser PUTs the file bytes to the URL, then calls finish_grc_source_upload
    to link the source to the questionnaire and (if appropriate) kick off extraction.
    """
    if not file_name:
        raise UserError("file_name is required")
    if not mime_type:
        raise UserError("mime_type is required")

    if not questionnaire_id:
        raise UserError("questionnaire_id is required")
    q = await tables.get("grc-questionnaires", questionnaire_id)
    q_data = getattr(q, "data", None) or (q.get("data") if isinstance(q, dict) else None) or {}
    org_id = require_row_access(q_data, resource="questionnaire")

    safe_name = safe_source_filename(file_name, fallback="upload.bin")
    sd_id = f"grc-source-{uuid.uuid4()}"
    file_path = f"grc-sources/{sd_id}/{safe_name}"

    payload: dict = {
        "name": name or safe_name,
        "file_name": safe_name,
        "file_path": file_path,
        "mime_type": mime_type,
    }
    payload["organization_id"] = org_id
    await tables.insert(TABLE_SOURCE_DOCUMENTS, payload, id=sd_id)
    signed = await files.get_signed_url(
        file_path,
        method="PUT",
        content_type=mime_type,
        location=SOURCE_LOCATION,
        scope=org_id,
    )
    url = signed.get("url") if isinstance(signed, dict) else getattr(signed, "url", None)
    return {"source_document_id": sd_id, "file_path": file_path, "upload_url": url, "mime_type": mime_type}


@workflow(
    name="finish_grc_source_upload",
    description="Link an uploaded source document to a questionnaire and kick off conversion + extraction.",
    category="grc",
)
async def finish_grc_source_upload(source_document_id: str, questionnaire_id: str) -> dict:
    sd = await tables.get(TABLE_SOURCE_DOCUMENTS, source_document_id)
    sd_data = getattr(sd, "data", None) or (sd.get("data") if isinstance(sd, dict) else None) or {}
    source_org_id = require_row_access(sd_data, resource="source document")
    questionnaire = await tables.get("grc-questionnaires", questionnaire_id)
    questionnaire_data = (
        getattr(questionnaire, "data", None)
        or (questionnaire.get("data") if isinstance(questionnaire, dict) else None)
        or {}
    )
    questionnaire_org_id = require_row_access(questionnaire_data, resource="questionnaire")
    if source_org_id != questionnaire_org_id:
        raise UserError("source document organization does not match the questionnaire")

    await tables.update("grc-questionnaires", questionnaire_id, {"source_document_id": source_document_id})

    # Trigger conversion if it's a DOCX (best-effort; failures are logged but don't block).
    file_name = sd_data.get("file_name")
    mime_type = sd_data.get("mime_type")
    converted = False
    if _is_docx(file_name, mime_type) or _is_pdf(file_name, mime_type):
        try:
            await convert_grc_source_to_pdf(source_document_id, force=False)
            converted = True
        except Exception as exc:
            logger.warning("source-doc convert failed for %s: %s", source_document_id, exc)
    return {"source_document_id": source_document_id, "questionnaire_id": questionnaire_id, "converted": converted}


@workflow(
    name="get_grc_source_pdf_url",
    description="Return a signed URL for a Bifrost GRC source document's viewer-ready PDF (auto-converts DOCX if needed).",
    category="grc",
)
async def get_grc_source_pdf_url(source_document_id: str) -> dict:
    doc = await tables.get(TABLE_SOURCE_DOCUMENTS, source_document_id)
    row = _row(doc)
    if not row:
        return {"url": None, "status": "not_found"}
    require_row_access(row, resource="source document")

    pdf_path = row.get("pdf_file_path")
    organization_id = row.get("organization_id")
    if not organization_id:
        raise UserError("source document organization_id is required")
    pdf_location: str | None = None
    pdf_scope: str | None = organization_id
    if not pdf_path:
        file_name = row.get("file_name")
        file_path = row.get("file_path")
        mime_type = row.get("mime_type")
        if _is_pdf(file_name, mime_type) and file_path:
            # Raw PDF passthrough — the file lives wherever it was uploaded (SOURCE_LOCATION).
            pdf_path = file_path
            await tables.update(TABLE_SOURCE_DOCUMENTS, source_document_id, {"pdf_file_path": file_path})
        elif _is_docx(file_name, mime_type) and file_path:
            try:
                docx_bytes = await read_source_file(files, row)
            except Exception as exc:
                return {"url": None, "status": "source_missing", "error": str(exc)}
            pdf_bytes = _docx_to_pdf_bytes(docx_bytes)
            base = safe_source_filename((file_name or source_document_id).rsplit(".", 1)[0], fallback="source")
            pdf_path = f"{source_document_id}/{base}.pdf"
            await files.write_bytes(pdf_path, pdf_bytes, location=PDF_LOCATION, scope=organization_id)
            await tables.update(TABLE_SOURCE_DOCUMENTS, source_document_id, {"pdf_file_path": pdf_path})
            pdf_location = PDF_LOCATION
            pdf_scope = organization_id
        else:
            return {"url": None, "status": "unsupported_type", "file_name": file_name, "mime_type": mime_type}

    # Resolve one authorized location. Legacy migration locations are available
    # only to provider executions through the shared reference helper.
    if pdf_location is None:
        try:
            reference = await resolve_source_pdf_reference(files, {**row, "pdf_file_path": pdf_path})
        except Exception as exc:
            return {"url": None, "status": "source_missing", "error": str(exc), "pdf_file_path": pdf_path}
        pdf_location = reference.location
        pdf_scope = reference.scope

    try:
        signed = await files.get_signed_url(
            pdf_path,
            method="GET",
            location=pdf_location,
            content_type="application/pdf",
            scope=pdf_scope,
        )
    except Exception as exc:
        return {"url": None, "status": "signed_url_failed", "error": str(exc), "pdf_file_path": pdf_path}
    url = signed.get("url") if isinstance(signed, dict) else getattr(signed, "url", None)
    return {
        "url": url,
        "status": "ok",
        "pdf_file_path": pdf_path,
        "pdf_location": pdf_location,
        "pdf_scope": pdf_scope,
    }


@workflow(
    name="convert_grc_source_to_pdf",
    description="Convert a Bifrost GRC source document to PDF if it isn't already; store as pdf_file_path.",
    category="grc",
)
async def convert_grc_source_to_pdf(source_document_id: str, force: bool = False) -> dict:
    doc = await tables.get(TABLE_SOURCE_DOCUMENTS, source_document_id)
    row = _row(doc)
    require_row_access(row, resource="source document")

    file_name = row.get("file_name")
    file_path = row.get("file_path")
    mime_type = row.get("mime_type")
    existing_pdf = row.get("pdf_file_path")
    organization_id = row.get("organization_id")
    if not organization_id:
        raise UserError("source document organization_id is required")

    if existing_pdf and not force:
        return {"status": "already_converted", "pdf_file_path": existing_pdf, "id": source_document_id}

    # PDFs: just reuse file_path.
    if _is_pdf(file_name, mime_type):
        if not file_path:
            raise UserError("source document is a PDF but has no file_path")
        await tables.update(TABLE_SOURCE_DOCUMENTS, source_document_id, {"pdf_file_path": file_path})
        return {"status": "passthrough", "pdf_file_path": file_path, "id": source_document_id}

    if not _is_docx(file_name, mime_type):
        raise UserError(
            f"unsupported source-document type for PDF conversion (file_name={file_name!r}, mime_type={mime_type!r})"
        )

    if not file_path:
        raise UserError("DOCX source document has no file_path; nothing to convert")

    docx_bytes = await read_source_file(files, row)
    pdf_bytes = _docx_to_pdf_bytes(docx_bytes)

    base_name = safe_source_filename((file_name or source_document_id).rsplit(".", 1)[0], fallback="source")
    pdf_key = f"{source_document_id}/{base_name}.pdf"
    await files.write_bytes(pdf_key, pdf_bytes, location=PDF_LOCATION, scope=organization_id)

    await tables.update(
        TABLE_SOURCE_DOCUMENTS,
        source_document_id,
        {"pdf_file_path": pdf_key, "mime_type": row.get("mime_type") or "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    )

    return {
        "status": "converted",
        "id": source_document_id,
        "pdf_file_path": pdf_key,
        "pdf_size_bytes": len(pdf_bytes),
        "html_messages": [str(m) for m in (getattr(_docx_to_pdf_bytes, "_last_messages", []) or [])][:10],
    }
