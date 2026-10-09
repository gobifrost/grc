"""Focused rendering tests for GRC export PDFs."""

from __future__ import annotations

import base64

from modules.grc_pdf import _branding, _contrast_ratio, _fact_notice_markup, _inline_markup, _logo_box, render_assessment_pdf, render_campaign_pdf, render_policy_pdf


def _page_count(pdf: bytes) -> int:
    """Count leaf page objects without adding a PDF-reader test dependency."""
    return pdf.count(b"/Type /Page\n")


def test_policy_pdf_handles_markdown_addenda_unicode_and_long_unbroken_content():
    pdf = render_policy_pdf({
        "organization_name": "Exemple Organisation — Montréal",
        "title": "Information Security Policy",
        "version": "2.4",
        "status": "Active",
        "effective_date": "2026-10-05",
        "owner": "Anaïs O'Connor",
        "content": """# Purpose

This policy protects customer information. <untrusted markup> must remain text.

## Required practices

- Use approved tools for business data.
- Report a suspected incident immediately.

| Requirement | Owner | Evidence |
| --- | --- | --- |
| MFA | IT | Access review |
| Encryption | Operations | Device baseline |

""" + ("verylongtokenwithoutspaces" * 70),
        "addenda": [{
            "title": "Customer Addendum",
            "version": "1.0",
            "effective_date": "2026-10-05",
            "content": "## Customer data\n\nDo not send customer data to unapproved services.",
        }],
    })

    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 3_000
    assert _page_count(pdf) >= 2


def test_assessment_and_campaign_pdfs_render_structured_summaries_without_invalid_markup():
    assessment = render_assessment_pdf({
        "organization_name": "Example Organization",
        "title": "2026 Security Assessment",
        "framework_name": "CIS Controls v8",
        "status": "in_progress",
        "assessment_date": "2026-10-05",
        "owner": "Risk & Compliance",
        "progress_percentage": 67,
        "summary": {"total": 3, "compliant": 1, "partially_compliant": 1, "non_compliant": 1},
        "controls": [{
            "identifier": "IG1-01",
            "title": "Inventory and Control of Enterprise Assets",
            "domain": "Asset Management",
            "status": "partially_compliant",
            "implementation_percentage": 65,
            "notes": "Asset inventory is reviewed quarterly. <source is a note, not markup>",
            "evidence": [{"name": "Asset register", "reference": "EVD-001", "notes": "Reviewed 2026-09-30"}],
        }],
        "evidence": [{"name": "MFA configuration export", "reference": "EVD-002", "notes": "Current configuration"}],
    })
    campaign = render_campaign_pdf({
        "organization_name": "Example Organization",
        "title": "Security Policy Acknowledgement",
        "status": "closed",
        "sent_date": "2026-09-01",
        "due_date": "2026-09-15",
        "policies": [{"title": "Information Security Policy", "version": "2.4", "content": "# Scope\n\nAll staff must acknowledge this policy."}],
        "people": [{"name": "Ada Lovelace", "email": "ada@example.test", "status": "signed", "accepted_at": "2026-09-02"}],
    })

    for pdf in (assessment, campaign):
        assert pdf.startswith(b"%PDF-")
        assert len(pdf) > 2_000
        assert _page_count(pdf) >= 1


def test_policy_pdf_embeds_authorized_markdown_images_and_labels_missing_references():
    # A 2:1 PNG verifies that a byte-backed image source can be fitted without
    # relying on a filesystem path or a browser fetch.
    image_bytes = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADklEQVR4nGP4zwAE/xkACP8B/0AhLC4AAAAASUVORK5CYII="
    )
    source = "bifrost-policy-file://policy-42/architecture.png"
    pdf = render_policy_pdf({
        "organization_name": "Example Organization",
        "title": "Illustrated Policy",
        "content": f"# Diagram\n\n![Security architecture]({source})\n\n![Unavailable](https://example.test/image.png)",
        "images": {source: image_bytes},
    })
    unresolved_pdf = render_policy_pdf({
        "organization_name": "Example Organization",
        "title": "Illustrated Policy",
        "content": f"# Diagram\n\n![Security architecture]({source})\n\n![Unavailable](https://example.test/image.png)",
    })

    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > len(unresolved_pdf) + 300
    assert _page_count(pdf) >= 1


def test_renderer_escapes_record_metadata_preserves_link_references_and_splits_long_register_rows():
    unsafe = '<img src="https://example.test/tracker.png">'
    assessment = render_assessment_pdf({
        "organization_name": "Example Organization",
        "title": "Assessment",
        "summary": {"total": 1},
        "evidence": [{"name": unsafe, "reference": unsafe, "notes": unsafe}],
    })
    campaign = render_campaign_pdf({
        "organization_name": "Example Organization",
        "title": "Campaign",
        "people": [{"name": unsafe, "status": unsafe, "waiver_reason": "unbroken" * 1_500}],
    })

    assert assessment.startswith(b"%PDF-")
    assert campaign.startswith(b"%PDF-")
    assert _page_count(campaign) >= 2
    assert "https://example.test/reference" in _inline_markup("[Reference](https://example.test/reference)")


def test_fact_scope_notices_identify_unresolved_and_conflicting_export_facts():
    notice = _fact_notice_markup({
        "unresolved_fact_keys": ["primary_contact", "retention_period"],
        "fact_scope_conflicts": [{"key": "security_owner"}, "asset inventory"],
    })

    assert "Unresolved facts" in notice
    assert "primary_contact" in notice
    assert "Scope conflicts" in notice
    assert "security_owner" in notice


def test_branding_uses_valid_embedded_png_and_falls_back_for_invalid_values():
    logo_base64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADklEQVR4nGP4zwAE/xkACP8B/0AhLC4AAAAASUVORK5CYII="
    branding = _branding({
        "name": "Bifrost GRC",
        "primary_color": "#0D577A",
        "logo_base64": logo_base64,
    })

    assert branding.name == "Bifrost GRC"
    assert branding.primary_color == "#0D577A"
    assert branding.logo_bytes
    assert (branding.logo_width, branding.logo_height) == (2, 1)
    assert branding.accent_color == branding.primary_color
    assert branding.header_text_color == "#FFFFFF"

    pale = _branding({"primary_color": "#FFFFCC"})
    assert _contrast_ratio(pale.accent_color, pale.header_text_color) >= 4.5

    fallback = _branding({"name": "", "primary_color": "teal", "logo_base64": base64.b64encode(b"not an image").decode()})
    assert fallback.name == ""
    assert fallback.primary_color == "#006B73"
    assert fallback.logo_bytes is None

    rectangle_width, rectangle_height = _logo_box(800, 230)
    assert 69 <= rectangle_width <= 70
    assert rectangle_height == 20
    assert _logo_box(1024, 1024) == (20, 20)

    for render in (render_policy_pdf, render_assessment_pdf, render_campaign_pdf):
        pdf = render({"organization_name": "Example Organization", "title": "Branded export", "branding": {
            "name": "Bifrost GRC", "primary_color": "#0D577A", "logo_base64": logo_base64,
        }})
        assert pdf.startswith(b"%PDF-")
