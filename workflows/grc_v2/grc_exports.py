"""Authorization-bound, in-memory PDF exports for GRC records."""

from __future__ import annotations

import base64
import json
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote

from bifrost import UserError, context, files, organizations, tables, workflow

from functions.grc_auth import caller_organization_id, is_platform_scope, require_organization_access
from functions.grc_policy_acceptance import is_genuine_policy_acceptance
from functions.grc_scope import applies_to_organization, effective_control
from modules.grc_pdf import render_assessment_pdf, render_campaign_pdf, render_policy_pdf
from workflows.grc_v2.grc_agent_tools import _resolve_fact_markers, _resolved_facts
from workflows.grc_v2.grc_policy_admin import _admin_org
from workflows.grc_v2.grc_policy_recipient import _recipient_context


TABLE_POLICIES = "grc-policies"
TABLE_CAMPAIGNS = "grc-policy-campaigns"
TABLE_ASSIGNMENTS = "grc-policy-campaign-assignments"
TABLE_ACCEPTANCES = "grc-policy-acceptances"
TABLE_ASSESSMENTS = "grc-assessments"
TABLE_ASSESSMENT_CONTROLS = "grc-assessment-controls"
TABLE_ASSESSMENT_CONTROL_OVERRIDES = "grc-assessment-control-overrides"
TABLE_CONTROLS = "grc-controls"
TABLE_DOMAINS = "grc-domains"
TABLE_FRAMEWORKS = "grc-frameworks"
TABLE_EVIDENCE = "grc-evidence"
TABLE_EVIDENCE_LINKS = "grc-evidence-links"
TABLE_POLICY_LINKS = "grc-policy-links"
TABLE_EXCEPTION_LINKS = "grc-exception-links"
TABLE_APPLIED_CONTROLS = "grc-applied-controls"
TABLE_CONTROL_MAPPINGS = "grc-control-mappings"
TABLE_EXCEPTIONS = "grc-exceptions"
POLICY_FILE_LOCATION = "grc-policy-files"
_POLICY_IMAGE_RE = re.compile(r"bifrost-policy-file://([^/]+)/([^\s)]+)")


def _row(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        return {
            "id": str(raw.get("id") or data.get("id") or ""),
            "created_at": raw.get("created_at") or data.get("created_at"),
            "updated_at": raw.get("updated_at") or data.get("updated_at"),
            **data,
        }
    data = dict(getattr(raw, "data", None) or {})
    return {
        "id": str(getattr(raw, "id", data.get("id") or "")),
        "created_at": getattr(raw, "created_at", data.get("created_at", None)),
        "updated_at": getattr(raw, "updated_at", data.get("updated_at", None)),
        **data,
    }


async def _query_rows(table: str, where: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while offset < 10_000:
        result = await tables.query(table, where=where or {}, limit=1000, offset=offset)
        page = [_row(document) for document in getattr(result, "documents", [])]
        rows.extend(row for row in page if row)
        if len(page) < 1000:
            return rows
        offset += len(page)
    raise UserError(f"{table} exceeds the safe PDF export read limit.")


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if not value:
        return []
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _effective_policy_content(base: dict[str, Any] | None, extension: dict[str, Any]) -> str:
    if not base:
        return str(extension.get("content") or "")
    base_content = str(base.get("content") or "").strip()
    extension_content = re.sub(r"^\s*#\s+[^\n]+\n+", "", str(extension.get("content") or "").strip())
    return "\n\n".join(part for part in (base_content, "---", "## Customer addendum", extension_content) if part)


def _safe_filename(value: Any, fallback: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", str(value or "").casefold()).strip("-")
    return name or fallback


def _export_branding(branding: dict[str, Any] | None) -> dict[str, str]:
    """Accept bounded presentation data; record scope never comes from branding."""
    if not isinstance(branding, dict):
        return {"name": ""}
    # Export the configured logo and colors without the platform application name.
    result = {"name": ""}
    color = branding.get("primary_color")
    if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        result["primary_color"] = color
    logo = branding.get("logo_base64")
    if isinstance(logo, str) and len(logo) <= 1_400_000:
        result["logo_base64"] = logo
    return result


def _pdf_result(pdf: bytes, filename: str) -> dict[str, str]:
    if not isinstance(pdf, bytes) or not pdf:
        raise UserError("PDF renderer did not return document bytes.")
    return {
        "content_base64": base64.b64encode(pdf).decode("ascii"),
        "filename": filename,
        "content_type": "application/pdf",
    }


def _context_organization_name(organization_id: str) -> str | None:
    organization = getattr(context, "organization", None)
    if str(getattr(context, "org_id", "") or "") != organization_id:
        return None
    return str(getattr(organization, "name", None) or "") or None


async def _organization_name(organization_id: str) -> str:
    from_context = _context_organization_name(organization_id)
    if from_context:
        return from_context
    organization = await organizations.get(organization_id)
    return str(
        getattr(organization, "name", None)
        or (organization.get("name") if isinstance(organization, dict) else "")
        or organization_id
    )


async def _authorize_admin_export(organization_id: str | None, *, resource: str) -> str:
    target = require_organization_access(organization_id or caller_organization_id(), resource=resource)
    return await _admin_org(target, read_only=True)


def _requested_organization_id(organization_id: str | None, *, resource: str) -> str | None:
    requested = str(organization_id or "").strip()
    if requested:
        return requested
    if is_platform_scope():
        return None
    target = str(caller_organization_id() or "").strip()
    if not target:
        raise UserError(f"organization_id is required to export {resource}.")
    return target


async def _effective_policy(policy_id: str, organization_id: str | None) -> tuple[dict[str, Any], dict[str, Any] | None]:
    policy = _row(await tables.get(TABLE_POLICIES, policy_id))
    if not policy or (organization_id and not applies_to_organization(policy, organization_id)):
        raise UserError("Policy is not available to this organization.")
    all_policies = await _query_rows(TABLE_POLICIES)
    if policy.get("policy_role") == "extension":
        base = next((
            row for row in all_policies
            if row.get("id") == str(policy.get("base_policy_id") or "")
            and (not organization_id or applies_to_organization(row, organization_id))
        ), None)
        if not base:
            raise UserError("The extension's parent policy is unavailable to this organization.")
        return policy, base
    extensions = [
        row for row in all_policies
        if row.get("policy_role") == "extension"
        and str(row.get("base_policy_id") or "") == policy["id"]
        and row.get("status") in {"active", "draft"}
        and organization_id
        and applies_to_organization(row, organization_id)
    ]
    if len(extensions) > 1:
        raise UserError("Policy has multiple applicable addenda; resolve the duplicate extensions before exporting.")
    extension = extensions[0] if extensions else None
    return (extension or policy), (policy if extension else None)


def _evidence_summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": row.get("name"),
        "reference": row.get("url") or row.get("file_path") or next(
            (str(item.get("path") or item.get("url") or "") for item in _json_list(row.get("attachments_json")) if isinstance(item, dict)),
            None,
        ),
        "notes": row.get("notes_markdown") or row.get("notes"),
    }


def _dedupe_summaries(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str]] = set()
    output: list[dict[str, Any]] = []
    for row in rows:
        key = tuple(str(row.get(field) or "") for field in ("name", "reference", "notes"))
        if key not in seen:
            seen.add(key)
            output.append(row)
    return output


async def _policy_images(content: str, policies: list[dict[str, Any] | None]) -> dict[str, bytes]:
    """Read only image paths recorded on the policy that owns their URI."""
    by_id = {str(policy.get("id")): policy for policy in policies if policy and policy.get("id")}
    images: dict[str, bytes] = {}
    for match in _POLICY_IMAGE_RE.finditer(content or ""):
        source = match.group(0)
        policy_id = str(match.group(1))
        path = unquote(match.group(2))
        policy = by_id.get(policy_id)
        if not policy:
            continue
        attachments = _json_list(policy.get("attachments_json"))
        attachment = next((
            item for item in attachments
            if isinstance(item, dict)
            and str(item.get("path") or "") == path
            and str(item.get("kind") or "") == "image"
        ), None)
        if not attachment:
            continue
        try:
            content_bytes = await files.read_bytes(
                path,
                location=POLICY_FILE_LOCATION,
                scope=policy.get("organization_id") or None,
            )
        except Exception:
            continue
        if isinstance(content_bytes, bytes):
            images[source] = content_bytes
    return images


@workflow(
    name="grc_v2_export_policy_pdf",
    description="Return an authorized effective GRC policy PDF as base64 document bytes.",
    category="grc",
)
async def grc_v2_export_policy_pdf(policy_id: str, organization_id: str | None = None, branding: dict[str, Any] | None = None) -> dict[str, str]:
    target = _requested_organization_id(organization_id, resource="a policy")
    await _authorize_admin_export(target, resource="policy export")
    policy, base = await _effective_policy(str(policy_id or ""), target)
    fact_target = target or caller_organization_id()
    definitions, facts, conflicts = await _resolved_facts(str(fact_target or ""))
    base_content, base_unresolved = _resolve_fact_markers(str((base.get("content") if base else policy.get("content")) or ""), definitions, facts)
    addendum_content, addendum_unresolved = _resolve_fact_markers(str(policy.get("content") or ""), definitions, facts)
    is_addendum = base is not None
    rendered_title = base.get("name") if base else policy.get("name")
    payload = {
        "organization_name": await _organization_name(target or str(caller_organization_id() or "")),
        "title": rendered_title,
        "version": base.get("version") if base else policy.get("version"),
        "status": policy.get("status"),
        "effective_date": (base or policy).get("effective_date") or (base or policy).get("review_date"),
        "owner": policy.get("owner"),
        "scope_label": (f"Effective for {await _organization_name(target)}" if target else "Portfolio view"),
        "content": base_content,
        "addenda": ([{
            "title": policy.get("name"), "version": policy.get("version"),
            "effective_date": policy.get("effective_date") or policy.get("review_date"), "content": addendum_content,
        }] if is_addendum else []),
        "unresolved_fact_keys": sorted(set(base_unresolved + addendum_unresolved)),
        "fact_scope_conflicts": sorted(key for key in set(base_unresolved + addendum_unresolved) if key in conflicts),
        "images": await _policy_images("\n".join((base_content, addendum_content)), [policy, base]),
        "generated_at": datetime.now(UTC).isoformat(),
    }
    payload["branding"] = _export_branding(branding)
    return _pdf_result(render_policy_pdf(payload), f"{_safe_filename(rendered_title, 'policy')}.pdf")


async def _assessment_payload(assessment_id: str, organization_id: str | None) -> dict[str, Any]:
    assessment = _row(await tables.get(TABLE_ASSESSMENTS, assessment_id))
    if not assessment or (organization_id and not applies_to_organization(assessment, organization_id)):
        raise UserError("Assessment is not available to this organization.")
    framework = _row(await tables.get(TABLE_FRAMEWORKS, str(assessment.get("framework_id") or "")))
    controls = await _query_rows(TABLE_ASSESSMENT_CONTROLS, {"assessment_id": assessment["id"]})
    overrides = {
        str(row.get("control_id")): row
        for row in await _query_rows(TABLE_ASSESSMENT_CONTROL_OVERRIDES, {
            "assessment_id": assessment["id"], "customer_organization_id": organization_id,
        })
    } if organization_id else {}
    control_rows = {row["id"]: row for row in await _query_rows(TABLE_CONTROLS) if row.get("id")}
    domain_rows = {row["id"]: row for row in await _query_rows(TABLE_DOMAINS) if row.get("id")}
    evidence = [
        row for row in await _query_rows(TABLE_EVIDENCE)
        if (not organization_id or applies_to_organization(row, organization_id))
        and (
            str(row.get("assessment_id") or "") == assessment["id"]
            or str(row.get("control_id") or "") in {str(control.get("control_id") or "") for control in controls}
        )
    ]
    evidence_by_control: dict[str, list[dict[str, Any]]] = {}
    assessment_evidence: list[dict[str, Any]] = []
    for row in evidence:
        summary = _evidence_summary(row)
        control_id = str(row.get("control_id") or "")
        if control_id:
            evidence_by_control.setdefault(control_id, []).append(summary)
        else:
            assessment_evidence.append(summary)

    mappings = [
        row for row in await _query_rows(TABLE_CONTROL_MAPPINGS, {"assessment_id": assessment["id"]})
        if not organization_id or applies_to_organization(row, organization_id)
    ]
    applied_controls = {
        row["id"]: row for row in await _query_rows(TABLE_APPLIED_CONTROLS)
        if row.get("id") and (not organization_id or applies_to_organization(row, organization_id))
    }
    mapped_applied_by_control: dict[str, set[str]] = {}
    for mapping in mappings:
        applied_id = str(mapping.get("applied_control_id") or "")
        control_id = str(mapping.get("control_id") or "")
        if applied_id in applied_controls and control_id:
            mapped_applied_by_control.setdefault(control_id, set()).add(applied_id)
    all_evidence = {row["id"]: row for row in await _query_rows(TABLE_EVIDENCE) if row.get("id")}
    evidence_links = [
        row for row in await _query_rows(TABLE_EVIDENCE_LINKS)
        if not organization_id or applies_to_organization(row, organization_id)
    ]
    policies_by_id = {row["id"]: row for row in await _query_rows(TABLE_POLICIES) if row.get("id")}
    policy_links = [row for row in await _query_rows(TABLE_POLICY_LINKS) if not organization_id or applies_to_organization(row, organization_id)]
    exceptions_by_id = {row["id"]: row for row in await _query_rows(TABLE_EXCEPTIONS) if row.get("id")}
    exception_links = [row for row in await _query_rows(TABLE_EXCEPTION_LINKS) if not organization_id or applies_to_organization(row, organization_id)]
    references_by_control: dict[str, list[dict[str, Any]]] = {}
    for result in controls:
        result_id = str(result.get("id") or "")
        control_id = str(result.get("control_id") or "")
        applied_ids = mapped_applied_by_control.get(control_id, set())
        targets = {("assessment_control", result_id), ("control", control_id)} | {("applied_control", value) for value in applied_ids}
        for link in evidence_links:
            if (str(link.get("target_type") or ""), str(link.get("target_id") or "")) not in targets:
                continue
            evidence_row = all_evidence.get(str(link.get("evidence_id") or ""))
            if not evidence_row or (organization_id and not applies_to_organization(evidence_row, organization_id)):
                continue
            summary = _evidence_summary(evidence_row)
            if link.get("citation"):
                summary["reference"] = link["citation"]
            evidence_by_control.setdefault(control_id, []).append(summary)
        for link in policy_links:
            if (str(link.get("target_type") or ""), str(link.get("target_id") or "")) not in targets:
                continue
            record = policies_by_id.get(str(link.get("policy_id") or ""))
            if record and (not organization_id or applies_to_organization(record, organization_id)):
                references_by_control.setdefault(control_id, []).append({
                    "name": f"Policy: {record.get('name') or record.get('id')}",
                    "reference": link.get("relationship"), "notes": record.get("description"),
                })
        for link in exception_links:
            if (str(link.get("target_type") or ""), str(link.get("target_id") or "")) not in targets:
                continue
            record = exceptions_by_id.get(str(link.get("exception_id") or ""))
            if record and (not organization_id or applies_to_organization(record, organization_id)):
                references_by_control.setdefault(control_id, []).append({
                    "name": f"Exception: {record.get('name') or record.get('id')}",
                    "reference": link.get("relationship"), "notes": record.get("description") or record.get("rationale"),
                })

    output_controls: list[dict[str, Any]] = []
    counts = {status: 0 for status in ("compliant", "partially_compliant", "non_compliant", "not_assessed", "not_applicable")}
    for result in controls:
        applied = effective_control(result, overrides.get(str(result.get("control_id") or "")))
        control = control_rows.get(str(result.get("control_id") or ""), {})
        domain = domain_rows.get(str(control.get("domain_id") or ""), {})
        status = str(applied.get("status") or "not_assessed")
        if status in counts:
            counts[status] += 1
        output_controls.append({
            "identifier": control.get("control_id") or result.get("control_id"),
            "title": control.get("title") or result.get("control_id"),
            "domain": domain.get("name"),
            "status": status,
            "implementation_percentage": applied.get("implementation_percentage"),
            "notes": applied.get("notes"),
            "evidence": _dedupe_summaries(
                evidence_by_control.get(str(result.get("control_id") or ""), [])
                + references_by_control.get(str(result.get("control_id") or ""), [])
            ),
        })
    output_controls.sort(key=lambda item: (str(item.get("domain") or ""), str(item.get("identifier") or "")))
    return {
        "organization_name": await _organization_name(organization_id or str(caller_organization_id() or "")),
        "scope_label": (f"Effective for {await _organization_name(organization_id)}" if organization_id else "Portfolio view"),
        "title": assessment.get("name"),
        "framework_name": framework.get("name"),
        "status": assessment.get("status"),
        "assessment_date": assessment.get("completed_at") or assessment.get("started_at"),
        "owner": assessment.get("assigned_to"),
        "progress_percentage": round(100 * counts["compliant"] / len(output_controls), 2) if output_controls else assessment.get("progress_percentage"),
        "summary": {"total": len(output_controls), **counts},
        "controls": output_controls,
        "evidence": _dedupe_summaries(assessment_evidence),
        "generated_at": datetime.now(UTC).isoformat(),
    }


@workflow(
    name="grc_v2_export_assessment_pdf",
    description="Return an authorized organization-lens GRC assessment PDF as base64 document bytes.",
    category="grc",
)
async def grc_v2_export_assessment_pdf(assessment_id: str, organization_id: str | None = None, branding: dict[str, Any] | None = None) -> dict[str, str]:
    target = _requested_organization_id(organization_id, resource="an assessment")
    await _authorize_admin_export(target, resource="assessment export")
    payload = await _assessment_payload(str(assessment_id or ""), target)
    payload["branding"] = _export_branding(branding)
    return _pdf_result(render_assessment_pdf(payload), f"{_safe_filename(payload.get('title'), 'assessment')}.pdf")


async def _campaign_payload(campaign: dict[str, Any], organization_id: str, *, assignments: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    metadata = _json_object(campaign.get("metadata_json"))
    sent_contents = _json_object(metadata.get("policy_contents"))
    versions = _json_object(campaign.get("policy_versions_json"))
    policy_ids = [str(value) for value in _json_list(campaign.get("policy_ids_json")) if str(value)]
    if not policy_ids or any(policy_id not in sent_contents for policy_id in policy_ids):
        raise UserError("Campaign has no complete sent policy content snapshot.")
    all_current_policies = {row["id"]: row for row in await _query_rows(TABLE_POLICIES) if row.get("id")}
    current_policies = {policy_id: all_current_policies[policy_id] for policy_id in policy_ids if policy_id in all_current_policies}
    policies = []
    for policy_id in policy_ids:
        current = current_policies.get(policy_id, {})
        sent_content = str(sent_contents[policy_id])
        readable_current = current if current and applies_to_organization(current, organization_id) else None
        base = all_current_policies.get(str((readable_current or {}).get("base_policy_id") or ""))
        readable_base = base if base and applies_to_organization(base, organization_id) else None
        policies.append({
            "title": (readable_current or {}).get("name") or policy_id,
            "version": versions.get(policy_id),
            "content": sent_content,
            "images": await _policy_images(sent_content, [readable_current, readable_base]),
        })
    rows = assignments if assignments is not None else await _query_rows(TABLE_ASSIGNMENTS, {
        "organization_id": organization_id, "campaign_id": campaign["id"],
    })
    assignments_by_id = {str(row.get("id") or ""): row for row in rows}
    acceptances = {
        str(row.get("assignment_id")): row for row in await _query_rows(TABLE_ACCEPTANCES, {
            "organization_id": organization_id, "campaign_id": campaign["id"],
        })
        if is_genuine_policy_acceptance(row, assignments_by_id.get(str(row.get("assignment_id") or "")), campaign)
    }
    people = []
    due_date = None
    if campaign.get("due_date"):
        try:
            due_date = datetime.fromisoformat(str(campaign["due_date"]).replace("Z", "+00:00")).date()
        except ValueError:
            due_date = None
    for assignment in rows:
        if assignment.get("status") in {"removed", "revoked", "superseded"}:
            continue
        assignment_metadata = _json_object(assignment.get("metadata_json"))
        acceptance = acceptances.get(str(assignment.get("id"))) or {}
        waived = assignment.get("status") == "waived"
        signed = bool(acceptance) and not waived
        status = "waived" if waived else "signed" if signed else "overdue" if due_date and due_date < datetime.now(UTC).date() else "not_signed"
        people.append({
            "name": assignment.get("actor_display_name") or assignment.get("actor_email"),
            "email": assignment.get("actor_email"),
            "status": status,
            "accepted_at": acceptance.get("accepted_at"),
            "waiver_reason": assignment_metadata.get("waiver_reason"),
        })
    people.sort(key=lambda item: (str(item.get("name") or "").casefold(), str(item.get("email") or "")))
    return {
        "organization_name": await _organization_name(organization_id),
        "title": campaign.get("title"),
        "status": campaign.get("status"),
        "sent_date": campaign.get("created_at"),
        "due_date": campaign.get("due_date"),
        "policies": policies,
        "people": people,
        "generated_at": datetime.now(UTC).isoformat(),
    }


@workflow(
    name="grc_v2_export_campaign_pdf",
    description="Return an authorized policy campaign sign-off evidence PDF from sent snapshots.",
    category="grc",
)
async def grc_v2_export_campaign_pdf(campaign_id: str, branding: dict[str, Any] | None = None) -> dict[str, str]:
    campaign = _row(await tables.get(TABLE_CAMPAIGNS, str(campaign_id or "")))
    if not campaign:
        raise UserError("Campaign not found.")
    campaign_organization_id = require_organization_access(
        campaign.get("organization_id"), resource="policy campaign export",
    )
    organization_id = await _authorize_admin_export(campaign_organization_id, resource="policy campaign export")
    payload = await _campaign_payload(campaign, organization_id)
    payload["branding"] = _export_branding(branding)
    return _pdf_result(render_campaign_pdf(payload), f"{_safe_filename(campaign.get('title'), 'policy-campaign')}.pdf")


@workflow(
    name="grc_v2_export_my_policy_assignment_pdf",
    description="Return the authenticated recipient's assigned sent-policy PDF without managed-file writes.",
    category="grc",
)
async def grc_v2_export_my_policy_assignment_pdf(assignment_id: str, branding: dict[str, Any] | None = None) -> dict[str, str]:
    organization_id, actor = _recipient_context()
    assignment = _row(await tables.get(TABLE_ASSIGNMENTS, str(assignment_id or "")))
    if (
        not assignment
        or assignment.get("organization_id") != organization_id
        or assignment.get("actor_id") != actor["id"]
        or assignment.get("status") not in {"assigned", "accepted"}
    ):
        raise UserError("This assignment is not assigned to the authenticated recipient.")
    campaign = _row(await tables.get(TABLE_CAMPAIGNS, str(assignment.get("campaign_id") or "")))
    if not campaign or campaign.get("organization_id") != organization_id:
        raise UserError("Campaign is not available to your organization.")
    payload = await _campaign_payload(campaign, organization_id, assignments=[assignment])
    payload["branding"] = _export_branding(branding)
    return _pdf_result(render_campaign_pdf(payload), f"{_safe_filename(campaign.get('title'), 'policy-assignment')}.pdf")
