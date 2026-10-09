"""Questionnaire workflows for Bifrost GRC."""
import hashlib
import io
import json
import logging
import re
import zipfile
from datetime import datetime, timezone
from html import unescape
from xml.etree import ElementTree

from bifrost import UserError, agents, config, files, integrations, tables, workflow

from functions.grc_attribution import authenticated_actor_id
from functions.grc_auth import bind_organization_scope, caller_organization_id, require_provider, require_row_access
from workflows.grc_v2.grc_source_files import read_source_file

logger = logging.getLogger(__name__)

TABLE_SOURCE_DOCUMENTS = "grc-source-documents"
TABLE_QUESTIONNAIRES = "grc-questionnaires"
TABLE_QUESTIONNAIRE_SECTIONS = "grc-questionnaire-sections"
TABLE_QUESTIONNAIRE_ITEMS = "grc-questionnaire-items"
TABLE_QUESTIONNAIRE_RUNS = "grc-questionnaire-runs"
TABLE_QUESTIONNAIRE_RESPONSES = "grc-questionnaire-responses"
TABLE_QUESTIONNAIRE_CONTROL_LINKS = "grc-questionnaire-control-links"
TABLE_QUESTIONNAIRE_PROPOSALS = "grc-questionnaire-proposals"
TABLE_APPLIED_CONTROLS = "grc-applied-controls"
TABLE_CONTROL_MAPPINGS = "grc-control-mappings"
TABLE_CONTROLS = "grc-controls"
TABLE_EVIDENCE = "grc-evidence"
TABLE_EVIDENCE_LINKS = "grc-evidence-links"
TABLE_POLICIES = "grc-policies"
TABLE_POLICY_LINKS = "grc-policy-links"
TABLE_EXCEPTIONS = "grc-exceptions"
TABLE_RISKS = "grc-risks"

SINGLE_CUSTOMER_TABLES = {
    TABLE_SOURCE_DOCUMENTS,
    TABLE_QUESTIONNAIRES,
    TABLE_QUESTIONNAIRE_SECTIONS,
    TABLE_QUESTIONNAIRE_ITEMS,
    TABLE_QUESTIONNAIRE_RUNS,
    TABLE_QUESTIONNAIRE_RESPONSES,
    TABLE_QUESTIONNAIRE_CONTROL_LINKS,
    TABLE_QUESTIONNAIRE_PROPOSALS,
}

PROVIDER_SCOPED_TABLES = {
    TABLE_APPLIED_CONTROLS,
    TABLE_CONTROL_MAPPINGS,
    TABLE_EVIDENCE,
    TABLE_EVIDENCE_LINKS,
    TABLE_POLICIES,
    TABLE_POLICY_LINKS,
    TABLE_EXCEPTIONS,
    TABLE_RISKS,
}

ANSWER_TYPES = {"yes_no", "text", "multi_select", "numeric", "date", "file", "unknown"}
ITEM_STATUSES = {"extracted", "answering", "answered", "needs_review", "accepted", "rejected"}
AUDIENCES = {"msp", "customer"}

# Shared audience-classification rule, used by both the inline extraction prompt and the
# standalone classifier so they can't drift. The test is "who can actually answer it",
# NOT "does it sound technical" — many technical-sounding questions are business/legal/
# governance facts the customer owns.
AUDIENCE_RULE = """Classify who can actually answer each question:
- "msp": the answer can be VERIFIED from the IT/security systems and GRC data the MSP manages, without needing the customer's business knowledge. Examples: MFA enforcement, EDR/antivirus deployed, patching cadence, backups, encryption on managed devices, logging/monitoring, role-based access the MSP configures, security-awareness training the MSP delivers.
- "customer": the answer requires the customer's own business, legal, financial, or governance knowledge — EVEN IF it sounds technical. Examples: whether they are subject to or compliant with a regulation (PCI-DSS, HIPAA, GDPR); business volumes and counts (number of transactions, records, individuals, employees, revenue, PCI merchant/reporting level); governance roles (e.g. a Chief Privacy Officer); legal artifacts (e.g. an attorney-reviewed privacy policy); what categories of data they collect; data retention/destruction decisions; prior claims, incidents, or litigation; ownership and contracts.
A question is "msp" ONLY when the MSP can answer it from systems it manages. When in doubt, use "customer"."""

SYSTEM_PROMPT = (
    """You extract cybersecurity insurance and GRC questionnaire questions.
Return only JSON. Do not answer the questions.
Preserve question wording. Group questions into useful document sections.
Prefer compact section titles from the source document. Include page numbers if the source text shows them.
For each question, also classify the audience.
"""
    + AUDIENCE_RULE
    + "\n"
)

USER_SCHEMA = """Return this exact JSON shape:
{
  "sections": [
    {
      "title": "Section title",
      "source_page": 1,
      "questions": [
        {
          "question_text": "Full question text",
          "normalized_topic": "Short topic",
          "answer_type": "yes_no|text|multi_select|numeric|date|file|unknown",
          "audience": "msp|customer",
          "source_page": 1,
          "source_excerpt": "Brief source excerpt",
          "extraction_confidence": 0.0
        }
      ]
    }
  ]
}
"""

ANSWER_SYSTEM_PROMPT = """You draft cybersecurity insurance questionnaire answers from Bifrost GRC evidence.
Return only JSON. Be factual and terse. Do not claim a control exists unless the provided context supports it.
If the answer is uncertain, say what needs confirmation instead of guessing.
Use answer_type when deciding format: yes_no answers should begin with Yes, No, or Needs confirmation.
"""

ANSWER_SCHEMA = """Return this exact JSON shape:
{
  "answers": [
    {
      "item_id": "questionnaire item id",
      "draft_answer": "Answer text",
      "confidence": 0.0,
      "needs_review": true,
      "citations": [
        {
          "target_type": "applied_control|evidence|policy|control|source_document",
          "target_id": "id",
          "label": "Short citation label",
          "excerpt": "Relevant detail"
        }
      ],
      "links": [
        {
          "target_type": "applied_control|evidence|policy|control",
          "target_id": "id",
          "relationship": "answers|supports|maps_to",
          "confidence": 0.0,
          "rationale": "Why this target supports the answer"
        }
      ]
    }
  ]
}
"""


def _doc_to_row(doc) -> dict | None:
    if doc is None:
        return None
    if isinstance(doc, dict):
        row = dict(doc)
        data = row.get("data")
        if isinstance(data, dict):
            merged = dict(data)
            merged["id"] = row.get("id", merged.get("id"))
            merged["created_at"] = row.get("created_at", merged.get("created_at"))
            merged["updated_at"] = row.get("updated_at", merged.get("updated_at"))
            return merged
        return row
    data = dict(getattr(doc, "data", None) or {})
    data["id"] = getattr(doc, "id", data.get("id"))
    data["created_at"] = getattr(doc, "created_at", data.get("created_at"))
    data["updated_at"] = getattr(doc, "updated_at", data.get("updated_at"))
    return data


def _documents(result) -> list:
    if result is None:
        return []
    docs = getattr(result, "documents", None)
    if docs is not None:
        return list(docs or [])
    if isinstance(result, list):
        return result
    return []


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value, default):
    if value in (None, ""):
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return default


def _clean_text(text: str) -> str:
    text = unescape(text or "")
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_docx_text(blob: bytes) -> tuple[str, dict]:
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            xml = zf.read("word/document.xml")
    except Exception as exc:
        raise UserError(f"Unable to read DOCX document: {exc}") from exc

    root = ElementTree.fromstring(xml)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs: list[str] = []
    for paragraph in root.findall(".//w:p", ns):
        parts: list[str] = []
        for node in paragraph.iter():
            tag = node.tag.rsplit("}", 1)[-1]
            if tag == "t" and node.text:
                parts.append(node.text)
            elif tag in {"tab"}:
                parts.append("\t")
            elif tag in {"br", "cr"}:
                parts.append("\n")
        line = "".join(parts).strip()
        if line:
            paragraphs.append(line)
    text = _clean_text("\n".join(paragraphs))
    return text, {"parser": "docx-xml", "paragraphs": len(paragraphs)}


def _build_fixture_docx(lines: list[str]) -> bytes:
    def esc(value: str) -> str:
        return (
            str(value or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )

    paragraphs = "".join(
        f"<w:p><w:r><w:t>{esc(line)}</w:t></w:r></w:p>"
        for line in lines
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{paragraphs}</w:body>"
        "</w:document>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


def _extract_pdf_text(blob: bytes) -> tuple[str, dict]:
    try:
        from pypdf import PdfReader
    except ModuleNotFoundError as exc:
        raise UserError("PDF extraction requires the pypdf workflow dependency.") from exc

    try:
        reader = PdfReader(io.BytesIO(blob))
    except Exception as exc:
        raise UserError(f"Unable to read PDF document: {exc}") from exc

    pages: list[str] = []
    for idx, page in enumerate(reader.pages, start=1):
        try:
            page_text = page.extract_text() or ""
        except Exception as exc:
            logger.warning("PDF page extraction failed page=%s error=%s", idx, exc)
            page_text = ""
        if page_text.strip():
            pages.append(f"\n\n[Page {idx}]\n{page_text}")
    text = _clean_text("\n".join(pages))
    # Interactive AcroForm field values (filled-in answers) do NOT appear in the text layer.
    # Surface them so a prefill extraction can match a filled-in answer to its question.
    field_lines = _pdf_form_field_lines(reader)
    if field_lines:
        text = f"{text}\n\n[Interactive form field values]\n" + "\n".join(field_lines)
    return text, {"parser": "pypdf", "page_count": len(reader.pages), "form_fields": len(field_lines)}


def _pdf_form_field_lines(reader) -> list[str]:
    """Read filled AcroForm field values (text + checkbox on-states) as 'name: value' lines.

    Off / empty checkboxes and blank text fields are dropped so only answered fields surface.
    """
    try:
        fields = reader.get_fields()
    except Exception as exc:  # noqa: BLE001 - many PDFs have no AcroForm; tolerate.
        logger.debug("PDF has no readable AcroForm fields: %s", exc)
        return []
    if not fields:
        return []
    lines: list[str] = []
    for name, field in fields.items():
        try:
            value = getattr(field, "value", None)
            if value is None and isinstance(field, dict):
                value = field.get("/V")
        except Exception:  # noqa: BLE001
            value = None
        if value in (None, ""):
            continue
        rendered = str(value).strip()
        if not rendered or rendered in ("/Off", "Off"):
            continue
        lines.append(f"- {str(name).strip()}: {rendered.lstrip('/')}")
        if len(lines) >= 400:
            break
    return lines


def _extract_text(blob: bytes, file_name: str | None, mime_type: str | None) -> tuple[str, dict]:
    name = (file_name or "").lower()
    mime = (mime_type or "").lower()
    if name.endswith(".pdf") or mime == "application/pdf":
        return _extract_pdf_text(blob)
    if name.endswith(".docx") or "openxmlformats-officedocument.wordprocessingml.document" in mime:
        return _extract_docx_text(blob)
    if name.endswith(".doc"):
        raise UserError("Legacy .doc files are not supported yet. Convert the document to .docx or PDF.")
    try:
        return _clean_text(blob.decode("utf-8")), {"parser": "utf-8"}
    except UnicodeDecodeError:
        raise UserError("Unsupported questionnaire file type. Upload PDF, DOCX, or UTF-8 text.")


def _salvage_truncated_json(text: str) -> dict | None:
    """Best-effort recovery when the model's JSON is cut off mid-structure.

    Walks the string tracking bracket/quote depth, drops any trailing partial
    token, and closes open structures. Lets us keep the questions that DID make
    it through when the response hit the token ceiling.
    """
    depth_stack: list[str] = []
    in_string = False
    escape = False
    last_safe = -1  # index just after the last fully-closed top-level value
    for i, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            depth_stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if depth_stack:
                depth_stack.pop()
            # A complete top-level object closed
            if not depth_stack:
                last_safe = i + 1
        elif ch == "," and len(depth_stack) <= 2:
            last_safe = i  # safe to cut at an element boundary inside arrays
    # Cut off any dangling partial element, then close open brackets.
    candidate = text[:last_safe] if last_safe > 0 else text
    # Re-derive open brackets for the candidate
    stack: list[str] = []
    in_str = False
    esc = False
    for ch in candidate:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()
    repaired = candidate.rstrip().rstrip(",")
    while stack:
        repaired += stack.pop()
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        return None


def _extract_json_object(raw: str) -> dict:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
        salvaged = _salvage_truncated_json(text)
        if salvaged is not None:
            logger.warning("extraction JSON was truncated; salvaged %d top-level keys", len(salvaged))
            return salvaged
        raise


def _normalize_extraction(payload: dict) -> list[dict]:
    sections = payload.get("sections")
    if not isinstance(sections, list):
        questions = payload.get("questions")
        sections = [{"title": "Questionnaire", "questions": questions if isinstance(questions, list) else []}]

    normalized: list[dict] = []
    for section_index, section in enumerate(sections, start=1):
        if not isinstance(section, dict):
            continue
        title = str(section.get("title") or f"Section {section_index}").strip()[:240]
        questions = section.get("questions") or section.get("items") or []
        if not isinstance(questions, list):
            continue
        clean_questions: list[dict] = []
        for question in questions:
            if isinstance(question, str):
                question = {"question_text": question}
            if not isinstance(question, dict):
                continue
            question_text = str(question.get("question_text") or question.get("question") or "").strip()
            if not question_text:
                continue
            answer_type = str(question.get("answer_type") or "unknown").strip().lower()
            if answer_type not in ANSWER_TYPES:
                answer_type = "unknown"
            audience = str(question.get("audience") or "customer").strip().lower()
            if audience not in AUDIENCES:
                audience = "customer"
            try:
                confidence = float(question.get("extraction_confidence", 0.75))
            except (TypeError, ValueError):
                confidence = 0.75
            source_answer_raw = question.get("source_answer")
            source_answer = str(source_answer_raw).strip()[:2000] if source_answer_raw not in (None, "") else None
            clean_questions.append(
                {
                    "question_text": question_text,
                    "normalized_topic": str(question.get("normalized_topic") or "").strip()[:240] or None,
                    "answer_type": answer_type,
                    "audience": audience,
                    "source_page": question.get("source_page") or section.get("source_page"),
                    "source_anchor": question.get("source_anchor"),
                    "source_excerpt": str(question.get("source_excerpt") or question_text[:500]).strip()[:1000],
                    "extraction_confidence": max(0.0, min(1.0, confidence)),
                    "source_answer": source_answer,
                    "metadata": {
                        k: v
                        for k, v in question.items()
                        if k
                        not in {
                            "question",
                            "question_text",
                            "normalized_topic",
                            "answer_type",
                            "audience",
                            "source_page",
                            "source_anchor",
                            "source_excerpt",
                            "extraction_confidence",
                            "source_answer",
                        }
                    },
                }
            )
        if clean_questions:
            normalized.append(
                {
                    "title": title,
                    "source_page": section.get("source_page"),
                    "source_anchor": section.get("source_anchor"),
                    "questions": clean_questions,
                }
            )
    return normalized


def _row_label(row: dict, *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value:
            return str(value)
    return str(row.get("id") or "")


def _truncate(value: str | None, length: int = 650) -> str | None:
    if not value:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text[:length]


def _stable_id(prefix: str, *parts: str | None) -> str:
    raw = "-".join(str(part or "") for part in parts)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-")
    return f"{prefix}-{safe}"[:180]


def _content_hash(*parts) -> str:
    return hashlib.sha256(_json_dumps(parts).encode("utf-8")).hexdigest()[:24]


def _scope_payload(org_id: str | None) -> dict:
    return {
        "organization_id": org_id,
        "applied_organizations": [org_id] if org_id else None,
        "excluded_organizations": [],
    }


def _shared_scope_payload(customer_org_id: str | None, provider_org_id: str | None = None) -> dict:
    require_provider("Provider access is required for reusable GRC records.")
    if not (provider_org_id or caller_organization_id()):
        raise UserError("The provider organization could not be resolved.")
    return {
        # Shared rows are owned by their audience so tenant row policies can
        # expose global records (NULL) and one-customer records (customer id).
        "organization_id": customer_org_id,
        "applied_organizations": [customer_org_id] if customer_org_id else None,
        "excluded_organizations": [],
    }


def _scope_org_ids(row: dict) -> list[str] | None:
    if "applied_organizations" in row:
        applied = row.get("applied_organizations")
        if applied is None:
            return None
        if isinstance(applied, list):
            return [str(value) for value in applied if value]
    if row.get("organization_id"):
        return [str(row["organization_id"])]
    return None


def _applies_to_org(row: dict, org_id: str | None) -> bool:
    if not org_id:
        return True
    applied = _scope_org_ids(row)
    if applied is None:
        excluded = row.get("excluded_organizations")
        return org_id not in (excluded if isinstance(excluded, list) else [])
    return org_id in applied


def _scope_patch_for_org(row: dict, org_id: str | None) -> dict | None:
    if not org_id or _applies_to_org(row, org_id):
        return None
    applied = _scope_org_ids(row)
    if applied is None:
        return None
    return {
        "applied_organizations": sorted(set(applied + [org_id])),
        "excluded_organizations": row.get("excluded_organizations") if isinstance(row.get("excluded_organizations"), list) else [],
    }


def _proposal_status_from_link(status: str | None) -> str:
    if status in {"accepted", "rejected", "applied"}:
        return status
    return "proposed"


def _proposal_target_for_capture(kind: str | None, what: str | None) -> str:
    text = f"{kind or ''} {what or ''}".lower()
    if "policy" in text:
        return "policy"
    if "risk" in text:
        return "risk"
    if "control" in text:
        return "applied_control"
    return "evidence"


def _target_table(target_type: str | None) -> str | None:
    return {
        "applied_control": TABLE_APPLIED_CONTROLS,
        "evidence": TABLE_EVIDENCE,
        "policy": TABLE_POLICIES,
        "risk": TABLE_RISKS,
    }.get(target_type or "")


def _relationship_payloads_for_target(
    org_id: str | None,
    questionnaire_id: str,
    item_id: str | None,
    response_id: str | None,
    target_type: str,
    target_id,
    relationship: str | None = None,
    rationale: str | None = None,
    confidence=None,
) -> list[dict]:
    if target_type == "evidence":
        evidence_id = target_id or "{{target_id}}"
        return [
            {
                "table": TABLE_EVIDENCE_LINKS,
                "id": _stable_id("qevlink", response_id or item_id, "questionnaire_response", str(target_id or "new")),
                "payload": {
                    **_shared_scope_payload(org_id),
                    "evidence_id": evidence_id,
                    "target_type": "questionnaire_response" if response_id else "questionnaire_item",
                    "target_id": response_id or item_id,
                    "relationship": relationship or "supports",
                    "citation": _truncate(rationale, 900),
                    "source_system": "grc_questionnaire",
                    "source_id": response_id or item_id,
                    "metadata_json": _json_dumps({"questionnaire_id": questionnaire_id, "item_id": item_id, "confidence": confidence}),
                },
            }
        ]
    if target_type == "policy":
        policy_id = target_id or "{{target_id}}"
        return [
            {
                "table": TABLE_POLICY_LINKS,
                "id": _stable_id("qpolink", response_id or item_id, "questionnaire_response", str(target_id or "new")),
                "payload": {
                    **_shared_scope_payload(org_id),
                    "policy_id": policy_id,
                    "target_type": "questionnaire_response" if response_id else "questionnaire_item",
                    "target_id": response_id or item_id,
                    "relationship": relationship or "supports",
                    "source_system": "grc_questionnaire",
                    "source_id": response_id or item_id,
                    "metadata_json": _json_dumps({"questionnaire_id": questionnaire_id, "item_id": item_id, "confidence": confidence}),
                },
            }
        ]
    return []


async def _upsert_link_proposal(
    questionnaire_id: str,
    org_id: str | None,
    item_id: str | None,
    response_id: str | None,
    link: dict,
    persist: bool = True,
) -> dict | None:
    target_type = str(link.get("target_type") or "")
    target_id = str(link.get("target_id") or "")
    if not target_type or not target_id or not link.get("id"):
        return None
    proposal_id = _stable_id("qprop", questionnaire_id, item_id, response_id, "link", link.get("id"))
    confidence = link.get("confidence")
    try:
        confidence_value = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        confidence_value = None
    payload = {
        **_scope_payload(org_id),
        "questionnaire_id": questionnaire_id,
        "item_id": item_id,
        "response_id": response_id,
        "action": "use_existing",
        "target_type": "link",
        "target_id": link.get("id"),
        "draft_payload_json": _json_dumps(
            {
                "target_type": target_type,
                "target_id": target_id,
                "relationship": link.get("relationship") or "supports",
                "questionnaire_link_id": link.get("id"),
            }
        ),
        "relationship_payloads_json": _json_dumps(
            _relationship_payloads_for_target(
                org_id,
                questionnaire_id,
                item_id,
                response_id,
                target_type,
                target_id,
                link.get("relationship"),
                link.get("rationale"),
                confidence_value,
            )
        ),
        "status": _proposal_status_from_link(link.get("status")),
        "confidence": confidence_value,
        "needs_review": bool(confidence_value is None or confidence_value < 0.75),
        "rationale": _truncate(link.get("rationale"), 900),
        "content_hash": _content_hash(questionnaire_id, item_id, response_id, target_type, target_id, link.get("relationship")),
        "metadata_json": _json_dumps({"source": "questionnaire_link", "questionnaire_link_id": link.get("id")}),
    }
    if not persist:
        return {"id": proposal_id, **payload}
    return await _upsert_row(TABLE_QUESTIONNAIRE_PROPOSALS, proposal_id, payload)


async def _upsert_create_proposal(
    questionnaire_id: str,
    org_id: str | None,
    item: dict,
    response_id: str | None,
    capture: dict,
    confidence=None,
) -> dict:
    target_type = _proposal_target_for_capture(capture.get("kind"), capture.get("what"))
    title = _truncate(capture.get("what") or capture.get("capture_proposal") or item.get("normalized_topic") or item.get("question_text"), 180)
    content_hash = _content_hash(questionnaire_id, item.get("id"), response_id, target_type, title, capture.get("capture_proposal"))
    proposal_id = _stable_id("qprop", questionnaire_id, item.get("id"), "create", content_hash)
    provenance = {
        "source_system": "grc_questionnaire",
        "questionnaire_id": questionnaire_id,
        "item_id": item.get("id"),
        "response_id": response_id,
        "capture_kind": capture.get("kind"),
    }
    if target_type == "evidence":
        draft_payload = {
            **_shared_scope_payload(org_id),
            "name": title,
            "notes_markdown": capture.get("capture_proposal") or capture.get("what") or "",
            "urls_json": _json_dumps([]),
            "attachments_json": _json_dumps([]),
            "provenance_json": _json_dumps(provenance),
            "review_status": "needs_review",
            "source_system": "grc_questionnaire",
            "source_id": response_id or item.get("id"),
            "metadata_json": _json_dumps({"questionnaire_id": questionnaire_id, "item_id": item.get("id")}),
        }
    elif target_type == "policy":
        draft_payload = {
            **_shared_scope_payload(org_id),
            "name": title,
            "description": capture.get("capture_proposal") or capture.get("what"),
            "status": "draft",
            "review_status": "needs_review",
            "source_system": "grc_questionnaire",
            "source_id": response_id or item.get("id"),
            "metadata_json": _json_dumps(provenance),
        }
    elif target_type == "risk":
        draft_payload = {
            **_shared_scope_payload(org_id),
            "name": title,
            "description": capture.get("capture_proposal") or capture.get("what"),
            "level": "medium",
            "status": "open",
            "review_status": "needs_review",
            "source_system": "grc_questionnaire",
            "source_id": response_id or item.get("id"),
            "metadata_json": _json_dumps(provenance),
        }
    else:
        draft_payload = {
            **_shared_scope_payload(org_id),
            "name": title,
            "description": capture.get("capture_proposal") or capture.get("what"),
            "control_type": "questionnaire",
            "status": "unknown",
            "review_status": "needs_review",
            "source_system": "grc_questionnaire",
            "source_id": response_id or item.get("id"),
            "tags_json": _json_dumps(["questionnaire"]),
            "metadata_json": _json_dumps(provenance),
        }
    payload = {
        **_scope_payload(org_id),
        "questionnaire_id": questionnaire_id,
        "item_id": item.get("id"),
        "response_id": response_id,
        "action": "create",
        "target_type": target_type,
        "target_id": None,
        "draft_payload_json": _json_dumps(draft_payload),
        "relationship_payloads_json": _json_dumps(
            _relationship_payloads_for_target(
                org_id,
                questionnaire_id,
                item.get("id"),
                response_id,
                target_type,
                None,
                "supports",
                capture.get("capture_proposal") or capture.get("what"),
                confidence,
            )
        ),
        "status": "proposed",
        "confidence": confidence,
        "needs_review": True,
        "rationale": _truncate(capture.get("capture_proposal") or capture.get("what"), 900),
        "content_hash": content_hash,
        "metadata_json": _json_dumps({"source": "found_but_unrecorded", **provenance}),
    }
    return await _upsert_row(TABLE_QUESTIONNAIRE_PROPOSALS, proposal_id, payload)


def _replace_placeholder(value, target_id: str):
    if isinstance(value, str):
        return value.replace("{{target_id}}", target_id)
    if isinstance(value, list):
        return [_replace_placeholder(item, target_id) for item in value]
    if isinstance(value, dict):
        return {key: _replace_placeholder(item, target_id) for key, item in value.items()}
    return value


async def _apply_relationship_payloads(
    payloads,
    target_id: str | None,
    customer_org_id: str,
    provider_org_id: str,
) -> int:
    if not isinstance(payloads, list):
        return 0
    count = 0
    for rel in payloads:
        if not isinstance(rel, dict) or not rel.get("table") or not rel.get("id"):
            continue
        if rel["table"] not in {TABLE_EVIDENCE_LINKS, TABLE_POLICY_LINKS}:
            raise UserError("Unsupported questionnaire relationship table")
        row_id = str(rel["id"])
        payload = rel.get("payload") if isinstance(rel.get("payload"), dict) else {}
        supplied_org = payload.get("organization_id")
        if supplied_org not in (None, provider_org_id, customer_org_id):
            raise UserError("Questionnaire relationship customer-owner mismatch")
        payload = {**_shared_scope_payload(customer_org_id, provider_org_id), **payload, "organization_id": customer_org_id}
        if target_id:
            row_id = row_id.replace("{{target_id}}", target_id)
            payload = _replace_placeholder(payload, target_id)
        await _upsert_row(rel["table"], row_id, payload)
        count += 1
    return count


def _query_limit(value: int) -> int:
    return max(1, min(int(value or 1000), 1000))


async def _delete_existing_questionnaire_children(questionnaire_id: str) -> dict:
    deleted = {"proposals": 0, "control_links": 0, "responses": 0, "items": 0, "sections": 0}
    for table, key in [
        (TABLE_QUESTIONNAIRE_PROPOSALS, "proposals"),
        (TABLE_QUESTIONNAIRE_CONTROL_LINKS, "control_links"),
        (TABLE_QUESTIONNAIRE_RESPONSES, "responses"),
        (TABLE_QUESTIONNAIRE_ITEMS, "items"),
        (TABLE_QUESTIONNAIRE_SECTIONS, "sections"),
    ]:
        rows = await _query_rows(table, where={"questionnaire_id": questionnaire_id}, limit=1000)
        ids = [row.get("id") for row in rows]
        ids = [row_id for row_id in ids if row_id]
        if ids:
            await tables.delete_batch(table, ids)
            deleted[key] = len(ids)
    return deleted


async def _query_rows(table: str, where: dict | None = None, limit: int = 1000) -> list[dict]:
    filters = dict(where or {})
    if table in SINGLE_CUSTOMER_TABLES:
        organization_id = caller_organization_id()
        if not organization_id:
            raise UserError(f"Tenant scope is required to query {table}")
        requested = filters.get("organization_id")
        if requested is not None and str(requested) != organization_id:
            raise UserError(f"Cross-tenant query denied for {table}")
        filters["organization_id"] = organization_id
    result = await tables.query(table, where=filters, limit=limit)
    return [row for row in (_doc_to_row(doc) for doc in _documents(result)) if row]


async def _upsert_row(table: str, row_id: str, payload: dict) -> dict:
    return _doc_to_row(await tables.upsert(table, row_id, payload)) or {"id": row_id, **payload}


async def _delete_suggested_answer_links(questionnaire_id: str, item_ids: set[str]) -> int:
    if not item_ids:
        return 0
    rows = await _query_rows(TABLE_QUESTIONNAIRE_CONTROL_LINKS, where={"questionnaire_id": questionnaire_id}, limit=1000)
    ids = [
        row["id"]
        for row in rows
        if row.get("id") and row.get("item_id") in item_ids and (row.get("status") in (None, "suggested"))
    ]
    if ids:
        await tables.delete_batch(TABLE_QUESTIONNAIRE_CONTROL_LINKS, ids)
    return len(ids)


async def _resolve_openrouter() -> tuple[str, str]:
    integ = await integrations.get("OpenRouter", scope="global") or await integrations.get("OpenRouter")
    if not integ or not integ.config:
        raise UserError("OpenRouter integration not configured")
    api_key = integ.config.get("api_key")
    if not api_key:
        raise UserError("OpenRouter integration is missing api_key")
    model = await config.get("GRC_QUESTIONNAIRE_MODEL") or integ.config.get("default_model")
    if not model:
        raise UserError("OpenRouter integration is missing default_model")
    return api_key, model


PREFILL_INSTRUCTION = (
    "This document may already contain answers (a returned or prior-year questionnaire, or a filled "
    "PDF form). Form field values appear under '[Interactive form field values]'. For any question "
    "whose answer is present in the document, add a \"source_answer\" string with that exact answer "
    "(e.g. 'Yes', a number, free text). OMIT source_answer for questions that are blank/unanswered — "
    "never invent an answer."
)


async def _run_extraction_ai(
    text: str, questionnaire: dict, model: str | None, max_chars: int, prefill: bool = False
) -> tuple[dict, str]:
    try:
        from openrouter import OpenRouter
    except ModuleNotFoundError as exc:
        raise UserError("Questionnaire extraction requires the openrouter workflow dependency.") from exc

    api_key, configured_model = await _resolve_openrouter()
    selected_model = model or configured_model
    source = text[:max_chars]
    prefill_block = f"\n\n{PREFILL_INSTRUCTION}\n" if prefill else ""
    user_prompt = (
        f"Questionnaire name: {questionnaire.get('name')}\n"
        f"Carrier: {questionnaire.get('carrier') or 'Unknown'}\n\n"
        f"{USER_SCHEMA}{prefill_block}\n\n"
        f"Source document text:\n{source}"
    )
    async with OpenRouter(api_key=api_key) as client:
        response = await client.chat.send_async(
            model=selected_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=48000,
        )
    raw = response.choices[0].message.content
    return _extract_json_object(raw), selected_model


def _normalize_answers(payload: dict, item_ids: set[str]) -> list[dict]:
    answers = payload.get("answers")
    if not isinstance(answers, list):
        return []
    out: list[dict] = []
    for answer in answers:
        if not isinstance(answer, dict):
            continue
        item_id = str(answer.get("item_id") or "")
        if item_id not in item_ids:
            continue
        draft_answer = str(answer.get("draft_answer") or answer.get("answer") or "").strip()
        if not draft_answer:
            continue
        try:
            confidence = float(answer.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        citations = answer.get("citations") if isinstance(answer.get("citations"), list) else []
        links = answer.get("links") if isinstance(answer.get("links"), list) else []
        out.append(
            {
                "item_id": item_id,
                "draft_answer": draft_answer,
                "confidence": max(0.0, min(1.0, confidence)),
                "needs_review": bool(answer.get("needs_review", True)),
                "citations": citations,
                "links": links,
            }
        )
    return out


async def _query_effective_shared(table: str, org_id: str | None, limit: int, provider_org_id: str) -> list[dict]:
    """Return global, customer-owned, or legacy scoped rows that apply to the customer."""
    if not org_id:
        return []
    rows = await _query_rows(
        table,
        where={},
        limit=limit,
    )
    return [row for row in rows if _applies_to_org(row, org_id)]


async def _build_answer_context(
    questionnaire: dict,
    max_context_rows: int,
    provider_org_id: str | None = None,
) -> dict:
    org_id = questionnaire.get("organization_id")
    require_provider("Provider access is required to build shared GRC answer context.")
    owner_id = provider_org_id or caller_organization_id()
    if not owner_id:
        raise UserError("The provider organization could not be resolved.")
    applied = await _query_effective_shared(TABLE_APPLIED_CONTROLS, org_id, max_context_rows, owner_id)
    policies = await _query_effective_shared(TABLE_POLICIES, org_id, max_context_rows, owner_id)
    mappings = await _query_effective_shared(TABLE_CONTROL_MAPPINGS, org_id, _query_limit(max_context_rows * 2), owner_id)
    evidence = await _query_effective_shared(TABLE_EVIDENCE, org_id, max_context_rows, owner_id)
    evidence_links = await _query_effective_shared(TABLE_EVIDENCE_LINKS, org_id, _query_limit(max_context_rows * 2), owner_id)
    policy_links = await _query_effective_shared(TABLE_POLICY_LINKS, org_id, _query_limit(max_context_rows * 2), owner_id)
    exceptions = await _query_effective_shared(TABLE_EXCEPTIONS, org_id, _query_limit(max_context_rows), owner_id)

    control_ids = {row.get("control_id") for row in mappings if row.get("control_id")}
    controls: list[dict] = []
    for control_id in list(control_ids)[:max_context_rows]:
        control = _doc_to_row(await tables.get(TABLE_CONTROLS, control_id))
        if control:
            controls.append(control)

    applied_by_id = {row.get("id"): row for row in applied}
    control_by_id = {row.get("id"): row for row in controls}
    evidence_by_id = {row.get("id"): row for row in evidence}
    policy_by_id = {row.get("id"): row for row in policies}

    return {
        "applied_controls": [
            {
                "id": row.get("id"),
                "name": row.get("name"),
                "type": row.get("control_type"),
                "status": row.get("status"),
                "maturity": row.get("maturity"),
                "description": _truncate(row.get("description")),
                "owner": row.get("owner"),
            }
            for row in applied
        ],
        "control_mappings": [
            {
                "id": row.get("id"),
                "applied_control_id": row.get("applied_control_id"),
                "applied_control": _row_label(applied_by_id.get(row.get("applied_control_id"), {}), "name"),
                "control_id": row.get("control_id"),
                "control": _row_label(control_by_id.get(row.get("control_id"), {}), "control_id", "title"),
                "relationship": row.get("relationship"),
                "confidence": row.get("confidence"),
                "rationale": _truncate(row.get("rationale"), 300),
            }
            for row in mappings
        ],
        "reference_controls": [
            {
                "id": row.get("id"),
                "control_id": row.get("control_id"),
                "title": row.get("title"),
                "description": _truncate(row.get("description")),
                "guidance": _truncate(row.get("guidance"), 450),
            }
            for row in controls
        ],
        "evidence": [
            {
                "id": row.get("id"),
                "name": row.get("name"),
                "notes": _truncate(row.get("notes_markdown") or row.get("notes")),
                "urls": _json_loads(row.get("urls_json"), []) or ([row.get("url")] if row.get("url") else []),
                "attachments": _json_loads(row.get("attachments_json"), []) or ([row.get("file_path")] if row.get("file_path") else []),
                "review_status": row.get("review_status"),
            }
            for row in evidence
        ],
        "evidence_links": [
            {
                "evidence_id": row.get("evidence_id"),
                "evidence": _row_label(evidence_by_id.get(row.get("evidence_id"), {}), "name"),
                "target_type": row.get("target_type"),
                "target_id": row.get("target_id"),
                "relationship": row.get("relationship"),
                "citation": _truncate(row.get("citation"), 300),
            }
            for row in evidence_links
        ],
        "policies": [
            {
                "id": row.get("id"),
                "name": row.get("name"),
                "status": row.get("status"),
                "description": _truncate(row.get("description")),
                "content_excerpt": _truncate(row.get("content"), 900),
                "review_date": row.get("review_date"),
            }
            for row in policies
        ],
        "policy_links": [
            {
                "policy_id": row.get("policy_id"),
                "policy": _row_label(policy_by_id.get(row.get("policy_id"), {}), "name"),
                "target_type": row.get("target_type"),
                "target_id": row.get("target_id"),
                "relationship": row.get("relationship"),
            }
            for row in policy_links
        ],
        "exceptions": [
            {
                "control_id": row.get("control_id"),
                "status": row.get("status"),
                "reason": _truncate(row.get("reason"), 300),
                "expires_at": row.get("expires_at"),
                "compensating_controls": row.get("compensating_controls"),
            }
            for row in exceptions
        ],
    }


async def _run_answer_ai(
    questionnaire: dict,
    items: list[dict],
    context: dict,
    model: str | None,
) -> tuple[list[dict], str]:
    try:
        from openrouter import OpenRouter
    except ModuleNotFoundError as exc:
        raise UserError("Questionnaire answer drafting requires the openrouter workflow dependency.") from exc

    api_key, configured_model = await _resolve_openrouter()
    selected_model = model or configured_model
    item_ids = {row["id"] for row in items}
    user_prompt = (
        f"Questionnaire: {questionnaire.get('name')}\n"
        f"Carrier: {questionnaire.get('carrier') or 'Unknown'}\n\n"
        f"{ANSWER_SCHEMA}\n\n"
        "Questions:\n"
        f"{_json_dumps([{'item_id': row.get('id'), 'question_text': row.get('question_text'), 'answer_type': row.get('answer_type'), 'topic': row.get('normalized_topic'), 'source_excerpt': row.get('source_excerpt')} for row in items])}\n\n"
        "Bifrost GRC context:\n"
        f"{_json_dumps(context)}"
    )
    async with OpenRouter(api_key=api_key) as client:
        response = await client.chat.send_async(
            model=selected_model,
            messages=[
                {"role": "system", "content": ANSWER_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=12000,
        )
    raw = response.choices[0].message.content
    return _normalize_answers(_extract_json_object(raw), item_ids), selected_model


@workflow(
    name="Extract GRC Questionnaire",
    description="Extract structured questions from an uploaded Bifrost GRC questionnaire source document.",
    category="grc",
)
async def grc_v2_extract_grc_questionnaire(
    questionnaire_id: str,
    replace_existing: bool = True,
    model: str | None = None,
    max_chars: int = 80000,
    prefill_answers: bool = False,
) -> dict:
    if not questionnaire_id:
        raise UserError("questionnaire_id is required")
    if max_chars < 1000:
        raise UserError("max_chars must be at least 1000")

    questionnaire = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id))
    org_id = bind_organization_scope(
        require_row_access(questionnaire, resource="questionnaire"),
        resource="questionnaire",
    )
    source_id = questionnaire.get("source_document_id")
    if not source_id:
        raise UserError("Questionnaire has no source_document_id")
    source = _doc_to_row(await tables.get(TABLE_SOURCE_DOCUMENTS, source_id))
    source_org_id = require_row_access(source, resource="source document")
    if source_org_id != org_id:
        raise UserError("source document organization does not match the questionnaire")
    file_path = source.get("file_path")
    if not file_path:
        raise UserError("Source document has no file_path")

    run_doc = await tables.insert(
        TABLE_QUESTIONNAIRE_RUNS,
        {
            "organization_id": org_id,
            "questionnaire_id": questionnaire_id,
            "run_type": "extraction",
            "status": "running",
            "model": model,
            "started_at": _now(),
        },
    )
    run_id = getattr(run_doc, "id", None)

    try:
        await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "extracting"})
        if not org_id:
            raise UserError("Questionnaire organization_id is required")
        blob = await read_source_file(files, source)
        text, extraction_meta = _extract_text(blob, source.get("file_name"), source.get("mime_type"))
        if not text:
            raise UserError("No readable text was found in the source document")
        extracted_text_path = f"grc/questionnaires/{questionnaire_id}/extracted_text.txt"
        await files.write(
            extracted_text_path,
            text,
            location="grc-questionnaire-text",
            scope=org_id,
        )
        source_patch = {"extracted_text_path": extracted_text_path}
        if extraction_meta.get("page_count") and not source.get("page_count"):
            source_patch["page_count"] = extraction_meta["page_count"]
        await tables.update(TABLE_SOURCE_DOCUMENTS, source_id, source_patch)

        payload, used_model = await _run_extraction_ai(text, questionnaire, model, max_chars, prefill=prefill_answers)
        sections = _normalize_extraction(payload)
        if not sections:
            raise UserError("AI extraction returned no questions")

        deleted = await _delete_existing_questionnaire_children(questionnaire_id) if replace_existing else {}
        section_count = 0
        item_count = 0
        prefilled_count = 0
        for section_index, section in enumerate(sections, start=1):
            section_doc = await tables.insert(
                TABLE_QUESTIONNAIRE_SECTIONS,
                {
                    "organization_id": org_id,
                    "questionnaire_id": questionnaire_id,
                    "title": section["title"],
                    "sort_order": section_index * 10,
                    "source_page": section.get("source_page"),
                    "source_anchor": section.get("source_anchor"),
                },
            )
            section_id = getattr(section_doc, "id", None)
            section_count += 1
            for item_index, item in enumerate(section["questions"], start=1):
                item_count += 1
                source_answer = item.get("source_answer") if prefill_answers else None
                item_doc = await tables.insert(
                    TABLE_QUESTIONNAIRE_ITEMS,
                    {
                        "organization_id": org_id,
                        "questionnaire_id": questionnaire_id,
                        "section_id": section_id,
                        "question_text": item["question_text"],
                        "normalized_topic": item.get("normalized_topic"),
                        "answer_type": item.get("answer_type") or "unknown",
                        "audience": item.get("audience") or "customer",
                        "sort_order": item_count * 10,
                        "source_page": item.get("source_page"),
                        "source_anchor": item.get("source_anchor"),
                        "source_excerpt": item.get("source_excerpt"),
                        "extraction_confidence": item.get("extraction_confidence"),
                        "status": "answered" if source_answer else "extracted",
                        "metadata_json": _json_dumps(item.get("metadata") or {}),
                    },
                )
                # Prefill: a returned/prior-year questionnaire already carries answers. Pre-create a
                # response tagged generated_by="source_document" (distinct from AI/agent drafts) so the
                # reviewer sees what the customer already filled in, not a blank field.
                if source_answer:
                    item_id = getattr(item_doc, "id", None)
                    if item_id:
                        await tables.insert(
                            TABLE_QUESTIONNAIRE_RESPONSES,
                            {
                                "organization_id": org_id,
                                "questionnaire_id": questionnaire_id,
                                "item_id": item_id,
                                "draft_answer": source_answer,
                                "status": "needs_review",
                                "generated_by": "source_document",
                                "citations_json": _json_dumps([]),
                                "metadata_json": _json_dumps({"from_source": True, "source_document_id": source_id}),
                            },
                        )
                        prefilled_count += 1

        completed_at = _now()
        stats = {
            "sections": section_count,
            "items": item_count,
            "prefilled_answers": prefilled_count,
            "deleted": deleted,
            "parser": extraction_meta,
            "source_chars": len(text),
            "processed_chars": min(len(text), max_chars),
        }
        await tables.update(
            TABLE_QUESTIONNAIRES,
            questionnaire_id,
            {
                "status": "needs_review",
                "extraction_model": used_model,
                "extracted_at": completed_at,
                "metadata_json": _json_dumps({"last_extraction": stats}),
            },
        )
        if run_id:
            await tables.update(
                TABLE_QUESTIONNAIRE_RUNS,
                run_id,
                {
                    "status": "completed",
                    "model": used_model,
                    "completed_at": completed_at,
                    "stats_json": _json_dumps(stats),
                },
            )
        return {"questionnaire_id": questionnaire_id, "run_id": run_id, **stats}
    except Exception as exc:
        logger.exception("Questionnaire extraction failed questionnaire_id=%s", questionnaire_id)
        failed_at = _now()
        try:
            await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "failed"})
            if run_id:
                await tables.update(
                    TABLE_QUESTIONNAIRE_RUNS,
                    run_id,
                    {
                        "status": "failed",
                        "completed_at": failed_at,
                        "error": str(exc),
                    },
                )
        except Exception:
            logger.exception("Failed to record questionnaire extraction failure")
        raise


AUDIENCE_SYSTEM_PROMPT = (
    "You classify cybersecurity insurance / GRC questionnaire questions by who must answer them.\nReturn only JSON.\n"
    + AUDIENCE_RULE
    + "\n"
)

AUDIENCE_SCHEMA = """Return this exact JSON shape:
{
  "classifications": [
    { "item_id": "id", "audience": "msp|customer" }
  ]
}
"""


async def _run_audience_ai(items: list[dict], model: str | None) -> tuple[dict[str, str], str]:
    try:
        from openrouter import OpenRouter
    except ModuleNotFoundError as exc:
        raise UserError("Audience classification requires the openrouter workflow dependency.") from exc

    api_key, configured_model = await _resolve_openrouter()
    selected_model = model or configured_model
    compact = [{"item_id": row["id"], "question_text": row.get("question_text")} for row in items]
    user_prompt = f"{AUDIENCE_SCHEMA}\n\nClassify each question:\n{_json_dumps(compact)}"
    async with OpenRouter(api_key=api_key) as client:
        response = await client.chat.send_async(
            model=selected_model,
            messages=[
                {"role": "system", "content": AUDIENCE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=16000,
        )
    raw = response.choices[0].message.content
    payload = _extract_json_object(raw)
    out: dict[str, str] = {}
    classifications = payload.get("classifications")
    if isinstance(classifications, list):
        for entry in classifications:
            if not isinstance(entry, dict):
                continue
            item_id = str(entry.get("item_id") or "")
            audience = str(entry.get("audience") or "").strip().lower()
            if item_id and audience in AUDIENCES:
                out[item_id] = audience
    return out, selected_model


@workflow(
    name="Classify GRC Questionnaire Audience",
    description="Classify each Bifrost GRC questionnaire item as msp- or customer-answerable, updating items in place without touching drafted answers, links, or sections. Backfills audience on items that lack it.",
    category="grc",
)
async def classify_questionnaire_audience(
    questionnaire_id: str,
    only_missing: bool = True,
    model: str | None = None,
    batch_size: int = 60,
) -> dict:
    if not questionnaire_id:
        raise UserError("questionnaire_id is required")

    questionnaire = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id))
    bind_organization_scope(
        require_row_access(questionnaire, resource="questionnaire"),
        resource="questionnaire",
    )

    item_rows = await _query_rows(
        TABLE_QUESTIONNAIRE_ITEMS,
        where={"questionnaire_id": questionnaire_id},
        limit=1000,
    )
    item_rows = [row for row in item_rows if row.get("id") and row.get("question_text")]
    if only_missing:
        item_rows = [
            row for row in item_rows
            if str(row.get("audience") or "").strip().lower() not in AUDIENCES
        ]
    if not item_rows:
        return {"questionnaire_id": questionnaire_id, "total": 0, "classified": 0, "updated": 0}

    batch = max(1, batch_size)
    classified: dict[str, str] = {}
    used_model = model
    for start in range(0, len(item_rows), batch):
        chunk = item_rows[start : start + batch]
        result, used_model = await _run_audience_ai(chunk, model)
        classified.update(result)

    updated = 0
    for row in item_rows:
        # Default unclassified items to customer — an MSP answering a business/legal question
        # it can't verify is the trust-killer; staff can re-route in the UI.
        audience = classified.get(row["id"]) or "customer"
        await tables.update(TABLE_QUESTIONNAIRE_ITEMS, row["id"], {"audience": audience})
        updated += 1

    return {
        "questionnaire_id": questionnaire_id,
        "total": len(item_rows),
        "classified": len(classified),
        "updated": updated,
        "model": used_model,
    }


@workflow(
    name="Draft GRC Questionnaire Answers",
    description="Draft answers for extracted Bifrost GRC questionnaire items using existing applied controls, evidence, policies, and control mappings.",
    category="grc",
)
async def grc_v2_draft_grc_questionnaire_answers(
    questionnaire_id: str,
    replace_existing: bool = False,
    model: str | None = None,
    max_items: int = 40,
    max_context_rows: int = 120,
) -> dict:
    if not questionnaire_id:
        raise UserError("questionnaire_id is required")
    if max_items < 1:
        raise UserError("max_items must be at least 1")

    questionnaire = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id))
    org_id = bind_organization_scope(
        require_row_access(questionnaire, resource="questionnaire"),
        resource="questionnaire",
    )

    item_rows = await _query_rows(
        TABLE_QUESTIONNAIRE_ITEMS,
        where={"questionnaire_id": questionnaire_id},
        limit=1000,
    )
    item_rows = [row for row in item_rows if row.get("id") and row.get("question_text")]
    if not item_rows:
        raise UserError("Questionnaire has no extracted items to answer")
    item_rows.sort(key=lambda row: (row.get("sort_order") or 999999, row.get("created_at") or ""))

    existing_responses = await _query_rows(
        TABLE_QUESTIONNAIRE_RESPONSES,
        where={"questionnaire_id": questionnaire_id},
        limit=1000,
    )
    answered_item_ids = {
        row.get("item_id")
        for row in existing_responses
        if row.get("item_id") and (row.get("final_answer") or row.get("draft_answer"))
    }
    if not replace_existing:
        item_rows = [row for row in item_rows if row.get("id") not in answered_item_ids]
    item_rows = item_rows[:max_items]
    if not item_rows:
        return {
            "questionnaire_id": questionnaire_id,
            "run_id": None,
            "items": 0,
            "responses": 0,
            "links": 0,
            "skipped": len(answered_item_ids),
        }

    run_doc = await tables.insert(
        TABLE_QUESTIONNAIRE_RUNS,
        {
            "organization_id": org_id,
            "questionnaire_id": questionnaire_id,
            "run_type": "answering",
            "status": "running",
            "model": model,
            "started_at": _now(),
        },
    )
    run_id = getattr(run_doc, "id", None)

    try:
        await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "answering"})
        item_ids = {row["id"] for row in item_rows}
        context = await _build_answer_context(questionnaire, max_context_rows=max_context_rows)
        answers, used_model = await _run_answer_ai(questionnaire, item_rows, context, model)
        if not answers:
            raise UserError("AI answer drafting returned no answers")

        await _delete_suggested_answer_links(questionnaire_id, item_ids)
        response_by_item_id = {row.get("item_id"): row for row in existing_responses if row.get("item_id")}
        valid_targets = {
            "applied_control": {row.get("id") for row in context["applied_controls"] if row.get("id")},
            "control": {row.get("id") for row in context["reference_controls"] if row.get("id")},
            "evidence": {row.get("id") for row in context["evidence"] if row.get("id")},
            "policy": {row.get("id") for row in context["policies"] if row.get("id")},
        }

        response_count = 0
        link_count = 0
        for answer in answers:
            item_id = answer["item_id"]
            citations = answer.get("citations") or []
            payload = {
                "organization_id": org_id,
                "questionnaire_id": questionnaire_id,
                "item_id": item_id,
                "draft_answer": answer["draft_answer"],
                "status": "needs_review" if answer.get("needs_review", True) else "draft",
                "confidence": answer.get("confidence"),
                "generated_by": "agent",
                "citations_json": _json_dumps(citations),
                "metadata_json": _json_dumps({"run_id": run_id, "model": used_model}),
            }
            existing = response_by_item_id.get(item_id)
            if existing and existing.get("id"):
                await tables.update(TABLE_QUESTIONNAIRE_RESPONSES, existing["id"], payload)
                response_id = existing["id"]
            else:
                response_doc = await tables.insert(TABLE_QUESTIONNAIRE_RESPONSES, payload)
                response_id = getattr(response_doc, "id", None)
            response_count += 1
            await tables.update(TABLE_QUESTIONNAIRE_ITEMS, item_id, {"status": "answered"})

            for link in answer.get("links") or []:
                if not isinstance(link, dict):
                    continue
                target_type = str(link.get("target_type") or "")
                target_id = str(link.get("target_id") or "")
                if target_type not in valid_targets or target_id not in valid_targets[target_type]:
                    continue
                try:
                    confidence = float(link.get("confidence", answer.get("confidence", 0.5)))
                except (TypeError, ValueError):
                    confidence = answer.get("confidence", 0.5)
                link_doc = await tables.insert(
                    TABLE_QUESTIONNAIRE_CONTROL_LINKS,
                    {
                        "organization_id": org_id,
                        "questionnaire_id": questionnaire_id,
                        "item_id": item_id,
                        "response_id": response_id,
                        "target_type": target_type,
                        "target_id": target_id,
                        "relationship": link.get("relationship") or "supports",
                        "confidence": max(0.0, min(1.0, confidence)),
                        "rationale": _truncate(link.get("rationale"), 900),
                        "status": "suggested",
                    },
                )
                link_row = {
                    "id": getattr(link_doc, "id", None),
                    "status": "suggested",
                    "target_type": target_type,
                    "target_id": target_id,
                    "relationship": link.get("relationship") or "supports",
                    "confidence": max(0.0, min(1.0, confidence)),
                    "rationale": _truncate(link.get("rationale"), 900),
                }
                await _upsert_link_proposal(questionnaire_id, org_id, item_id, response_id, link_row)
                link_count += 1

        completed_at = _now()
        stats = {
            "items": len(item_rows),
            "responses": response_count,
            "links": link_count,
            "skipped_existing": len(answered_item_ids) if not replace_existing else 0,
            "context_counts": {
                "applied_controls": len(context["applied_controls"]),
                "control_mappings": len(context["control_mappings"]),
                "reference_controls": len(context["reference_controls"]),
                "evidence": len(context["evidence"]),
                "policies": len(context["policies"]),
            },
        }
        await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "needs_review"})
        if run_id:
            await tables.update(
                TABLE_QUESTIONNAIRE_RUNS,
                run_id,
                {
                    "status": "completed",
                    "model": used_model,
                    "completed_at": completed_at,
                    "stats_json": _json_dumps(stats),
                },
            )
        return {"questionnaire_id": questionnaire_id, "run_id": run_id, **stats}
    except Exception as exc:
        logger.exception("Questionnaire answer drafting failed questionnaire_id=%s", questionnaire_id)
        failed_at = _now()
        try:
            await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "failed"})
            if run_id:
                await tables.update(
                    TABLE_QUESTIONNAIRE_RUNS,
                    run_id,
                    {
                        "status": "failed",
                        "completed_at": failed_at,
                        "error": str(exc),
                    },
                )
        except Exception:
            logger.exception("Failed to record questionnaire answer drafting failure")
        raise


INVESTIGATION_AGENT_NAME = "GRC Investigation Agent"

_INVESTIGATION_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "answers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "answer": {"type": "string"},
                    "confidence": {"type": "number"},
                    "basis": {"type": "string"},
                    "reasoning": {"type": "string"},
                    "relied_on": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string"},
                                "id": {"type": "string"},
                                "name": {"type": "string"},
                            },
                        },
                    },
                    "found_but_unrecorded": {
                        "type": ["object", "null"],
                        "properties": {
                            "kind": {"type": "string"},
                            "what": {"type": "string"},
                            "capture_proposal": {"type": "string"},
                        },
                    },
                },
                "required": ["item_id", "answer", "confidence"],
            },
        }
    },
    "required": ["answers"],
}

# relied_on.type values that map to a suggested questionnaire control link target_type.
_RELIED_ON_LINK_TYPES = {"applied_control", "control", "evidence", "policy"}


def _coerce_agent_answers(result) -> list[dict]:
    """Agent output may be a dict (structured) or a JSON/prose string. Normalize to answers list."""
    payload = {}
    if isinstance(result, dict):
        payload = result
    elif isinstance(result, str):
        try:
            payload = _extract_json_object(result)
        except Exception:  # noqa: BLE001 - tolerate non-JSON agent prose.
            payload = {}
    answers = payload.get("answers") if isinstance(payload, dict) else None
    return [a for a in answers if isinstance(a, dict) and a.get("item_id")] if isinstance(answers, list) else []


async def _run_investigation_batch(payload: dict, output_schema: dict, timeout: int):
    """Invoke the GRC Investigation Agent for one batch."""
    return await agents.run(
        INVESTIGATION_AGENT_NAME,
        input=payload,
        output_schema=output_schema,
        timeout=timeout,
    )


@workflow(
    name="draft_grc_questionnaire_answers_via_agent",
    description=(
        "Draft Bifrost GRC questionnaire answers by running the GRC Investigation Agent over the "
        "questions in batches (read/reason only). Writes draft responses and suggested control links, "
        "and surfaces found-but-unrecorded capture proposals for the GRC Steward to action "
        "(confirm-gated — this workflow never writes the captures itself). Optionally classifies gaps after."
    ),
    category="grc",
)
async def grc_v2_draft_grc_questionnaire_answers_via_agent(
    questionnaire_id: str,
    batch_size: int = 15,
    max_items: int = 120,
    replace_existing: bool = False,
    only_audience: str | None = "msp",
    classify_gaps: bool = True,
    max_context_rows: int = 120,
    agent_timeout: int = 600,
) -> dict:
    if not questionnaire_id:
        raise UserError("questionnaire_id is required")
    batch_size = max(1, min(batch_size, 40))
    max_items = max(1, min(max_items, 1000))

    questionnaire = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id))
    org_id = bind_organization_scope(
        require_row_access(questionnaire, resource="questionnaire"),
        resource="questionnaire",
    )

    item_rows = await _query_rows(TABLE_QUESTIONNAIRE_ITEMS, where={"questionnaire_id": questionnaire_id}, limit=1000)
    item_rows = [row for row in item_rows if row.get("id") and row.get("question_text")]
    if only_audience:
        item_rows = [row for row in item_rows if (row.get("audience") or "customer") == only_audience]
    if not item_rows:
        raise UserError("Questionnaire has no extracted items matching the requested audience to answer")
    item_rows.sort(key=lambda row: (row.get("sort_order") or 999999, row.get("created_at") or ""))

    existing_responses = await _query_rows(TABLE_QUESTIONNAIRE_RESPONSES, where={"questionnaire_id": questionnaire_id}, limit=1000)
    answered_item_ids = {
        row.get("item_id")
        for row in existing_responses
        if row.get("item_id") and (row.get("final_answer") or row.get("draft_answer"))
    }
    if not replace_existing:
        item_rows = [row for row in item_rows if row.get("id") not in answered_item_ids]
    item_rows = item_rows[:max_items]
    if not item_rows:
        return {
            "questionnaire_id": questionnaire_id,
            "run_id": None,
            "items": 0,
            "responses": 0,
            "links": 0,
            "capture_proposals": [],
            "skipped": len(answered_item_ids),
        }

    run_doc = await tables.insert(
        TABLE_QUESTIONNAIRE_RUNS,
        {
            "organization_id": org_id,
            "questionnaire_id": questionnaire_id,
            "run_type": "answering",
            "status": "running",
            "model": INVESTIGATION_AGENT_NAME,
            "started_at": _now(),
        },
    )
    run_id = getattr(run_doc, "id", None)

    try:
        await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "answering"})
        # Build context once to validate suggested-link targets against rows the org can actually see.
        context = await _build_answer_context(questionnaire, max_context_rows=max_context_rows)
        valid_targets = {
            "applied_control": {row.get("id") for row in context["applied_controls"] if row.get("id")},
            "control": {row.get("id") for row in context["reference_controls"] if row.get("id")},
            "evidence": {row.get("id") for row in context["evidence"] if row.get("id")},
            "policy": {row.get("id") for row in context["policies"] if row.get("id")},
        }
        response_by_item_id = {row.get("item_id"): row for row in existing_responses if row.get("item_id")}
        item_by_id = {row["id"]: row for row in item_rows}

        await _delete_suggested_answer_links(questionnaire_id, set(item_by_id))

        response_count = 0
        link_count = 0
        batches = 0
        failed_batches: list[dict] = []
        capture_proposals: list[dict] = []
        for start in range(0, len(item_rows), batch_size):
            batch = item_rows[start : start + batch_size]
            batches += 1
            batch_questions = [
                {
                    "item_id": row["id"],
                    "question_text": row.get("question_text"),
                    "answer_type": row.get("answer_type"),
                    "topic": row.get("normalized_topic"),
                }
                for row in batch
            ]
            # Per-batch resilience: a transient upstream failure (e.g. 429) on one batch must
            # not lose the whole run's progress. Record it and move on.
            try:
                agent_result = await _run_investigation_batch(
                    {
                        "organization_id": org_id,
                        "questionnaire": questionnaire.get("name"),
                        "carrier": questionnaire.get("carrier"),
                        "questions": batch_questions,
                    },
                    _INVESTIGATION_OUTPUT_SCHEMA,
                    agent_timeout,
                )
            except Exception as exc:  # noqa: BLE001 - isolate transient batch failures.
                logger.warning("Investigation batch %d failed: %s", batches, exc)
                failed_batches.append(
                    {
                        "batch": batches,
                        "item_ids": [row["id"] for row in batch],
                        "error": str(exc)[:300],
                        "error_type": type(exc).__name__,
                        "error_repr": repr(exc)[:300],
                    }
                )
                continue
            for answer in _coerce_agent_answers(agent_result):
                item_id = answer.get("item_id")
                if item_id not in item_by_id:
                    continue
                try:
                    confidence = float(answer.get("confidence")) if answer.get("confidence") is not None else None
                except (TypeError, ValueError):
                    confidence = None
                relied_on = answer.get("relied_on") if isinstance(answer.get("relied_on"), list) else []
                payload = {
                    "organization_id": org_id,
                    "questionnaire_id": questionnaire_id,
                    "item_id": item_id,
                    "draft_answer": answer.get("answer"),
                    "status": "needs_review",
                    "confidence": confidence,
                    "generated_by": "investigation_agent",
                    "citations_json": _json_dumps(
                        [{"type": r.get("type"), "id": r.get("id"), "name": r.get("name")} for r in relied_on if isinstance(r, dict)]
                    ),
                    "metadata_json": _json_dumps(
                        {
                            "run_id": run_id,
                            "agent": INVESTIGATION_AGENT_NAME,
                            "basis": answer.get("basis"),
                            "reasoning": _truncate(answer.get("reasoning"), 900),
                        }
                    ),
                }
                existing = response_by_item_id.get(item_id)
                if existing and existing.get("id"):
                    await tables.update(TABLE_QUESTIONNAIRE_RESPONSES, existing["id"], payload)
                    response_id = existing["id"]
                else:
                    response_doc = await tables.insert(TABLE_QUESTIONNAIRE_RESPONSES, payload)
                    response_id = getattr(response_doc, "id", None)
                    response_by_item_id[item_id] = {"id": response_id, "item_id": item_id}
                response_count += 1
                await tables.update(TABLE_QUESTIONNAIRE_ITEMS, item_id, {"status": "answered"})

                for relied in relied_on:
                    if not isinstance(relied, dict):
                        continue
                    target_type = str(relied.get("type") or "")
                    target_id = str(relied.get("id") or "")
                    if target_type not in _RELIED_ON_LINK_TYPES or target_id not in valid_targets.get(target_type, set()):
                        continue
                    link_doc = await tables.insert(
                        TABLE_QUESTIONNAIRE_CONTROL_LINKS,
                        {
                            "organization_id": org_id,
                            "questionnaire_id": questionnaire_id,
                            "item_id": item_id,
                            "response_id": response_id,
                            "target_type": target_type,
                            "target_id": target_id,
                            "relationship": "supports",
                            "confidence": confidence if confidence is not None else 0.5,
                            "rationale": _truncate(answer.get("reasoning"), 900),
                            "status": "suggested",
                        },
                    )
                    link_row = {
                        "id": getattr(link_doc, "id", None),
                        "status": "suggested",
                        "target_type": target_type,
                        "target_id": target_id,
                        "relationship": "supports",
                        "confidence": confidence if confidence is not None else 0.5,
                        "rationale": _truncate(answer.get("reasoning"), 900),
                    }
                    await _upsert_link_proposal(questionnaire_id, org_id, item_id, response_id, link_row)
                    link_count += 1

                fbu = answer.get("found_but_unrecorded")
                if isinstance(fbu, dict) and (fbu.get("what") or fbu.get("capture_proposal")):
                    await _upsert_create_proposal(
                        questionnaire_id,
                        org_id,
                        item_by_id[item_id],
                        response_id,
                        fbu,
                        confidence,
                    )
                    capture_proposals.append(
                        {
                            "item_id": item_id,
                            "question_text": item_by_id[item_id].get("question_text"),
                            "kind": fbu.get("kind"),
                            "what": fbu.get("what"),
                            "capture_proposal": fbu.get("capture_proposal"),
                            "organization_id": org_id,
                        }
                    )

        completed_at = _now()
        stats = {
            "items": len(item_rows),
            "batches": batches,
            "failed_batches": failed_batches,
            "responses": response_count,
            "links": link_count,
            "capture_proposals": capture_proposals,
            "skipped_existing": len(answered_item_ids) if not replace_existing else 0,
        }
        await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "needs_review"})
        if run_id:
            await tables.update(
                TABLE_QUESTIONNAIRE_RUNS,
                run_id,
                {
                    "status": "completed",
                    "model": INVESTIGATION_AGENT_NAME,
                    "completed_at": completed_at,
                    "stats_json": _json_dumps({**stats, "capture_proposal_count": len(capture_proposals)}),
                },
            )

        gaps = None
        if classify_gaps:
            from workflows.grc_v2.grc_recommendations import classify_grc_questionnaire_gaps

            gaps = await classify_grc_questionnaire_gaps(questionnaire_id=questionnaire_id)

        return {"questionnaire_id": questionnaire_id, "run_id": run_id, "gaps": gaps, **stats}
    except Exception as exc:
        logger.exception("Agent questionnaire drafting failed questionnaire_id=%s", questionnaire_id)
        failed_at = _now()
        try:
            await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "failed"})
            if run_id:
                await tables.update(
                    TABLE_QUESTIONNAIRE_RUNS,
                    run_id,
                    {"status": "failed", "completed_at": failed_at, "error": str(exc)},
                )
        except Exception:
            logger.exception("Failed to record agent questionnaire drafting failure")
        raise


@workflow(
    name="Apply GRC Questionnaire Answers",
    description="Apply accepted Bifrost GRC questionnaire proposals into reusable GRC records and relationships.",
    category="grc",
)
async def grc_v2_apply_grc_questionnaire_answers(
    questionnaire_id: str,
    response_ids: list[str] | None = None,
    dry_run: bool = False,
    apply_suggested_links: bool = True,
    create_missing_applied_controls: bool = False,
) -> dict:
    if not questionnaire_id:
        raise UserError("questionnaire_id is required")

    questionnaire = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id))
    org_id = bind_organization_scope(
        require_row_access(questionnaire, resource="questionnaire"),
        resource="questionnaire",
    )
    require_provider("Provider access is required to apply questionnaire answers to shared GRC records.")
    provider_org_id = caller_organization_id()
    if not provider_org_id:
        raise UserError("The provider organization could not be resolved.")

    responses = await _query_rows(
        TABLE_QUESTIONNAIRE_RESPONSES,
        where={"questionnaire_id": questionnaire_id},
        limit=1000,
    )
    response_id_filter = set(response_ids or [])
    accepted = []
    for row in responses:
        if not row.get("id") or not row.get("item_id") or not (row.get("final_answer") or row.get("draft_answer")):
            continue
        if response_id_filter:
            if row.get("id") in response_id_filter:
                accepted.append(row)
        elif row.get("status") == "accepted":
            accepted.append(row)
    if not accepted:
        return {
            "questionnaire_id": questionnaire_id,
            "run_id": None,
            "responses": 0,
            "proposals": 0,
            "created_records": 0,
            "relationship_links": 0,
            "scope_updates": 0,
            "control_mappings": 0,
        }
    accepted_response_ids = {row["id"] for row in accepted}
    accepted_item_ids = {row.get("item_id") for row in accepted}

    proposals = await _query_rows(TABLE_QUESTIONNAIRE_PROPOSALS, where={"questionnaire_id": questionnaire_id}, limit=1000)
    questionnaire_links = await _query_rows(
        TABLE_QUESTIONNAIRE_CONTROL_LINKS,
        where={"questionnaire_id": questionnaire_id},
        limit=1000,
    )

    # Compatibility bridge: older UI actions accepted questionnaire links directly.
    # Convert those accepted links into accepted proposals, but do not auto-accept suggested links.
    proposals_by_link_id = {row.get("target_id"): row for row in proposals if row.get("action") == "use_existing" and row.get("target_type") == "link"}
    for link in questionnaire_links:
        if (
            link.get("status") == "accepted"
            and link.get("id") not in proposals_by_link_id
            and (link.get("response_id") in accepted_response_ids or link.get("item_id") in accepted_item_ids)
        ):
            proposal = await _upsert_link_proposal(
                questionnaire_id,
                org_id,
                link.get("item_id"),
                link.get("response_id"),
                link,
                persist=not dry_run,
            )
            if proposal:
                proposals.append(proposal)

    accepted_proposals = [
        proposal
        for proposal in proposals
        if proposal.get("status") == "accepted"
        and (
            not response_id_filter
            or proposal.get("response_id") in accepted_response_ids
            or proposal.get("item_id") in accepted_item_ids
        )
    ]
    if dry_run:
        creates = [row for row in accepted_proposals if row.get("action") == "create"]
        relationships = sum(len(_json_loads(row.get("relationship_payloads_json"), [])) for row in accepted_proposals)
        return {
            "questionnaire_id": questionnaire_id,
            "dry_run": True,
            "responses": len(accepted),
            "proposals": len(accepted_proposals),
            "created_records": len(creates),
            "relationship_links": relationships,
            "scope_updates": len([row for row in accepted_proposals if row.get("action") == "update_scope"]),
            "control_mappings": 0,
            "legacy_suggested_links_ignored": len([link for link in questionnaire_links if link.get("status") == "suggested"]),
        }

    run_doc = await tables.insert(
        TABLE_QUESTIONNAIRE_RUNS,
        {
            "organization_id": org_id,
            "questionnaire_id": questionnaire_id,
            "run_type": "apply_to_grc",
            "status": "running",
            "started_at": _now(),
        },
    )
    run_id = getattr(run_doc, "id", None)

    proposal_count = 0
    created_count = 0
    relationship_count = 0
    scope_update_count = 0
    mapping_count = 0
    response_count = 0
    applied_controls_by_response: dict[str, set[str]] = {}
    controls_by_response: dict[str, set[str]] = {}

    try:
        for proposal in accepted_proposals:
            proposal_id = proposal.get("id")
            response_id = proposal.get("response_id")
            item_id = proposal.get("item_id")
            response = next((row for row in accepted if row.get("id") == response_id or row.get("item_id") == item_id), {})
            draft_payload = _json_loads(proposal.get("draft_payload_json"), {})
            relationship_payloads = _json_loads(proposal.get("relationship_payloads_json"), [])
            action = proposal.get("action")
            target_id = proposal.get("target_id")
            target_type = proposal.get("target_type")
            actual_target_type = draft_payload.get("target_type") if target_type == "link" else target_type
            actual_target_id = draft_payload.get("target_id") if target_type == "link" else target_id

            if action == "create":
                table = _target_table(target_type)
                if not table:
                    continue
                target_id = target_id or _stable_id("qcreate", proposal.get("content_hash") or proposal_id)
                create_payload = draft_payload if isinstance(draft_payload, dict) else {}
                supplied_org = create_payload.get("organization_id")
                if supplied_org not in (None, provider_org_id, org_id):
                    raise UserError("Questionnaire proposal customer-owner mismatch")
                create_payload = {
                    **_shared_scope_payload(org_id, provider_org_id),
                    **create_payload,
                    "organization_id": org_id,
                }
                if table == TABLE_EVIDENCE:
                    # Proposal drafts can outlive their author. Record the
                    # authenticated user who actually applies the accepted
                    # proposal, never the proposer or a legacy draft value.
                    create_payload["uploaded_by"] = authenticated_actor_id()
                created = await _upsert_row(table, target_id, create_payload)
                actual_target_type = target_type
                actual_target_id = created.get("id") or target_id
                created_count += 1
                if proposal_id:
                    await tables.update(TABLE_QUESTIONNAIRE_PROPOSALS, proposal_id, {"target_id": actual_target_id})
            elif action == "update_scope":
                table = _target_table(target_type)
                if table and target_id and isinstance(draft_payload, dict):
                    target = _doc_to_row(await tables.get(table, target_id))
                    if target.get("organization_id") not in (None, provider_org_id, org_id):
                        raise UserError("Questionnaire target belongs to a different customer.")
                    supplied_org = draft_payload.get("organization_id")
                    if supplied_org not in (None, provider_org_id, org_id):
                        raise UserError("Questionnaire scope update customer-owner mismatch")
                    await tables.update(table, target_id, draft_payload)
                    actual_target_type = target_type
                    actual_target_id = target_id
                    scope_update_count += 1
            elif action == "use_existing" and actual_target_type and actual_target_id:
                table = _target_table(actual_target_type)
                row = _doc_to_row(await tables.get(table, actual_target_id)) if table else None
                if table and row.get("organization_id") not in (None, provider_org_id, org_id):
                    raise UserError("Questionnaire target belongs to a different customer.")
                patch = _scope_patch_for_org(row or {}, org_id) if row else None
                if table and patch:
                    await tables.update(table, actual_target_id, patch)
                    update_scope_id = _stable_id("qprop", questionnaire_id, item_id, response_id, "update_scope", actual_target_type, actual_target_id)
                    await _upsert_row(
                        TABLE_QUESTIONNAIRE_PROPOSALS,
                        update_scope_id,
                        {
                            **_scope_payload(org_id),
                            "questionnaire_id": questionnaire_id,
                            "item_id": item_id,
                            "response_id": response_id,
                            "action": "update_scope",
                            "target_type": actual_target_type,
                            "target_id": actual_target_id,
                            "draft_payload_json": _json_dumps(patch),
                            "relationship_payloads_json": _json_dumps([]),
                            "status": "applied",
                            "confidence": proposal.get("confidence"),
                            "needs_review": False,
                            "rationale": "Scope was expanded because an accepted questionnaire proposal used this record for the questionnaire organization.",
                            "content_hash": _content_hash(questionnaire_id, item_id, actual_target_type, actual_target_id, org_id),
                            "metadata_json": _json_dumps({"source": "questionnaire_apply", "parent_proposal_id": proposal_id}),
                        },
                    )
                    scope_update_count += 1

            if actual_target_id:
                relationship_count += await _apply_relationship_payloads(
                    relationship_payloads,
                    str(actual_target_id),
                    org_id,
                    provider_org_id,
                )
            if proposal_id:
                await tables.update(TABLE_QUESTIONNAIRE_PROPOSALS, proposal_id, {"status": "applied"})
            if target_type == "link" and target_id:
                await tables.update(TABLE_QUESTIONNAIRE_CONTROL_LINKS, target_id, {"status": "applied"})

            if response_id and actual_target_type == "applied_control" and actual_target_id:
                applied_controls_by_response.setdefault(response_id, set()).add(actual_target_id)
            if response_id and actual_target_type == "control" and actual_target_id:
                controls_by_response.setdefault(response_id, set()).add(actual_target_id)
            proposal_count += 1

        for response_id, applied_control_ids in applied_controls_by_response.items():
            response = next((row for row in accepted if row.get("id") == response_id), {})
            for applied_control_id in applied_control_ids:
                await tables.update(TABLE_QUESTIONNAIRE_RESPONSES, response_id, {"applied_control_id": applied_control_id})
                for control_id in controls_by_response.get(response_id, set()):
                    await _upsert_row(
                        TABLE_CONTROL_MAPPINGS,
                        _stable_id("qmap", applied_control_id, control_id, response_id),
                        {
                            **_shared_scope_payload(org_id, provider_org_id),
                            "applied_control_id": applied_control_id,
                            "control_id": control_id,
                            "relationship": "supports",
                            "confidence": response.get("confidence"),
                            "status": "accepted",
                            "rationale": "Accepted questionnaire proposal mapped this applied control to a reference control.",
                            "source_system": "grc_questionnaire",
                            "source_id": response_id,
                            "metadata_json": _json_dumps({"questionnaire_id": questionnaire_id, "item_id": response.get("item_id")}),
                        },
                    )
                    mapping_count += 1

        applied_response_ids = {row.get("response_id") for row in accepted_proposals if row.get("response_id")}
        for response in accepted:
            response_id = response["id"]
            if response_id not in applied_response_ids:
                continue
            metadata = _json_loads(response.get("metadata_json"), {})
            metadata["last_applied_at"] = _now()
            await tables.update(
                TABLE_QUESTIONNAIRE_RESPONSES,
                response_id,
                {
                    "status": "applied",
                    "metadata_json": _json_dumps(metadata),
                },
            )
            response_count += 1

        completed_at = _now()
        stats = {
            "responses": response_count,
            "proposals": proposal_count,
            "created_records": created_count,
            "relationship_links": relationship_count,
            "scope_updates": scope_update_count,
            "control_mappings": mapping_count,
        }
        if response_count:
            await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "completed"})
        if run_id:
            await tables.update(
                TABLE_QUESTIONNAIRE_RUNS,
                run_id,
                {
                    "status": "completed",
                    "completed_at": completed_at,
                    "stats_json": _json_dumps(stats),
                },
            )
        return {"questionnaire_id": questionnaire_id, "run_id": run_id, **stats}
    except Exception as exc:
        logger.exception("Questionnaire apply failed questionnaire_id=%s", questionnaire_id)
        failed_at = _now()
        try:
            await tables.update(TABLE_QUESTIONNAIRES, questionnaire_id, {"status": "failed"})
            if run_id:
                await tables.update(
                    TABLE_QUESTIONNAIRE_RUNS,
                    run_id,
                    {
                        "status": "failed",
                        "completed_at": failed_at,
                        "error": str(exc),
                    },
                )
        except Exception:
            logger.exception("Failed to record questionnaire apply failure")
        raise


@workflow(
    name="Validate GRC Questionnaire Apply Fixture",
    description=(
        "Create an idempotent Bifrost GRC questionnaire fixture and validate that accepted "
        "questionnaire proposals apply relationships and control mappings without auto-creating note evidence."
    ),
    category="grc",
)
async def validate_grc_questionnaire_apply_fixture(
    bifrost_organization_id: str,
    applied_control_id: str | None = None,
    control_id: str | None = None,
    apply: bool = False,
    confirm_apply: bool = False,
) -> dict:
    if not bifrost_organization_id:
        raise UserError("bifrost_organization_id is required")
    bifrost_organization_id = bind_organization_scope(
        bifrost_organization_id,
        resource="questionnaire fixture",
    )
    require_provider("Provider access is required to validate shared GRC questionnaire behavior.")
    provider_org_id = caller_organization_id()
    if not provider_org_id:
        raise UserError("The provider organization could not be resolved.")
    if apply and not confirm_apply:
        raise UserError("confirm_apply=true is required before applying the questionnaire fixture")

    applied_controls = await _query_rows(
        TABLE_APPLIED_CONTROLS,
        where={},
        limit=100,
    )
    applied_controls = [row for row in applied_controls if _applies_to_org(row, bifrost_organization_id)]
    if applied_control_id:
        applied = next((row for row in applied_controls if row.get("id") == applied_control_id), None)
        if not applied:
            raise UserError(f"Applied control not found in org: {applied_control_id}")
    else:
        applied = next((row for row in applied_controls if row.get("id")), None)
    if not applied:
        raise UserError("No applied control is available for questionnaire fixture validation")
    applied_control_id = applied["id"]

    mappings = await _query_rows(
        TABLE_CONTROL_MAPPINGS,
        where={"applied_control_id": applied_control_id},
        limit=100,
    )
    mappings = [row for row in mappings if _applies_to_org(row, bifrost_organization_id)]
    if control_id:
        control = _doc_to_row(await tables.get(TABLE_CONTROLS, control_id))
        if not control:
            raise UserError(f"Control not found: {control_id}")
    else:
        mapped_control_id = next((row.get("control_id") for row in mappings if row.get("control_id")), None)
        if not mapped_control_id:
            controls = await _query_rows(TABLE_CONTROLS, where={"is_active": True}, limit=100)
            mapped_control_id = next((row.get("id") for row in controls if row.get("id")), None)
        control = _doc_to_row(await tables.get(TABLE_CONTROLS, mapped_control_id)) if mapped_control_id else None
    if not control:
        raise UserError("No reference control is available for questionnaire fixture validation")
    control_id = control["id"]

    fixture_key = _stable_id("qfixture", bifrost_organization_id, applied_control_id, control_id)
    source_id = _stable_id(fixture_key, "source")
    questionnaire_id = _stable_id(fixture_key, "questionnaire")
    item_id = _stable_id(fixture_key, "item")
    response_id = _stable_id(fixture_key, "response")
    applied_link_id = _stable_id(fixture_key, "link", "applied")
    control_link_id = _stable_id(fixture_key, "link", "control")

    source = await _upsert_row(
        TABLE_SOURCE_DOCUMENTS,
        source_id,
        {
            "organization_id": bifrost_organization_id,
            "name": "Questionnaire Apply Fixture",
            "document_type": "questionnaire",
            "file_name": "questionnaire-fixture.txt",
            "mime_type": "text/plain",
            "source_system": "bifrost_grc_validation",
            "source_id": fixture_key,
            "metadata_json": _json_dumps({"fixture": True, "created_by": "validate_grc_questionnaire_apply_fixture"}),
        },
    )
    questionnaire = await _upsert_row(
        TABLE_QUESTIONNAIRES,
        questionnaire_id,
        {
            "organization_id": bifrost_organization_id,
            "name": "Questionnaire Apply Fixture",
            "source_document_id": source_id,
            "carrier": "Fixture",
            "status": "needs_review",
            "metadata_json": _json_dumps({"fixture": True}),
        },
    )
    item = await _upsert_row(
        TABLE_QUESTIONNAIRE_ITEMS,
        item_id,
        {
            "organization_id": bifrost_organization_id,
            "questionnaire_id": questionnaire_id,
            "question_text": f"Does the organization maintain {applied.get('name')}?",
            "normalized_topic": applied.get("name"),
            "answer_type": "yes_no",
            "sort_order": 10,
            "source_page": 1,
            "source_excerpt": "Fixture questionnaire question used for Bifrost GRC validation.",
            "extraction_confidence": 1,
            "status": "accepted",
            "metadata_json": _json_dumps({"fixture": True}),
        },
    )
    response = await _upsert_row(
        TABLE_QUESTIONNAIRE_RESPONSES,
        response_id,
        {
            "organization_id": bifrost_organization_id,
            "questionnaire_id": questionnaire_id,
            "item_id": item_id,
            "draft_answer": f"Yes. {applied.get('name')} is tracked as an applied control in Bifrost GRC.",
            "final_answer": f"Yes. {applied.get('name')} is tracked as an applied control in Bifrost GRC.",
            "status": "accepted",
            "confidence": 1,
            "generated_by": "validation",
            "citations_json": _json_dumps([
                {
                    "target_type": "applied_control",
                    "target_id": applied_control_id,
                    "label": applied.get("name"),
                    "excerpt": _truncate(applied.get("description"), 300),
                }
            ]),
            "metadata_json": _json_dumps({"fixture": True}),
        },
    )
    applied_link = await _upsert_row(
        TABLE_QUESTIONNAIRE_CONTROL_LINKS,
        applied_link_id,
        {
            "organization_id": bifrost_organization_id,
            "questionnaire_id": questionnaire_id,
            "item_id": item_id,
            "response_id": response_id,
            "target_type": "applied_control",
            "target_id": applied_control_id,
            "relationship": "answers",
            "confidence": 1,
            "rationale": "Fixture accepted answer is explicitly supported by the applied control.",
            "status": "accepted",
        },
    )
    control_link = await _upsert_row(
        TABLE_QUESTIONNAIRE_CONTROL_LINKS,
        control_link_id,
        {
            "organization_id": bifrost_organization_id,
            "questionnaire_id": questionnaire_id,
            "item_id": item_id,
            "response_id": response_id,
            "target_type": "control",
            "target_id": control_id,
            "relationship": "maps_to",
            "confidence": 1,
            "rationale": "Fixture accepted answer maps the applied control to the selected reference control.",
            "status": "accepted",
        },
    )

    dry_run_result = await grc_v2_apply_grc_questionnaire_answers(
        questionnaire_id=questionnaire_id,
        response_ids=[response_id],
        dry_run=True,
        apply_suggested_links=False,
        create_missing_applied_controls=False,
    )
    apply_result = None
    post_apply = {}
    if apply:
        apply_result = await grc_v2_apply_grc_questionnaire_answers(
            questionnaire_id=questionnaire_id,
            response_ids=[response_id],
            dry_run=False,
            apply_suggested_links=False,
            create_missing_applied_controls=False,
        )
        refreshed_response = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRE_RESPONSES, response_id))
        metadata = _json_loads(refreshed_response.get("metadata_json") if refreshed_response else None, {})
        mapping_id = _stable_id("qmap", applied_control_id, control_id, response_id)
        mapping = _doc_to_row(await tables.get(TABLE_CONTROL_MAPPINGS, mapping_id))
        proposals = await _query_rows(TABLE_QUESTIONNAIRE_PROPOSALS, where={"questionnaire_id": questionnaire_id}, limit=1000)
        post_apply = {
            "response_status": refreshed_response.get("status") if refreshed_response else None,
            "applied_evidence_id": metadata.get("applied_evidence_id"),
            "proposal_count": len(proposals),
            "applied_proposals": len([row for row in proposals if row.get("status") == "applied"]),
            "mapping_id": mapping_id,
            "mapping_exists": bool(mapping),
        }

    return {
        "mode": "apply" if apply else "dry_run",
        "bifrost_organization_id": bifrost_organization_id,
        "fixture_key": fixture_key,
        "source_document": {"id": source.get("id"), "name": source.get("name")},
        "questionnaire": {"id": questionnaire.get("id"), "name": questionnaire.get("name")},
        "item": {"id": item.get("id"), "question_text": item.get("question_text")},
        "response": {"id": response.get("id"), "status": response.get("status")},
        "links": [
            {"id": applied_link.get("id"), "target_type": "applied_control", "target_id": applied_control_id},
            {"id": control_link.get("id"), "target_type": "control", "target_id": control_id},
        ],
        "dry_run_result": dry_run_result,
        "apply_result": apply_result,
        "post_apply": post_apply,
    }


@workflow(
    name="Validate GRC Questionnaire Extraction Fixture",
    description=(
        "Create an idempotent DOCX questionnaire fixture and validate extraction plus "
        "OpenRouter answer drafting against live Bifrost GRC context."
    ),
    category="grc",
)
async def validate_grc_questionnaire_extraction_fixture(
    bifrost_organization_id: str,
    replace_existing: bool = True,
    model: str | None = None,
    max_items: int = 3,
    stop_after: str | None = None,
) -> dict:
    if not bifrost_organization_id:
        raise UserError("bifrost_organization_id is required")
    bifrost_organization_id = bind_organization_scope(
        bifrost_organization_id,
        resource="questionnaire fixture",
    )
    max_items = max(1, min(max_items, 10))
    if stop_after and stop_after not in {"upload", "fixture", "extract", "context"}:
        raise UserError("stop_after must be one of: upload, fixture, extract, context")

    fixture_id = _stable_id("qextract", bifrost_organization_id)
    upload_path = f"grc/questionnaires/fixtures/{fixture_id}.docx"
    source_id = _stable_id(fixture_id, "source")
    questionnaire_id = _stable_id(fixture_id, "questionnaire")
    lines = [
        "Bifrost GRC Cyber Insurance Questionnaire Fixture",
        "Access Management",
        "1. Does the organization use privileged access management for local administrator elevation?",
        "2. Are screen lock settings enforced on managed workstations?",
        "3. Does the organization maintain a documented asset management policy?",
    ]
    docx_bytes = _build_fixture_docx(lines)
    await files.write_bytes(
        upload_path,
        docx_bytes,
        location="grc-source-documents",
        scope=bifrost_organization_id,
    )
    if stop_after == "upload":
        readback = await files.read_bytes(
            upload_path,
            location="grc-source-documents",
            scope=bifrost_organization_id,
        )
        text, meta = _extract_docx_text(readback)
        return {
            "bifrost_organization_id": bifrost_organization_id,
            "fixture_id": fixture_id,
            "upload_path": upload_path,
            "uploaded_bytes": len(docx_bytes),
            "readback_bytes": len(readback),
            "parser": meta,
            "text_preview": text[:500],
        }

    source = await _upsert_row(
        TABLE_SOURCE_DOCUMENTS,
        source_id,
        {
            "organization_id": bifrost_organization_id,
            "name": "Questionnaire Extraction Fixture",
            "document_type": "questionnaire",
            "file_name": "questionnaire-extraction-fixture.docx",
            "file_path": upload_path,
            "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "source_system": "bifrost_grc_validation",
            "source_id": fixture_id,
            "metadata_json": _json_dumps({"fixture": True, "size_bytes": len(docx_bytes)}),
        },
    )
    questionnaire = await _upsert_row(
        TABLE_QUESTIONNAIRES,
        questionnaire_id,
        {
            "organization_id": bifrost_organization_id,
            "name": "Questionnaire Extraction Fixture",
            "source_document_id": source_id,
            "carrier": "Fixture",
            "status": "draft",
            "metadata_json": _json_dumps({"fixture": True}),
        },
    )
    if stop_after == "fixture":
        return {
            "bifrost_organization_id": bifrost_organization_id,
            "fixture_id": fixture_id,
            "upload_path": upload_path,
            "source_document": {"id": source.get("id"), "file_path": source.get("file_path")},
            "questionnaire": {"id": questionnaire.get("id"), "status": questionnaire.get("status")},
        }

    extraction = await grc_v2_extract_grc_questionnaire(
        questionnaire_id=questionnaire_id,
        replace_existing=replace_existing,
        model=model,
        max_chars=12000,
    )
    if stop_after == "extract":
        item_rows = await _query_rows(TABLE_QUESTIONNAIRE_ITEMS, where={"questionnaire_id": questionnaire_id}, limit=1000)
        source_after = _doc_to_row(await tables.get(TABLE_SOURCE_DOCUMENTS, source_id))
        questionnaire_after = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id))
        return {
            "bifrost_organization_id": bifrost_organization_id,
            "fixture_id": fixture_id,
            "upload_path": upload_path,
            "source_document": {
                "id": source.get("id"),
                "extracted_text_path": source_after.get("extracted_text_path") if source_after else None,
            },
            "questionnaire": {
                "id": questionnaire.get("id"),
                "status": questionnaire_after.get("status") if questionnaire_after else questionnaire.get("status"),
            },
            "extraction": extraction,
            "post_validation": {
                "items": len(item_rows),
                "has_extracted_text": bool(source_after and source_after.get("extracted_text_path")),
            },
        }
    if stop_after == "context":
        item_rows = await _query_rows(TABLE_QUESTIONNAIRE_ITEMS, where={"questionnaire_id": questionnaire_id}, limit=1000)
        item_rows = [row for row in item_rows if row.get("id") and row.get("question_text")][:max_items]
        questionnaire_for_context = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id)) or questionnaire
        context = await _build_answer_context(questionnaire_for_context, max_context_rows=80)
        return {
            "bifrost_organization_id": bifrost_organization_id,
            "fixture_id": fixture_id,
            "questionnaire_id": questionnaire_id,
            "items_for_drafting": len(item_rows),
            "context_counts": {
                "applied_controls": len(context["applied_controls"]),
                "control_mappings": len(context["control_mappings"]),
                "reference_controls": len(context["reference_controls"]),
                "evidence": len(context["evidence"]),
                "evidence_links": len(context["evidence_links"]),
                "policies": len(context["policies"]),
                "policy_links": len(context["policy_links"]),
            },
            "sample_questions": [
                {
                    "id": row.get("id"),
                    "question_text": row.get("question_text"),
                    "answer_type": row.get("answer_type"),
                }
                for row in item_rows
            ],
        }
    drafting = await grc_v2_draft_grc_questionnaire_answers(
        questionnaire_id=questionnaire_id,
        replace_existing=True,
        model=model,
        max_items=max_items,
        max_context_rows=80,
    )

    item_rows = await _query_rows(TABLE_QUESTIONNAIRE_ITEMS, where={"questionnaire_id": questionnaire_id}, limit=1000)
    response_rows = await _query_rows(TABLE_QUESTIONNAIRE_RESPONSES, where={"questionnaire_id": questionnaire_id}, limit=1000)
    link_rows = await _query_rows(TABLE_QUESTIONNAIRE_CONTROL_LINKS, where={"questionnaire_id": questionnaire_id}, limit=1000)
    source_after = _doc_to_row(await tables.get(TABLE_SOURCE_DOCUMENTS, source_id))
    questionnaire_after = _doc_to_row(await tables.get(TABLE_QUESTIONNAIRES, questionnaire_id))

    return {
        "bifrost_organization_id": bifrost_organization_id,
        "fixture_id": fixture_id,
        "upload_path": upload_path,
        "source_document": {
            "id": source.get("id"),
            "file_path": source_after.get("file_path") if source_after else source.get("file_path"),
            "extracted_text_path": source_after.get("extracted_text_path") if source_after else None,
        },
        "questionnaire": {
            "id": questionnaire.get("id"),
            "name": questionnaire.get("name"),
            "status": questionnaire_after.get("status") if questionnaire_after else questionnaire.get("status"),
        },
        "extraction": extraction,
        "drafting": drafting,
        "post_validation": {
            "items": len(item_rows),
            "responses": len(response_rows),
            "links": len(link_rows),
            "has_extracted_text": bool(source_after and source_after.get("extracted_text_path")),
            "drafted_response_statuses": sorted({str(row.get("status")) for row in response_rows if row.get("status")}),
        },
    }
