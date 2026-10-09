"""Administrative tracking and lifecycle for policy sign-off campaigns."""
from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from bifrost import UserError, context, files, organizations, roles, tables, workflow

from functions.grc_auth import require_organization_access, is_platform_scope, require_provider
from functions.grc_policy_acceptance import is_genuine_policy_acceptance
from workflows.grc_v2.grc_integration import _doc_to_row, _json_list, _json_value

CAMPAIGNS = "grc-policy-campaigns"
ASSIGNMENTS = "grc-policy-campaign-assignments"
ACCEPTANCES = "grc-policy-acceptances"
POLICIES = "grc-policies"
EVIDENCE = "grc-evidence"
EVIDENCE_LINKS = "grc-evidence-links"
ENGINE_USER_ID = "00000000-0000-0000-0000-000000000001"


async def _query_rows(table: str, where: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    offset = 0
    while offset < 10000:
        result = await tables.query(table, where=where, limit=1000, offset=offset)
        page = [_doc_to_row(item) for item in result.documents]
        rows.extend(page)
        if len(page) < 1000:
            return rows
        offset += len(page)
    raise UserError(f"{table} exceeds the safe campaign read limit.")


def _now() -> datetime:
    return datetime.now(UTC)


def _parse_date(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    except ValueError:
        return None


def _csv_cell(value: Any) -> str:
    text = str(value or "")
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def _notice_kind(notice: dict[str, Any]) -> str:
    """Read legacy entries while new notifications use the event contract's kind."""
    return str(notice.get("kind") or notice.get("type") or "")


def _notice_requested_at(notice: dict[str, Any]) -> Any:
    return notice.get("requested_at") or notice.get("at")


async def _merge_notification_emit_result(assignment_id: str, notification_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Preserve a callback's terminal result when a listener runs during emit."""
    assignment = _doc_to_row(await tables.get(ASSIGNMENTS, assignment_id))
    metadata = _json_value(assignment.get("metadata_json"), {})
    notices = metadata.get("notifications") if isinstance(metadata.get("notifications"), list) else []
    notice = next((item for item in notices if isinstance(item, dict) and item.get("notification_id") == notification_id), None)
    if notice is None:
        raise UserError("The persisted notification request could not be found.")
    if notice.get("status") != "requested":
        notice["subscribers_notified"] = int(result.get("subscribers_notified") or 0)
        metadata["notifications"] = notices
        await tables.update(ASSIGNMENTS, assignment_id, {"metadata_json": json.dumps(metadata, separators=(",", ":"))})
        return notice
    notice.update(result)
    metadata["notifications"] = notices
    await tables.update(ASSIGNMENTS, assignment_id, {"metadata_json": json.dumps(metadata, separators=(",", ":"))})
    return notice


def _roles() -> set[str]:
    user = getattr(context, "user", None)
    values = getattr(user, "role_names", None) or getattr(user, "roles", None) or []
    return {str(v.get("name") if isinstance(v, dict) else getattr(v, "name", v)) for v in values}


def _require_human_provider(message: str) -> None:
    actor = getattr(context, "user", None)
    actor_id = str(getattr(actor, "id", None) or getattr(context, "user_id", "") or "")
    if not actor_id or actor_id == ENGINE_USER_ID:
        raise UserError("A real provider user must be passed with run_as.")
    require_provider(message)


async def _admin_org(organization_id: str, *, read_only: bool = False) -> str:
    actor = getattr(context, "user", None)
    actor_id = str(getattr(actor, "id", None) or getattr(context, "user_id", "") or "")
    if not actor_id or actor_id == "00000000-0000-0000-0000-000000000001":
        raise UserError("An authenticated human caller is required.")
    if not is_platform_scope():
        allowed_roles = {"GRC Administrator", "GRC Contributor"} | ({"GRC Auditor"} if read_only else set())
        authorized = bool(_roles() & allowed_roles)
        if not authorized:
            for role in await roles.list():
                name = role.get("name") if isinstance(role, dict) else getattr(role, "name", None)
                role_id = role.get("id") if isinstance(role, dict) else getattr(role, "id", None)
                if name in allowed_roles and actor_id in {str(uid) for uid in await roles.list_users(str(role_id))}:
                    authorized = True
                    break
        if not authorized:
            raise UserError("An authorized GRC role is required.")
    return require_organization_access(organization_id, resource="policy campaign")


async def _campaign(campaign_id: str, *, read_only: bool = False) -> dict[str, Any]:
    row = _doc_to_row(await tables.get(CAMPAIGNS, campaign_id))
    if not row:
        raise UserError("Campaign not found.")
    await _admin_org(str(row.get("organization_id") or ""), read_only=read_only)
    return row


async def _details(campaign: dict[str, Any]) -> dict[str, Any]:
    org = str(campaign["organization_id"])
    cid = str(campaign["id"])
    policy_ids = [str(p) for p in _json_list(campaign.get("policy_ids_json"))]
    policies = []
    for pid in policy_ids:
        row = _doc_to_row(await tables.get(POLICIES, pid))
        if row:
            policies.append({"id": pid, "name": row.get("name"), "policy_type": row.get("policy_type"), "version": _json_value(campaign.get("policy_versions_json"), {}).get(pid)})
    assignments = await _query_rows(ASSIGNMENTS, {"organization_id": org, "campaign_id": cid})
    acceptances = await _query_rows(ACCEPTANCES, {"organization_id": org, "campaign_id": cid})
    assignments_by_id = {str(assignment.get("id") or ""): assignment for assignment in assignments}
    accepted_by_assignment = {}
    for acceptance in acceptances:
        assignment = assignments_by_id.get(str(acceptance.get("assignment_id") or ""))
        if is_genuine_policy_acceptance(acceptance, assignment, campaign):
            accepted_by_assignment[str(acceptance.get("assignment_id"))] = acceptance
    now = _now()
    due = _parse_date(campaign.get("due_date"))
    people = []
    has_no_listener = False
    for row in assignments:
        metadata = _json_value(row.get("metadata_json"), {})
        notifications = metadata.get("notifications", []) if isinstance(metadata, dict) else []
        notices = [notice for notice in notifications if isinstance(notice, dict)]
        has_no_listener = has_no_listener or any(notice.get("status") == "no_listener" for notice in notices)
        if row.get("status") in {"removed", "revoked", "superseded"}:
            continue
        reminders = [notice for notice in notices if _notice_kind(notice) == "reminder"]
        latest_notice = notices[-1] if notices else None
        acceptance = accepted_by_assignment.get(str(row["id"]))
        waived = row.get("status") == "waived"
        signed = bool(acceptance) and not waived
        status = "waived" if waived else "signed" if signed else "overdue" if due and due.date() < now.date() else "not_signed"
        people.append({
            "assignment_id": row["id"], "name": row.get("actor_display_name") or row.get("actor_email"),
            "email": row.get("actor_email"), "status": status,
            "accepted_at": (acceptance or {}).get("accepted_at"),
            "acceptance_id": (acceptance or {}).get("id"),
            "last_reminded_at": _notice_requested_at(reminders[-1]) if reminders else None,
            "reminders_sent": len(reminders), "waiver_reason": metadata.get("waiver_reason"),
            "last_notice": ({
                "kind": _notice_kind(latest_notice),
                "status": latest_notice.get("status"),
                "requested_at": _notice_requested_at(latest_notice),
                "completed_at": latest_notice.get("completed_at"),
                **({"error": latest_notice["error"]} if latest_notice.get("error") else {}),
            } if latest_notice else None),
        })
    people.sort(key=lambda p: (str(p["name"] or "").casefold(), str(p["email"] or "")))
    counts = {
        "required": sum(p["status"] != "waived" for p in people), "accepted": sum(p["status"] == "signed" for p in people),
        "waived": sum(p["status"] == "waived" for p in people),
        "outstanding": sum(p["status"] in {"not_signed", "overdue"} for p in people),
    }
    return {
        "campaign_id": cid, "organization_id": org, "title": campaign.get("title"),
        "status": campaign.get("status"), "policies": policies,
        "sent_date": campaign.get("created_at"), "due_date": campaign.get("due_date"),
        "link_url": campaign.get("link_url"), "has_no_listener": has_no_listener,
        "counts": counts, "people": people,
    }


@workflow(name="grc_v2_list_policy_campaigns", category="grc")
async def grc_v2_list_policy_campaigns(organization_id: str) -> dict[str, Any]:
    org = await _admin_org(organization_id, read_only=True)
    rows = await _query_rows(CAMPAIGNS, {"organization_id": org})
    campaigns = [await _details(row) for row in rows]
    campaigns.sort(key=lambda row: str(row.get("sent_date") or ""), reverse=True)
    return {"campaigns": [{k: v for k, v in row.items() if k != "people"} for row in campaigns]}


@workflow(name="grc_v2_get_policy_campaign", category="grc")
async def grc_v2_get_policy_campaign(campaign_id: str) -> dict[str, Any]:
    return await _details(await _campaign(campaign_id, read_only=True))


@workflow(name="grc_v2_waive_policy_assignment", category="grc")
async def grc_v2_waive_policy_assignment(assignment_id: str, reason: str) -> dict[str, Any]:
    reason = str(reason or "").strip()
    if not reason:
        raise UserError("A waiver reason is required.")
    row = _doc_to_row(await tables.get(ASSIGNMENTS, assignment_id))
    if not row:
        raise UserError("Assignment not found.")
    await _admin_org(str(row.get("organization_id") or ""))
    if row.get("status") in {"accepted", "removed", "revoked", "superseded"}:
        raise UserError("This assignment cannot be waived.")
    metadata = _json_value(row.get("metadata_json"), {})
    metadata.update({"waiver_reason": reason, "waived_at": _now().isoformat(), "waived_by": str(getattr(getattr(context, "user", None), "id", None) or context.user_id)})
    await tables.update(ASSIGNMENTS, assignment_id, {"status": "waived", "metadata_json": json.dumps(metadata)})
    return {"assignment_id": assignment_id, "status": "waived", "reason": reason}


async def _remind(campaign: dict[str, Any], assignment_ids: list[str] | None = None, *, schedule_days: set[int] | None = None) -> dict[str, Any]:
    from workflows.grc_v2.grc_policy_campaign import emit_policy_notification, prepare_policy_notification
    org = str(campaign["organization_id"])
    rows = await _query_rows(ASSIGNMENTS, {"organization_id": org, "campaign_id": campaign["id"]})
    accepted_rows = await _query_rows(ACCEPTANCES, {"organization_id": org, "campaign_id": campaign["id"]})
    accepted_ids = {str(a.get("assignment_id")) for a in accepted_rows if a.get("status") == "accepted" and not a.get("revoked_at") and not a.get("superseded_by")}
    allowed = set(assignment_ids or [])
    found = {str(row["id"]) for row in rows}
    if assignment_ids is not None and allowed - found:
        raise UserError("One or more assignments do not belong to this campaign.")
    now = _now()
    requested, skipped, failed = [], [], []
    for row in rows:
        aid = str(row["id"])
        if (assignment_ids is not None and aid not in allowed) or row.get("status") != "assigned" or aid in accepted_ids:
            skipped.append(aid)
            continue
        metadata = _json_value(row.get("metadata_json"), {})
        notes = metadata.get("notifications", [])
        prior_reminders = [notice for notice in notes if isinstance(notice, dict) and _notice_kind(notice) == "reminder"]
        last = _parse_date(_notice_requested_at(prior_reminders[-1])) if prior_reminders else None
        if last and now - last < timedelta(hours=24):
            skipped.append(aid)
            continue
        if schedule_days is not None:
            invited = next((notice for notice in notes if isinstance(notice, dict) and _notice_kind(notice) == "invite"), None)
            invite_at = _parse_date(_notice_requested_at(invited or {})) or _parse_date(row.get("assigned_at"))
            if not invite_at or (now.date() - invite_at.date()).days not in schedule_days:
                skipped.append(aid)
                continue
        payload, notice = await prepare_policy_notification(
            org, aid, str(row.get("actor_email") or ""), str(row.get("actor_display_name") or ""), campaign, reminder=True,
        )
        notes.append(notice)
        metadata["notifications"] = notes
        # Store before emitting so an event subscriber can report immediately.
        await tables.update(ASSIGNMENTS, aid, {"metadata_json": json.dumps(metadata, separators=(",", ":"))})
        emit_result = await emit_policy_notification(org, payload)
        notice = await _merge_notification_emit_result(aid, str(notice["notification_id"]), emit_result)
        if emit_result.get("status") not in {"no_listener", "failed"}:
            requested.append(aid)
        if notice["status"] in {"no_listener", "failed"}:
            failed.append({
                "assignment_id": aid,
                "email": str(row.get("actor_email") or ""),
                "reason": str(notice.get("error") or "GRC could not request a notification."),
            })
    return {"requested": requested, "skipped": skipped, "failed_notifications": failed}


@workflow(name="grc_v2_remind_policy_assignees", category="grc")
async def grc_v2_remind_policy_assignees(campaign_id: str, assignment_ids: list[str] | None = None) -> dict[str, Any]:
    return await _remind(await _campaign(campaign_id), assignment_ids)


@workflow(name="grc_v2_send_due_policy_reminders", category="grc")
async def grc_v2_send_due_policy_reminders() -> dict[str, Any]:
    actor = getattr(context, "user", None)
    actor_id = str(getattr(actor, "id", None) or getattr(context, "user_id", "") or "")
    event = getattr(context, "event", None)
    scheduled = actor_id == "00000000-0000-0000-0000-000000000001" and getattr(event, "type", None) == "schedule.fired"
    if not scheduled:
        if not actor_id or actor_id == "00000000-0000-0000-0000-000000000001":
            raise UserError("A scheduled event or authorized GRC user is required.")
        if not is_platform_scope():
            await _admin_org(str(getattr(context, "org_id", "") or ""))
    org = str(getattr(context, "org_id", "") or "")
    where = {} if scheduled or is_platform_scope() else {"organization_id": org}
    rows = await _query_rows(CAMPAIGNS, where)
    results = [await _remind(row, schedule_days={3, 7, 13}) for row in rows if row.get("status") == "active"]
    return {"campaigns_checked": len(results), "requested": sum(len(r["requested"]) for r in results), "failed_notifications": [f for r in results for f in r["failed_notifications"]]}


@workflow(name="grc_v2_export_policy_campaign_evidence", category="grc")
async def grc_v2_export_policy_campaign_evidence(campaign_id: str) -> dict[str, Any]:
    campaign = await _campaign(campaign_id, read_only=True)
    detail = await _details(campaign)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["name", "email", "status", "accepted_at", "policy_versions", "acceptance_id", "waiver_reason"])
    versions = json.dumps({p["id"]: p["version"] for p in detail["policies"]}, sort_keys=True)
    for person in detail["people"]:
        writer.writerow([_csv_cell(person[key]) for key in ("name", "email", "status", "accepted_at")] + [_csv_cell(versions), _csv_cell(person["acceptance_id"]), _csv_cell(person["waiver_reason"])])
    org = detail["organization_id"]
    path = f"policy-signoff/{campaign_id}/{_now().strftime('%Y%m%dT%H%M%SZ')}.csv"
    await files.write_bytes(path, output.getvalue().encode("utf-8-sig"), location="grc-policy-files", scope=org)
    evidence = await tables.insert(EVIDENCE, {"organization_id": org, "applied_organizations": [org], "name": f"Policy sign-off: {detail['title']}", "type": "policy_signoff", "file_path": path, "provenance_json": json.dumps({"campaign_id": campaign_id, "policy_ids": [p["id"] for p in detail["policies"]]})})
    for policy in detail["policies"]:
        await tables.insert(EVIDENCE_LINKS, {
            "organization_id": org, "applied_organizations": [org],
            "evidence_id": str(evidence.id), "target_type": "policy", "target_id": policy["id"],
            "relationship": "signoff", "source_system": "bifrost_grc_policy_signoff",
            "source_id": campaign_id,
        })
    signed = await files.get_signed_url(path, method="GET", location="grc-policy-files", scope=org)
    return {"evidence_id": str(evidence.id), "download_url": signed.get("url"), "file_path": path}


async def _reissue(campaign: dict[str, Any], send_campaign: Any) -> dict[str, Any]:
    """Create a replacement campaign after a policy version changes.

    ``send_campaign`` is supplied by the authorized entry point.  The direct
    admin workflow uses its direct sender, while a caller workflow supplies the
    sender that is safe after its own role check.
    """
    if campaign.get("status") != "active":
        raise UserError("Only an active campaign can be re-issued.")
    details = await _details(campaign)
    current = {}
    for policy in details["policies"]:
        row = _doc_to_row(await tables.get(POLICIES, policy["id"]))
        current[policy["id"]] = row.get("version")
    if not any(current[p["id"]] != p["version"] for p in details["policies"]):
        raise UserError("A policy version must change before re-issue.")
    campaign_id = str(campaign["id"])
    rows = await _query_rows(ASSIGNMENTS, {"organization_id": details["organization_id"], "campaign_id": campaign_id})
    active_rows = [row for row in rows if row.get("status") not in {"removed", "revoked", "superseded"}]
    recipients = [{"email": row.get("actor_email"), "name": row.get("actor_display_name")} for row in active_rows]
    if not recipients:
        raise UserError("No assignees remain for re-issue.")

    waived_reasons = {}
    for row in active_rows:
        if row.get("status") != "waived":
            continue
        reason = str(_json_value(row.get("metadata_json"), {}).get("waiver_reason") or "").strip()
        email = str(row.get("actor_email") or "").strip().casefold()
        if reason and email:
            waived_reasons[email] = reason
    result = await send_campaign(
        details["organization_id"], [policy["id"] for policy in details["policies"]], recipients,
        campaign.get("due_date"), campaign.get("description"), waived_reasons,
    )
    new_campaign_id = str(result.get("campaign_id") or "")
    new_rows = await _query_rows(ASSIGNMENTS, {
        "organization_id": details["organization_id"], "campaign_id": new_campaign_id,
    }) if new_campaign_id else []
    old_by_actor = {str(row.get("actor_id") or ""): row for row in active_rows if row.get("actor_id")}
    old_by_email = {
        str(row.get("actor_email") or "").strip().casefold(): row
        for row in active_rows if row.get("actor_email")
    }
    reasked_signed: list[dict[str, str]] = []
    waivers_carried_over: list[dict[str, str]] = []
    for new_row in new_rows:
        old_row = (
            old_by_actor.get(str(new_row.get("actor_id") or ""))
            or old_by_email.get(str(new_row.get("actor_email") or "").strip().casefold())
        )
        if not old_row:
            continue
        email = str(new_row.get("actor_email") or "").strip()
        if old_row.get("status") == "accepted":
            reasked_signed.append({"assignment_id": str(new_row["id"]), "email": email})
        reason = waived_reasons.get(str(old_row.get("actor_email") or "").strip().casefold())
        metadata = _json_value(new_row.get("metadata_json"), {})
        if reason and new_row.get("status") == "waived" and metadata.get("waiver_reason") == reason:
            waivers_carried_over.append({"assignment_id": str(new_row["id"]), "email": email, "reason": reason})
    await tables.update(CAMPAIGNS, campaign_id, {"status": "closed"})
    return {
        "old_campaign_id": campaign_id,
        **result,
        "reasked_signed": sorted(reasked_signed, key=lambda row: (row["email"].casefold(), row["assignment_id"])),
        "waivers_carried_over": sorted(waivers_carried_over, key=lambda row: (row["email"].casefold(), row["assignment_id"])),
    }


@workflow(name="grc_v2_reissue_policy_campaign", category="grc")
async def grc_v2_reissue_policy_campaign(campaign_id: str) -> dict[str, Any]:
    from workflows.grc_v2.grc_policy_campaign import grc_v2_send_policy_campaign
    return await _reissue(await _campaign(campaign_id), grc_v2_send_policy_campaign)


async def _base_policy_organizations(base_policy_id: str) -> list[dict[str, Any]]:
    base = _doc_to_row(await tables.get(POLICIES, base_policy_id))
    if not base or base.get("policy_role") != "base":
        raise UserError("Base policy not found.")
    extensions = [
        row for row in await _query_rows(POLICIES, {"base_policy_id": base_policy_id})
        if row.get("policy_role") == "extension" and row.get("status") == "active"
    ]
    campaigns = await _query_rows(CAMPAIGNS, {})
    results = []
    for extension in extensions:
        applied = [str(value) for value in extension.get("applied_organizations") or [] if value]
        organization_id = str(extension.get("organization_id") or (applied[0] if len(applied) == 1 else ""))
        if not organization_id:
            continue
        organization = await organizations.get(organization_id)
        organization_name = str(getattr(organization, "name", None) or (organization.get("name") if isinstance(organization, dict) else "") or organization_id)
        matching = [
            row for row in campaigns
            if row.get("organization_id") == organization_id
            and {str(value) for value in _json_list(row.get("policy_ids_json"))} >= {str(base_policy_id), str(extension["id"])}
        ]
        matching.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
        detail = await _details(matching[0]) if matching else None
        eligible_campaigns = [
            campaign for campaign in matching
            if campaign.get("status") == "active"
            and str(_json_value(campaign.get("policy_versions_json"), {}).get(str(base_policy_id)) or "") != str(base.get("version") or "")
        ]
        results.append({
            "organization_id": organization_id,
            "organization_name": organization_name,
            "addendum_policy_id": extension["id"],
            "addendum_version": str(extension.get("version") or ""),
            "accepted": (detail or {}).get("counts", {}).get("accepted", 0),
            "required": (detail or {}).get("counts", {}).get("required", 0),
            "last_sent": (detail or {}).get("sent_date"),
            "eligible_campaigns": eligible_campaigns,
        })
    return sorted(results, key=lambda row: (row["organization_name"].casefold(), row["organization_id"]))


@workflow(name="grc_v2_list_base_policy_organizations", category="grc")
async def grc_v2_list_base_policy_organizations(base_policy_id: str) -> dict[str, Any]:
    """List each organization with an addendum for a provider-owned base policy."""
    _require_human_provider("Provider access is required to list base policy organizations.")
    organizations_summary = await _base_policy_organizations(str(base_policy_id))
    return {"organizations": [{key: value for key, value in row.items() if key != "eligible_campaigns"} for row in organizations_summary]}


@workflow(name="grc_v2_reissue_for_base_policy", category="grc")
async def grc_v2_reissue_for_base_policy(base_policy_id: str, confirm: bool = False) -> dict[str, Any]:
    """Preview or reissue every active campaign using a provider base policy."""
    _require_human_provider("Provider access is required to re-issue a base policy.")
    organizations_summary = await _base_policy_organizations(str(base_policy_id))
    affected = []
    for row in organizations_summary:
        open_campaigns = []
        for campaign in row["eligible_campaigns"]:
            detail = await _details(campaign)
            open_campaigns.append({"campaign_id": campaign["id"], "assignee_count": len(detail["people"])})
        if not open_campaigns:
            continue
        affected.append({
            "organization_id": row["organization_id"],
            "organization_name": row["organization_name"],
            "assignee_count": sum(item["assignee_count"] for item in open_campaigns),
            "open_campaigns": open_campaigns,
        })
    if not confirm:
        return {"mode": "dry_run", "affected_organizations": affected}
    from workflows.grc_v2.grc_policy_campaign import grc_v2_send_policy_campaign
    reissued = []
    for row in organizations_summary:
        for campaign in row["eligible_campaigns"]:
            reissued.append(await _reissue(campaign, grc_v2_send_policy_campaign))
    return {"mode": "confirmed", "affected_organizations": affected, "reissued": reissued}
