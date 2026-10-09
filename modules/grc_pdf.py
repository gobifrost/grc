"""Printable PDF renderers shared by Bifrost GRC export workflows.

The module deliberately has no Bifrost dependency: workflows assemble an authorized
snapshot, then pass that snapshot to one of the renderers below.  This keeps PDF
generation deterministic and makes campaign exports faithful to their sent content.
"""

from __future__ import annotations

import base64
import binascii
import io
import re
from dataclasses import dataclass
from datetime import date, datetime
from html import escape
from pathlib import Path
from typing import Any, Iterable


DEFAULT_PRIMARY_COLOR = "#006B73"
DEFAULT_DARK = "#17252A"
MUTED = "#5B6870"
RULE = "#CDD6D8"
PALE_GRAY = "#F4F6F6"
MAX_LOGO_BYTES = 1_000_000


@dataclass(frozen=True)
class _Branding:
    name: str
    primary_color: str
    accent_color: str
    tint_color: str
    header_text_color: str
    logo_bytes: bytes | None
    logo_width: int
    logo_height: int


def render_policy_pdf(payload: dict[str, Any]) -> bytes:
    """Render a policy and any attached addenda to a printable PDF.

    ``payload`` accepts organization_name, title, version, status, effective_date,
    owner, content, optional addenda, optional campaign metadata, generated_at, and
    ``sample``.  Campaign callers must provide the persisted content snapshot.
    """
    title = _text(payload.get("title")) or "Policy"
    branding = _branding(payload.get("branding"))
    story, styles = _document_opening(payload, title, "Policy document", branding)
    metadata = [
        ("Version", _display(payload.get("version"))),
        ("Status", _humanize(payload.get("status"))),
        ("Effective date", _format_date(payload.get("effective_date"))),
        ("Owner", _display(payload.get("owner"))),
        ("Scope", _display(payload.get("scope_label"))),
    ]
    campaign = _mapping(payload.get("campaign"))
    if campaign:
        metadata.extend([
            ("Campaign", _display(campaign.get("title") or campaign.get("id"))),
            ("Sent", _format_date(campaign.get("sent_date"))),
            ("Due", _format_date(campaign.get("due_date"))),
        ])
    story.extend(_metadata_table(metadata, styles))
    story.extend(_fact_notice_flowables(payload, styles))
    story.append(_section_heading("Policy", styles, level=1))
    images = _bytes_mapping(payload.get("images"))
    story.extend(_markdown_flowables(_text(payload.get("content")), styles, images))

    for addendum in _list_of_mappings(payload.get("addenda")):
        addendum_title = _text(addendum.get("title")) or "Addendum"
        story.append(_section_heading(addendum_title, styles, level=1))
        story.extend(_metadata_table([
            ("Version", _display(addendum.get("version"))),
            ("Effective date", _format_date(addendum.get("effective_date"))),
        ], styles))
        story.extend(_markdown_flowables(_text(addendum.get("content")), styles, images))
    return _build_pdf(story, title, "Policy document", payload, branding)


def render_assessment_pdf(payload: dict[str, Any]) -> bytes:
    """Render an assessment, its control findings, and evidence references."""
    title = _text(payload.get("title")) or "Assessment"
    branding = _branding(payload.get("branding"))
    story, styles = _document_opening(payload, title, "Assessment report", branding)
    story.extend(_metadata_table([
        ("Framework", _display(payload.get("framework_name"))),
        ("Status", _humanize(payload.get("status"))),
        ("Assessment date", _format_date(payload.get("assessment_date"))),
        ("Owner", _display(payload.get("owner"))),
        ("Scope", _display(payload.get("scope_label"))),
        ("Progress", _percent(payload.get("progress_percentage"))),
    ], styles))
    story.extend(_fact_notice_flowables(payload, styles))

    summary = _mapping(payload.get("summary"))
    if summary:
        story.append(_section_heading("Assessment summary", styles, level=1))
        keys = ("total", "compliant", "partially_compliant", "non_compliant", "not_assessed", "not_applicable")
        rows = [[_paragraph("Status", styles["table_header"]), _paragraph("Controls", styles["table_header"])]]
        rows.extend([[_paragraph(_humanize(key), styles["table_label"]), _paragraph(_display(summary.get(key)), styles["table_cell"])] for key in keys if summary.get(key) is not None])
        if len(rows) > 1:
            story.append(_table(rows, [260, 220], repeat_rows=1, branding=branding))
            story.append(_spacer(10))

    controls = _list_of_mappings(payload.get("controls"))
    story.append(_section_heading("Control findings", styles, level=1))
    if not controls:
        story.append(_paragraph("No control findings were included in this export.", styles["body"]))
    for index, control in enumerate(controls, start=1):
        identifier = _text(control.get("identifier"))
        control_title = _text(control.get("title")) or "Untitled control"
        prefix = f"{identifier} — " if identifier else ""
        story.append(_section_heading(f"{index}. {prefix}{control_title}", styles, level=2))
        story.extend(_metadata_table([
            ("Domain", _display(control.get("domain"))),
            ("Status", _humanize(control.get("status"))),
            ("Implementation", _percent(control.get("implementation_percentage"))),
        ], styles))
        notes = _text(control.get("notes"))
        if notes:
            story.append(_paragraph("<b>Notes</b>", styles["label"]))
            story.extend(_markdown_flowables(notes, styles, _bytes_mapping(payload.get("images"))))
        evidence = _list_of_mappings(control.get("evidence"))
        if evidence:
            story.append(_paragraph("<b>Evidence references</b>", styles["label"]))
            story.append(_evidence_table(evidence, styles))
        story.append(_spacer(8))

    evidence = _list_of_mappings(payload.get("evidence"))
    if evidence:
        story.append(_section_heading("Evidence register", styles, level=1))
        story.append(_evidence_table(evidence, styles))
    return _build_pdf(story, title, "Assessment report", payload, branding)


def render_campaign_pdf(payload: dict[str, Any]) -> bytes:
    """Render immutable policy campaign evidence, including its sign-off register."""
    title = _text(payload.get("title")) or "Policy campaign"
    branding = _branding(payload.get("branding"))
    story, styles = _document_opening(payload, title, "Policy campaign record", branding)
    story.extend(_metadata_table([
        ("Status", _humanize(payload.get("status"))),
        ("Sent", _format_date(payload.get("sent_date"))),
        ("Due", _format_date(payload.get("due_date"))),
        ("Policies", str(len(_list_of_mappings(payload.get("policies"))))),
    ], styles))
    story.append(_paragraph(
        "This export records the policy content and acknowledgement state captured for this campaign.",
        styles["callout"],
    ))
    story.append(_spacer(8))

    story.append(_section_heading("Sent policy content", styles, level=1))
    policies = _list_of_mappings(payload.get("policies"))
    if not policies:
        story.append(_paragraph("No policy snapshot was included in this campaign.", styles["body"]))
    for index, policy in enumerate(policies, start=1):
        policy_title = _text(policy.get("title")) or "Untitled policy"
        story.append(_section_heading(f"{index}. {policy_title}", styles, level=2))
        story.extend(_metadata_table([("Version", _display(policy.get("version")))], styles))
        images = _bytes_mapping(payload.get("images"))
        images.update(_bytes_mapping(policy.get("images")))
        story.extend(_markdown_flowables(_text(policy.get("content")), styles, images))

    story.append(_section_heading("Acknowledgement register", styles, level=1))
    people = _list_of_mappings(payload.get("people"))
    if people:
        rows = [[
            _paragraph("Person", styles["table_header"]),
            _paragraph("Status", styles["table_header"]),
            _paragraph("Accepted", styles["table_header"]),
            _paragraph("Waiver reason", styles["table_header"]),
        ]]
        for person in people:
            name = _display(person.get("name"))
            email = _text(person.get("email"))
            rows.append([
                _paragraph(escape(name) + (f"<br/><font color='{MUTED}'>{escape(email)}</font>" if email else ""), styles["table_cell"]),
                _paragraph(escape(_humanize(person.get("status"))), styles["table_cell"]),
                _paragraph(escape(_format_date(person.get("accepted_at"))), styles["table_cell"]),
                _paragraph(escape(_display(person.get("waiver_reason"))), styles["table_cell"]),
            ])
        story.append(_table(rows, [150, 85, 90, 155], repeat_rows=1, branding=branding))
    else:
        story.append(_paragraph("No recipient acknowledgements were included in this export.", styles["body"]))
    return _build_pdf(story, title, "Policy campaign record", payload, branding)


def _document_opening(payload: dict[str, Any], title: str, document_kind: str, branding: _Branding) -> tuple[list[Any], dict[str, Any]]:
    styles = _styles(branding)
    story: list[Any] = [
        _paragraph(escape(_text(payload.get("organization_name")) or "Organization"), styles["organization"]),
        _paragraph(escape(title), styles["title"]),
        _paragraph(escape(document_kind), styles["subtitle"]),
    ]
    if payload.get("sample"):
        story.append(_paragraph("SAMPLE — illustrative data", styles["sample"]))
    story.append(_spacer(12))
    return story, styles


def _fact_notice_flowables(payload: dict[str, Any], styles: dict[str, Any]) -> list[Any]:
    notice = _fact_notice_markup(payload)
    return [_paragraph(notice, styles["callout"]), _spacer(8)] if notice else []


def _fact_notice_markup(payload: dict[str, Any]) -> str:
    """Return a compact, escaped notice for facts that need review in an export."""
    unresolved = _fact_values(payload.get("unresolved_fact_keys"))
    conflicts = _fact_values(payload.get("fact_scope_conflicts"))
    parts: list[str] = []
    if unresolved:
        parts.append("Unresolved facts: " + ", ".join(escape(value) for value in unresolved))
    if conflicts:
        parts.append("Scope conflicts: " + ", ".join(escape(value) for value in conflicts))
    return "<b>Review required</b><br/>" + "<br/>".join(parts) if parts else ""


def _fact_values(value: Any) -> list[str]:
    values = value if isinstance(value, (list, tuple, set)) else [value]
    output: list[str] = []
    for item in values:
        if isinstance(item, dict):
            item = item.get("label") or item.get("key") or item.get("fact_key") or item.get("name")
        text = _text(item)
        if text:
            output.append(text)
    return output


def _branding(value: Any) -> _Branding:
    """Normalize per-export branding without fetching files or sharing state."""
    source = _mapping(value)
    primary = _valid_hex_color(source.get("primary_color")) or DEFAULT_PRIMARY_COLOR
    name = _truncate(_text(source.get("name")), 80) if "name" in source else "BIFROST GRC"
    logo = _logo_image(source.get("logo_base64"))
    return _Branding(
        name=name,
        primary_color=primary,
        accent_color=_dark_accent(primary),
        tint_color=_pale_tint(primary),
        header_text_color="#FFFFFF",
        logo_bytes=logo[0] if logo else None,
        logo_width=logo[1] if logo else 0,
        logo_height=logo[2] if logo else 0,
    )


def _valid_hex_color(value: Any) -> str | None:
    text = _text(value)
    return text.upper() if re.fullmatch(r"#[0-9A-Fa-f]{6}", text) else None


def _dark_accent(color: str) -> str:
    """Darken a configured color until white text has at least 4.5:1 contrast."""
    if _contrast_ratio(color, "#FFFFFF") >= 4.5:
        return color
    red, green, blue = _rgb(color)
    for factor in (0.78, 0.68, 0.58, 0.48, 0.38, 0.28):
        candidate = _hex((round(red * factor), round(green * factor), round(blue * factor)))
        if _contrast_ratio(candidate, "#FFFFFF") >= 4.5:
            return candidate
    return "#17252A"


def _pale_tint(color: str) -> str:
    red, green, blue = _rgb(color)
    return _hex((round(red + (255 - red) * 0.90), round(green + (255 - green) * 0.90), round(blue + (255 - blue) * 0.90)))


def _rgb(color: str) -> tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{max(0, min(255, component)):02X}" for component in rgb)


def _contrast_ratio(first: str, second: str) -> float:
    def luminance(color: str) -> float:
        channels = []
        for channel in _rgb(color):
            normalized = channel / 255
            channels.append(normalized / 12.92 if normalized <= 0.04045 else ((normalized + 0.055) / 1.055) ** 2.4)
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]

    light, dark = sorted((luminance(first), luminance(second)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def _logo_image(value: Any) -> tuple[bytes, int, int] | None:
    """Decode a bounded embedded PNG/JPEG logo, never a path or URL."""
    if not isinstance(value, str) or not value or len(value) > (MAX_LOGO_BYTES * 4 // 3) + 8:
        return None
    try:
        blob = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not blob or len(blob) > MAX_LOGO_BYTES or not (blob.startswith(b"\x89PNG\r\n\x1a\n") or blob.startswith(b"\xff\xd8\xff")):
        return None
    try:
        from reportlab.lib.utils import ImageReader

        reader = ImageReader(io.BytesIO(blob))
        width, height = reader.getSize()
        if not (0 < width <= 4096 and 0 < height <= 4096):
            return None
        reader.getRGBData()
    except Exception:
        return None
    return blob, width, height


def _logo_box(width: int, height: int) -> tuple[float, float]:
    """Fit a supplied logo in restrained page chrome without changing its aspect."""
    if width <= 0 or height <= 0:
        return 0, 0
    scale = min(70 / width, 20 / height)
    return width * scale, height * scale


def _styles(branding: _Branding) -> dict[str, Any]:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

    regular, bold, italic = _font_names()
    base = getSampleStyleSheet()
    return {
        "organization": ParagraphStyle("grc_organization", parent=base["BodyText"], fontName=bold, fontSize=9, leading=12, textColor=colors.HexColor(branding.accent_color), spaceAfter=4),
        "title": ParagraphStyle("grc_title", parent=base["Title"], fontName=bold, fontSize=21, leading=25, textColor=colors.HexColor(DEFAULT_DARK), spaceAfter=3),
        "subtitle": ParagraphStyle("grc_subtitle", parent=base["BodyText"], fontName=regular, fontSize=10, leading=14, textColor=colors.HexColor(MUTED), spaceAfter=0),
        "sample": ParagraphStyle("grc_sample", parent=base["BodyText"], fontName=bold, fontSize=8, leading=11, textColor=colors.HexColor(MUTED), spaceBefore=4),
        "body": ParagraphStyle("grc_body", parent=base["BodyText"], fontName=regular, fontSize=9.5, leading=14, textColor=colors.HexColor(DEFAULT_DARK), spaceAfter=7, wordWrap="CJK"),
        "h1": ParagraphStyle("grc_h1", parent=base["Heading1"], fontName=bold, fontSize=15, leading=19, textColor=colors.HexColor(DEFAULT_DARK), spaceBefore=15, spaceAfter=7, keepWithNext=True),
        "h2": ParagraphStyle("grc_h2", parent=base["Heading2"], fontName=bold, fontSize=11.5, leading=15, textColor=colors.HexColor(branding.accent_color), spaceBefore=11, spaceAfter=5, keepWithNext=True),
        "h3": ParagraphStyle("grc_h3", parent=base["Heading3"], fontName=bold, fontSize=10, leading=13, textColor=colors.HexColor(DEFAULT_DARK), spaceBefore=9, spaceAfter=4, keepWithNext=True),
        "label": ParagraphStyle("grc_label", parent=base["BodyText"], fontName=bold, fontSize=8.5, leading=11, textColor=colors.HexColor(MUTED), spaceBefore=5, spaceAfter=3),
        "table_header": ParagraphStyle("grc_table_header", parent=base["BodyText"], fontName=bold, fontSize=8, leading=10, textColor=colors.white, wordWrap="CJK"),
        "table_cell": ParagraphStyle("grc_table_cell", parent=base["BodyText"], fontName=regular, fontSize=8, leading=10.5, textColor=colors.HexColor(DEFAULT_DARK), wordWrap="CJK"),
        "table_label": ParagraphStyle("grc_table_label", parent=base["BodyText"], fontName=bold, fontSize=8, leading=10.5, textColor=colors.HexColor(DEFAULT_DARK), wordWrap="CJK"),
        "callout": ParagraphStyle("grc_callout", parent=base["BodyText"], fontName=regular, fontSize=9, leading=13, textColor=colors.HexColor(DEFAULT_DARK), backColor=colors.HexColor(branding.tint_color), borderColor=colors.HexColor(branding.accent_color), borderWidth=0.4, borderPadding=7, wordWrap="CJK"),
        "list": ParagraphStyle("grc_list", parent=base["BodyText"], fontName=regular, fontSize=9.5, leading=14, leftIndent=15, firstLineIndent=-10, bulletIndent=0, textColor=colors.HexColor(DEFAULT_DARK), spaceAfter=3, wordWrap="CJK", alignment=TA_LEFT),
        "branding": branding,
        "italic": italic,
    }


def _font_names() -> tuple[str, str, str]:
    """Register a local Unicode-capable TTF, preferring DejaVu when present."""
    from reportlab import __file__ as reportlab_file
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if "GrcPdf" in pdfmetrics.getRegisteredFontNames():
        return "GrcPdf", "GrcPdf-Bold", "GrcPdf-Italic"
    reportlab_fonts = Path(reportlab_file).parent / "fonts"
    candidates = [
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf")),
        (reportlab_fonts / "Vera.ttf", reportlab_fonts / "VeraBd.ttf", reportlab_fonts / "VeraIt.ttf"),
    ]
    for regular, bold, italic in candidates:
        if regular.is_file() and bold.is_file() and italic.is_file():
            pdfmetrics.registerFont(TTFont("GrcPdf", str(regular)))
            pdfmetrics.registerFont(TTFont("GrcPdf-Bold", str(bold)))
            pdfmetrics.registerFont(TTFont("GrcPdf-Italic", str(italic)))
            return "GrcPdf", "GrcPdf-Bold", "GrcPdf-Italic"
    raise RuntimeError("GRC PDF rendering requires a Unicode TrueType font (DejaVu Sans or ReportLab Vera).")


def _markdown_flowables(markdown: str, styles: dict[str, Any], images: dict[str, bytes] | None = None) -> list[Any]:
    from reportlab.platypus import ListFlowable, ListItem

    if not markdown.strip():
        return [_paragraph("No content was provided.", styles["body"])]
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    flow: list[Any] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        image = _image_line(stripped)
        if image:
            alt, source = image
            item = _authorized_image(source, images or {})
            if item is None:
                flow.append(_paragraph(f"<i>Image reference: {escape(alt or source)}</i>", styles["body"]))
            else:
                flow.extend([item, _spacer(7)])
            index += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", stripped)
        if heading:
            level = min(len(heading.group(1)), 3)
            flow.append(_section_heading(heading.group(2), styles, level))
            index += 1
            continue
        if _is_table_start(lines, index):
            table_lines: list[str] = []
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                table_lines.append(lines[index])
                index += 1
            flow.append(_markdown_table(table_lines, styles))
            flow.append(_spacer(7))
            continue
        if re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", line):
            items: list[Any] = []
            ordered = bool(re.match(r"^\s*\d+[.)]\s+", line))
            while index < len(lines):
                match = re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$", lines[index])
                if not match:
                    break
                items.append(ListItem(_paragraph(_inline_markup(match.group(1)), styles["body"])))
                index += 1
            flow.append(ListFlowable(items, bulletType="1" if ordered else "bullet", leftIndent=18, bulletFontName=_font_names()[0]))
            flow.append(_spacer(4))
            continue
        paragraph_lines = [stripped]
        index += 1
        while index < len(lines):
            candidate = lines[index].strip()
            if not candidate or _is_table_start(lines, index) or _image_line(candidate) or re.match(r"^(#{1,6})\s+|^\s*(?:[-*+]\s+|\d+[.)]\s+)", lines[index]):
                break
            paragraph_lines.append(candidate)
            index += 1
        flow.append(_paragraph(_inline_markup(" ".join(paragraph_lines)), styles["body"]))
    return flow


def _is_table_start(lines: list[str], index: int) -> bool:
    return index + 1 < len(lines) and "|" in lines[index] and bool(re.match(r"^\s*\|?\s*:?-{3,}", lines[index + 1]))


def _markdown_table(lines: list[str], styles: dict[str, Any]) -> Any:
    rows: list[list[Any]] = []
    for line_index, line in enumerate(lines):
        if line_index == 1 and re.match(r"^\s*\|?\s*:?-{3,}", line):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not cells:
            continue
        style = styles["table_header"] if not rows else styles["table_cell"]
        rows.append([_paragraph(_inline_markup(cell), style) for cell in cells])
    if not rows:
        return _paragraph("", styles["body"])
    width = 480 / max(1, max(len(row) for row in rows))
    return _table(rows, [width] * max(len(row) for row in rows), repeat_rows=1, branding=styles["branding"])


def _metadata_table(items: Iterable[tuple[str, str]], styles: dict[str, Any]) -> list[Any]:
    visible = [(label, value) for label, value in items if value != "—"]
    if not visible:
        return []
    rows = [[_paragraph(escape(label), styles["label"]), _paragraph(escape(value), styles["table_cell"])] for label, value in visible]
    return [_table(rows, [120, 360], branding=styles["branding"]), _spacer(8)]


def _evidence_table(evidence: list[dict[str, Any]], styles: dict[str, Any]) -> Any:
    rows = [[
        _paragraph("Evidence", styles["table_header"]),
        _paragraph("Reference", styles["table_header"]),
        _paragraph("Notes", styles["table_header"]),
    ]]
    for item in evidence:
        rows.append([
            _paragraph(escape(_display(item.get("name"))), styles["table_cell"]),
            _paragraph(escape(_display(item.get("reference"))), styles["table_cell"]),
            _paragraph(escape(_display(item.get("notes"))), styles["table_cell"]),
        ])
    return _table(rows, [180, 100, 200], repeat_rows=1, branding=styles["branding"])


def _table(rows: list[list[Any]], widths: list[float], repeat_rows: int = 0, branding: _Branding | None = None) -> Any:
    from reportlab.lib import colors
    from reportlab.platypus import LongTable, TableStyle

    palette = branding or _branding(None)
    table = LongTable(rows, colWidths=widths, repeatRows=repeat_rows, hAlign="LEFT", splitByRow=1, splitInRow=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(palette.accent_color) if repeat_rows else colors.HexColor(PALE_GRAY)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor(palette.header_text_color) if repeat_rows else colors.HexColor(DEFAULT_DARK)),
        ("FONTNAME", (0, 0), (-1, -1), _font_names()[0]),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor(RULE)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def _build_pdf(story: list[Any], title: str, document_kind: str, payload: dict[str, Any], branding: _Branding) -> bytes:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.units import inch
        from reportlab.platypus import SimpleDocTemplate
    except ModuleNotFoundError as exc:
        raise RuntimeError("GRC PDF rendering requires the 'reportlab' dependency.") from exc

    buffer = io.BytesIO()
    regular, bold, _ = _font_names()
    organization = _text(payload.get("organization_name")) or "Organization"
    generated = _format_date(payload.get("generated_at"))

    def decorate_page(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor(branding.accent_color))
        canvas.setLineWidth(1.2)
        canvas.line(doc.leftMargin, LETTER[1] - 0.46 * inch, LETTER[0] - doc.rightMargin, LETTER[1] - 0.46 * inch)
        canvas.setFont(bold, 8)
        canvas.setFillColor(colors.HexColor(branding.accent_color))
        name_x = doc.leftMargin
        if branding.logo_bytes:
            try:
                from reportlab.lib.utils import ImageReader

                logo_width, logo_height = _logo_box(branding.logo_width, branding.logo_height)
                canvas.drawImage(
                    ImageReader(io.BytesIO(branding.logo_bytes)),
                    doc.leftMargin,
                    LETTER[1] - 0.425 * inch,
                    width=logo_width,
                    height=logo_height,
                    preserveAspectRatio=True,
                    anchor="c",
                    mask="auto",
                )
                name_x += logo_width + 5
            except Exception:
                pass
        if branding.name:
            canvas.drawString(name_x, LETTER[1] - 0.34 * inch, _truncate(branding.name, 46))
        canvas.setFont(regular, 7.5)
        canvas.setFillColor(colors.HexColor(MUTED))
        canvas.drawRightString(LETTER[0] - doc.rightMargin, LETTER[1] - 0.34 * inch, _truncate(f"{organization} · {document_kind}", 86))
        canvas.setStrokeColor(colors.HexColor(RULE))
        canvas.setLineWidth(0.45)
        canvas.line(doc.leftMargin, 0.46 * inch, LETTER[0] - doc.rightMargin, 0.46 * inch)
        canvas.setFont(regular, 7)
        canvas.setFillColor(colors.HexColor(MUTED))
        footer = "Confidential" + (f" · Generated {generated}" if generated != "—" else "")
        canvas.drawString(doc.leftMargin, 0.32 * inch, footer)
        canvas.drawRightString(LETTER[0] - doc.rightMargin, 0.32 * inch, f"Page {canvas.getPageNumber()}")
        canvas.setTitle(title)
        canvas.setAuthor(branding.name or "GRC")
        canvas.restoreState()

    document = SimpleDocTemplate(
        buffer,
        pagesize=LETTER,
        leftMargin=0.72 * inch,
        rightMargin=0.72 * inch,
        topMargin=0.72 * inch,
        bottomMargin=0.68 * inch,
        title=title,
        author=branding.name or "GRC",
    )
    document.build(story, onFirstPage=decorate_page, onLaterPages=decorate_page)
    return buffer.getvalue()


def _section_heading(text: str, styles: dict[str, Any], level: int) -> Any:
    return _paragraph(_inline_markup(text), styles[f"h{level}"])


def _paragraph(markup: str, style: Any) -> Any:
    from reportlab.platypus import Paragraph

    return Paragraph(markup or "&nbsp;", style)


def _spacer(height: float) -> Any:
    from reportlab.platypus import Spacer

    return Spacer(1, height)


def _image_line(value: str) -> tuple[str, str] | None:
    match = re.fullmatch(r"!\[([^\]]*)\]\(([^)]+)\)", value)
    return (match.group(1), match.group(2).strip()) if match else None


def _authorized_image(source: str, images: dict[str, bytes]) -> Any | None:
    """Create a bounded image flowable only from bytes supplied by the caller.

    Markdown URLs are identifiers here, not fetch targets.  The workflow has already
    authorized and hydrated any managed attachment before it reaches this function.
    """
    blob = images.get(source)
    if not blob:
        return None
    try:
        from reportlab.lib.utils import ImageReader
        from reportlab.platypus import Image

        # Decode now so a corrupt attachment becomes the visible reference below
        # rather than failing the entire PDF while ReportLab draws a later page.
        ImageReader(io.BytesIO(blob)).getRGBData()
        image = Image(io.BytesIO(blob))
        image._restrictSize(440, 360)
        return image
    except Exception:
        return None


def _inline_markup(value: str) -> str:
    """Escape arbitrary text before applying the small ReportLab markup subset."""
    output = escape(value, quote=False)
    output = re.sub(r"`([^`]+)`", r"<font name='GrcPdf' backColor='#F0F3F3'>\1</font>", output)
    output = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda match: f"<b>{match.group(1) or match.group(2)}</b>", output)
    output = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)", lambda match: f"<i>{match.group(1) or match.group(2)}</i>", output)
    output = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda match: f"{match.group(1)} <font color='{MUTED}'>({match.group(2)})</font>",
        output,
    )
    return output


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list_of_mappings(value: Any) -> list[dict[str, Any]]:
    return [item for item in (value or []) if isinstance(item, dict)] if isinstance(value, list) else []


def _bytes_mapping(value: Any) -> dict[str, bytes]:
    """Accept only explicit image byte mappings; do not coerce paths or URLs."""
    if not isinstance(value, dict):
        return {}
    return {str(key): bytes(blob) for key, blob in value.items() if isinstance(blob, (bytes, bytearray, memoryview))}


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _display(value: Any) -> str:
    text = _text(value)
    return text if text else "—"


def _humanize(value: Any) -> str:
    text = _text(value)
    return text.replace("_", " ").replace("-", " ").title() if text else "—"


def _percent(value: Any) -> str:
    if value is None or value == "":
        return "—"
    try:
        number = float(value)
        return f"{number:g}%"
    except (TypeError, ValueError):
        return _display(value)


def _format_date(value: Any) -> str:
    if not value:
        return "—"
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = _text(value)
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return text


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"
