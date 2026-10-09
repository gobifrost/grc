"""Bifrost GRC refactor support workflows.

These workflows intentionally keep schema/policy mutation out of source control.
They operate against platform tables and are safe to run in dry-run mode first.
"""
import json
import re
from datetime import datetime, timezone
from typing import Any

from bifrost import UserError, tables, workflow

from functions.grc_auth import caller_organization_id, require_organization_access, require_provider, require_row_access
from workflows.grc_v2.grc_scope import applies_to_organization


TABLE_ASSESSMENT_CONTROL_OVERRIDES = "grc-assessment-control-overrides"
TABLE_ASSESSMENTS = "grc-assessments"
TABLE_ASSESSMENT_CONTROLS = "grc-assessment-controls"
TABLE_APPLIED_CONTROLS = "grc-applied-controls"
TABLE_CONTROL_MAPPINGS = "grc-control-mappings"
TABLE_EVIDENCE = "grc-evidence"
TABLE_EVIDENCE_LINKS = "grc-evidence-links"
TABLE_EXCEPTION_LINKS = "grc-exception-links"
TABLE_EXCEPTIONS = "grc-exceptions"
TABLE_POLICIES = "grc-policies"
TABLE_POLICY_LINKS = "grc-policy-links"
TABLE_POLICY_CONTROLS = "grc-policy-controls"
TABLE_QUESTIONNAIRE_RESPONSES = "grc-questionnaire-responses"
TABLE_QUESTIONNAIRE_PROPOSALS = "grc-questionnaire-proposals"
TABLE_RISK_LINKS = "grc-risk-links"
TABLE_RISK_CONTROLS = "grc-risk-controls"
TABLE_RISKS = "grc-risks"

CONTROL_STATUSES = {"compliant", "partially_compliant", "non_compliant", "not_assessed", "not_applicable"}
SCOPED_TABLES = [
    TABLE_ASSESSMENTS,
    TABLE_APPLIED_CONTROLS,
    TABLE_EVIDENCE,
    TABLE_POLICIES,
    TABLE_RISKS,
    TABLE_EXCEPTIONS,
    TABLE_CONTROL_MAPPINGS,
    TABLE_EVIDENCE_LINKS,
    TABLE_POLICY_LINKS,
    TABLE_EXCEPTION_LINKS,
    TABLE_RISK_LINKS,
]

PROVIDER_OWNED_TABLES = [TABLE_ASSESSMENTS, TABLE_APPLIED_CONTROLS, TABLE_EVIDENCE, TABLE_POLICIES,
                         TABLE_RISKS, TABLE_EXCEPTIONS, TABLE_CONTROL_MAPPINGS, TABLE_EVIDENCE_LINKS,
                         TABLE_POLICY_LINKS, TABLE_EXCEPTION_LINKS, TABLE_RISK_LINKS]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _doc_to_row(doc) -> dict | None:
    if doc is None:
        return None
    if isinstance(doc, dict):
        row = dict(doc)
        data = row.get("data")
        if isinstance(data, dict):
            merged = dict(data)
            merged["id"] = row.get("id", merged.get("id"))
            return merged
        return row
    data = dict(getattr(doc, "data", None) or {})
    data["id"] = getattr(doc, "id", data.get("id"))
    return data


def _documents(result: Any) -> list:
    docs = getattr(result, "documents", None)
    if docs is not None:
        return list(docs or [])
    if isinstance(result, list):
        return result
    return []


async def _query_rows(table: str, where: dict | None = None, limit: int = 1000) -> list[dict]:
    result = await tables.query(table, where=where or {}, limit=limit)
    return [row for row in (_doc_to_row(doc) for doc in _documents(result)) if row]


def _json_loads(value, default):
    if value in (None, ""):
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return default


def _json_dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _stable_override_id(assessment_id: str, control_id: str, customer_organization_id: str) -> str:
    raw = f"{assessment_id}_{control_id}_{customer_organization_id}"
    return re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-")[:180]


def _require_apply(apply: bool, confirm_apply: bool, label: str) -> None:
    if apply and not confirm_apply:
        raise UserError(f"confirm_apply=true is required before {label}.")


def _legacy_scope_patch(row: dict) -> dict:
    if "applied_organizations" in row and row.get("applied_organizations") is not None:
        applied = row.get("applied_organizations")
    elif "applied_organizations" in row and row.get("applied_organizations") is None:
        applied = None
    elif row.get("organization_id"):
        applied = [row.get("organization_id")]
    else:
        applied = None
    excluded = row.get("excluded_organizations")
    return {
        "applied_organizations": applied,
        "excluded_organizations": excluded if isinstance(excluded, list) else [],
    }


def _provider_scope_patch(row: dict, provider_id: str) -> tuple[dict, bool]:
    patch = _legacy_scope_patch(row)
    applied = patch.get("applied_organizations")
    if isinstance(applied, list):
        without_provider = [org_id for org_id in applied if str(org_id) != provider_id]
        ambiguous = bool(applied) and not without_provider
        patch["applied_organizations"] = None if ambiguous else without_provider
    else:
        ambiguous = False
    patch["excluded_organizations"] = [org_id for org_id in patch.get("excluded_organizations", [])
                                         if str(org_id) != provider_id]
    return patch, ambiguous


@workflow(
    name="set_grc_assessment_control_override",
    description="Set one Bifrost GRC assessment-control organization override with a deterministic row id.",
    category="grc",
)
async def set_grc_assessment_control_override(
    assessment_id: str,
    control_id: str,
    customer_organization_id: str,
    status: str,
    notes: str | None = None,
    implementation_percentage: int | None = None,
) -> dict:
    if not assessment_id or not control_id or not customer_organization_id:
        raise UserError("assessment_id, control_id, and customer_organization_id are required")
    if status not in CONTROL_STATUSES:
        raise UserError(f"invalid status: {status}")
    customer_organization_id = require_organization_access(
        customer_organization_id,
        resource="assessment control override",
    )
    assessment = _doc_to_row(await tables.get(TABLE_ASSESSMENTS, assessment_id))
    assessment_owner_id = require_row_access(assessment, resource="assessment")
    if not applies_to_organization(assessment, customer_organization_id):
        raise UserError("customer organization is outside this assessment's scope")
    pct = implementation_percentage
    if pct is None:
        pct = 100 if status == "compliant" else 50 if status == "partially_compliant" else 0
    row_id = _stable_override_id(assessment_id, control_id, customer_organization_id)
    payload = {
        "assessment_id": assessment_id,
        "control_id": control_id,
        "organization_id": assessment_owner_id,
        "customer_organization_id": customer_organization_id,
        "status": status,
        "notes": notes,
        "assessed_at": _now(),
        "implementation_percentage": max(0, min(100, int(pct))),
    }
    row = _doc_to_row(await tables.upsert(TABLE_ASSESSMENT_CONTROL_OVERRIDES, row_id, payload))
    return row or {"id": row_id, **payload}


@workflow(
    name="clear_grc_assessment_control_override",
    description="Clear one Bifrost GRC assessment-control organization override.",
    category="grc",
)
async def clear_grc_assessment_control_override(
    override_id: str | None = None,
    assessment_id: str | None = None,
    control_id: str | None = None,
    customer_organization_id: str | None = None,
) -> dict:
    row_id = override_id or (
        _stable_override_id(assessment_id or "", control_id or "", customer_organization_id or "")
        if assessment_id and control_id and customer_organization_id
        else None
    )
    if not row_id:
        raise UserError("override_id or assessment_id/control_id/customer_organization_id is required")
    existing = _doc_to_row(await tables.get(TABLE_ASSESSMENT_CONTROL_OVERRIDES, row_id))
    require_row_access(existing, resource="assessment control override")
    existing_customer_id = str(existing.get("customer_organization_id") or "")
    if customer_organization_id and str(customer_organization_id) != existing_customer_id:
        raise UserError("override customer organization mismatch")
    await tables.delete_document(TABLE_ASSESSMENT_CONTROL_OVERRIDES, row_id)
    return {"id": row_id, "deleted": True}


async def migrate_grc_evidence_content_model(apply: bool = False, confirm_apply: bool = False, limit: int = 1000) -> dict:
    _require_apply(apply, confirm_apply, "migrating GRC evidence")
    evidence_rows = await _query_rows(TABLE_EVIDENCE, limit=limit)
    link_rows = await _query_rows(TABLE_EVIDENCE_LINKS, limit=limit)
    response_rows = await _query_rows(TABLE_QUESTIONNAIRE_RESPONSES, limit=limit)
    links_by_evidence: dict[str, list[dict]] = {}
    for link in link_rows:
        if link.get("evidence_id"):
            links_by_evidence.setdefault(link["evidence_id"], []).append(link)

    purge_ids: list[str] = []
    update_plans: list[dict] = []
    for row in evidence_rows:
        row_id = row.get("id")
        if not row_id:
            continue
        is_questionnaire_note = row.get("uploaded_by") == "questionnaire" and row.get("type") == "note"
        if is_questionnaire_note:
            purge_ids.append(row_id)
            continue
        urls = _json_loads(row.get("urls_json"), [])
        attachments = _json_loads(row.get("attachments_json"), [])
        if row.get("url") and row.get("url") not in urls:
            urls.append(row.get("url"))
        if row.get("file_path") and not any(a.get("path") == row.get("file_path") for a in attachments if isinstance(a, dict)):
            attachments.append({"path": row.get("file_path"), "kind": row.get("type") or "attachment"})
        patch = {
            "notes_markdown": row.get("notes_markdown") or row.get("notes"),
            "urls_json": _json_dumps(urls),
            "attachments_json": _json_dumps(attachments),
            "review_status": row.get("review_status") or "needs_review",
            **_legacy_scope_patch(row),
        }
        update_plans.append({"id": row_id, "patch": patch})

    purged_link_ids = [link.get("id") for eid in purge_ids for link in links_by_evidence.get(eid, []) if link.get("id")]
    response_updates = []
    purge_set = set(purge_ids)
    for response in response_rows:
        metadata = _json_loads(response.get("metadata_json"), {})
        if metadata.get("applied_evidence_id") in purge_set:
            metadata.pop("applied_evidence_id", None)
            response_updates.append({
                "id": response.get("id"),
                "patch": {
                    "metadata_json": _json_dumps(metadata),
                    "status": "accepted" if response.get("status") == "applied" else response.get("status"),
                },
            })

    if apply:
        for plan in update_plans:
            await tables.update(TABLE_EVIDENCE, plan["id"], plan["patch"])
        for link_id in purged_link_ids:
            await tables.delete_document(TABLE_EVIDENCE_LINKS, link_id)
        for evidence_id in purge_ids:
            await tables.delete_document(TABLE_EVIDENCE, evidence_id)
        for plan in response_updates:
            if plan.get("id"):
                await tables.update(TABLE_QUESTIONNAIRE_RESPONSES, plan["id"], plan["patch"])

    return {
        "mode": "apply" if apply else "dry_run",
        "evidence_seen": len(evidence_rows),
        "updates": len(update_plans),
        "purge_questionnaire_note_evidence": len(purge_ids),
        "purge_evidence_links": len(purged_link_ids),
        "response_metadata_repairs": len(response_updates),
        "samples": {
            "updates": update_plans[:5],
            "purge_ids": purge_ids[:10],
            "response_updates": response_updates[:5],
        },
    }


async def migrate_grc_scope_fields(apply: bool = False, confirm_apply: bool = False, table_names: list[str] | None = None) -> dict:
    _require_apply(apply, confirm_apply, "backfilling GRC scope fields")
    selected = table_names or SCOPED_TABLES
    results: dict[str, Any] = {}
    for table in selected:
        rows = await _query_rows(table, limit=1000)
        plans = []
        for row in rows:
            if not row.get("id"):
                continue
            if "applied_organizations" in row and "excluded_organizations" in row:
                continue
            plans.append({"id": row["id"], "patch": _legacy_scope_patch(row)})
        if apply:
            for plan in plans:
                await tables.update(table, plan["id"], plan["patch"])
        results[table] = {"rows": len(rows), "updates": len(plans), "samples": plans[:5]}
    return {"mode": "apply" if apply else "dry_run", "tables": results}


async def migrate_grc_provider_scope_model(
    apply: bool = False,
    confirm_apply: bool = False,
    limit: int = 1000,
) -> dict:
    require_provider("Provider access is required to migrate GRC ownership.")
    _require_apply(apply, confirm_apply, "migrating the provider-owned GRC scope model")
    provider_id = caller_organization_id()
    if not provider_id:
        raise UserError("The provider organization could not be resolved.")
    results: dict[str, Any] = {}
    assessments = await _query_rows(TABLE_ASSESSMENTS, limit=limit)
    assessment_by_id = {row.get("id"): row for row in assessments if row.get("id")}
    for table in PROVIDER_OWNED_TABLES:
        rows = assessments if table == TABLE_ASSESSMENTS else await _query_rows(table, limit=limit)
        plans, provider_only_to_all = [], []
        for row in rows:
            if not row.get("id"):
                continue
            scope_patch, ambiguous = _provider_scope_patch(row, provider_id)
            if ambiguous:
                provider_only_to_all.append(row["id"])
            patch = {**scope_patch, "organization_id": provider_id}
            if any(row.get(key) != value for key, value in patch.items()):
                plans.append({"id": row["id"], "patch": patch})
        if apply:
            for plan in plans:
                await tables.update(table, plan["id"], plan["patch"])
        results[table] = {"rows": len(rows), "updates": len(plans),
                          "provider_only_scopes_converted_to_all": provider_only_to_all[:50], "samples": plans[:5]}
    control_rows = await _query_rows(TABLE_ASSESSMENT_CONTROLS, limit=limit)
    control_plans = [{"id": row["id"], "patch": {"organization_id": provider_id}} for row in control_rows
                     if row.get("id") and row.get("organization_id") != provider_id]
    if apply:
        for plan in control_plans:
            await tables.update(TABLE_ASSESSMENT_CONTROLS, plan["id"], plan["patch"])
    results[TABLE_ASSESSMENT_CONTROLS] = {"rows": len(control_rows), "updates": len(control_plans), "samples": control_plans[:5]}
    overrides = await _query_rows(TABLE_ASSESSMENT_CONTROL_OVERRIDES, limit=limit)
    override_plans, invalid_overrides = [], []
    for row in overrides:
        if not row.get("id"):
            continue
        customer_id = str(row.get("customer_organization_id") or row.get("organization_id") or "")
        assessment = assessment_by_id.get(row.get("assessment_id"))
        if not customer_id or not assessment or not applies_to_organization(assessment, customer_id):
            invalid_overrides.append({"id": row["id"], "reason": "missing customer or outside assessment scope"})
            continue
        patch = {"organization_id": provider_id, "customer_organization_id": customer_id}
        if any(row.get(key) != value for key, value in patch.items()):
            override_plans.append({"id": row["id"], "patch": patch})
    if apply and invalid_overrides:
        raise UserError(f"Migration blocked by {len(invalid_overrides)} invalid assessment overrides.")
    if apply:
        for plan in override_plans:
            await tables.update(TABLE_ASSESSMENT_CONTROL_OVERRIDES, plan["id"], plan["patch"])
    results[TABLE_ASSESSMENT_CONTROL_OVERRIDES] = {"rows": len(overrides), "updates": len(override_plans),
        "invalid": invalid_overrides[:50], "samples": override_plans[:5]}
    for legacy_table, parent_table, target_table, parent_key, object_key, relationship in [
        (TABLE_POLICY_CONTROLS, TABLE_POLICIES, TABLE_POLICY_LINKS, "policy_id", "policy_id", "governs"),
        (TABLE_RISK_CONTROLS, TABLE_RISKS, TABLE_RISK_LINKS, "risk_id", "risk_id", "mitigates"),
    ]:
        legacy_rows = await _query_rows(legacy_table, limit=limit)
        existing_links = await _query_rows(target_table, where={"source_system": "grc_legacy_relationship"}, limit=limit)
        existing_source_ids = {row.get("source_id") for row in existing_links}
        relationship_plans: list[dict[str, Any]] = []
        for row in legacy_rows:
            if not row.get("id") or row.get("id") in existing_source_ids:
                continue
            parent = _doc_to_row(await tables.get(parent_table, row.get(parent_key)))
            if not parent:
                continue
            scope_patch, _ = _provider_scope_patch(parent, provider_id)
            relationship_plans.append({"legacy_id": row["id"], "payload": {
                "organization_id": provider_id, **scope_patch, object_key: row.get(parent_key),
                "target_type": "control", "target_id": row.get("control_id"), "relationship": relationship,
                "source_system": "grc_legacy_relationship", "source_id": row["id"],
            }})
        if apply:
            for plan in relationship_plans:
                await tables.insert(target_table, plan["payload"])
        results[legacy_table] = {"rows": len(legacy_rows), "converted": len(relationship_plans),
                                 "target_table": target_table, "samples": relationship_plans[:5]}
    return {"mode": "apply" if apply else "dry_run", "provider_organization_id": provider_id, "tables": results}


def _normalize_name(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _row_is_merged(row: dict) -> bool:
    metadata = _json_loads(row.get("metadata_json"), {})
    return bool(metadata.get("merged_into")) or row.get("review_status") == "rejected"


def _effective_scope_parts(row: dict) -> tuple[list[str] | None, list[str]]:
    patch = _legacy_scope_patch(row)
    applied = patch.get("applied_organizations")
    excluded = patch.get("excluded_organizations")
    return applied if isinstance(applied, list) else None, excluded if isinstance(excluded, list) else []


def _merge_effective_scopes(rows: list[dict]) -> dict:
    has_all = False
    selected: set[str] = set()
    all_excluded_sets: list[set[str]] = []
    for row in rows:
        applied, excluded = _effective_scope_parts(row)
        if applied is None:
            has_all = True
            all_excluded_sets.append(set(excluded))
        else:
            selected.update(applied)
    if has_all:
        excluded = set.intersection(*all_excluded_sets) if all_excluded_sets else set()
        excluded -= selected
        return {"applied_organizations": None, "excluded_organizations": sorted(excluded)}
    return {"applied_organizations": sorted(selected), "excluded_organizations": []}


async def plan_grc_applied_control_merges(
    apply: bool = False,
    confirm_apply: bool = False,
    merge_map: dict[str, str] | None = None,
    merge_by_name: bool = False,
    delete_duplicates: bool = True,
) -> dict:
    _require_apply(apply, confirm_apply, "merging applied controls")
    applied = await _query_rows(TABLE_APPLIED_CONTROLS, limit=1000)
    mapping_rows = await _query_rows(TABLE_CONTROL_MAPPINGS, limit=1000)
    evidence_links = await _query_rows(TABLE_EVIDENCE_LINKS, limit=1000)
    policy_links = await _query_rows(TABLE_POLICY_LINKS, limit=1000)
    exception_links = await _query_rows(TABLE_EXCEPTION_LINKS, limit=1000)
    risk_links = await _query_rows(TABLE_RISK_LINKS, limit=1000)
    response_rows = await _query_rows(TABLE_QUESTIONNAIRE_RESPONSES, limit=1000)

    usage_counts: dict[str, int] = {}
    for row in mapping_rows:
        if row.get("applied_control_id"):
            usage_counts[row["applied_control_id"]] = usage_counts.get(row["applied_control_id"], 0) + 1
    for rows in (evidence_links, policy_links, exception_links, risk_links):
        for row in rows:
            if row.get("target_type") == "applied_control" and row.get("target_id"):
                usage_counts[row["target_id"]] = usage_counts.get(row["target_id"], 0) + 1
    for row in response_rows:
        if row.get("applied_control_id"):
            usage_counts[row["applied_control_id"]] = usage_counts.get(row["applied_control_id"], 0) + 1

    buckets: dict[str, list[dict]] = {}
    for row in applied:
        if _row_is_merged(row):
            continue
        name_key = _normalize_name(row.get("name"))
        if not name_key:
            continue
        key = name_key if merge_by_name else "|".join([
            name_key,
            _normalize_name(row.get("control_type")),
            _normalize_name(row.get("source_system")),
        ])
        if key.strip("|"):
            buckets.setdefault(key, []).append(row)
    candidates = []
    generated_merge_map: dict[str, str] = {}
    for key, rows in buckets.items():
        if len(rows) < 2:
            continue
        canonical = sorted(
            rows,
            key=lambda row: (
                -(usage_counts.get(row.get("id"), 0)),
                row.get("created_at") or row.get("updated_at") or "",
                row.get("id") or "",
            ),
        )[0]
        for row in rows:
            if row.get("id") and row.get("id") != canonical.get("id"):
                generated_merge_map[row["id"]] = canonical["id"]
        candidates.append({
            "key": key,
            "canonical_id": canonical.get("id"),
            "merged_scope": _merge_effective_scopes(rows),
            "rows": [
                {
                    "id": row.get("id"),
                    "name": row.get("name"),
                    "organization_id": row.get("organization_id"),
                    "applied_organizations": row.get("applied_organizations"),
                    "excluded_organizations": row.get("excluded_organizations"),
                    "source_system": row.get("source_system"),
                    "usage_count": usage_counts.get(row.get("id"), 0),
                }
                for row in rows
            ],
        })

    applied_merges = []
    active_merge_map = merge_map or (generated_merge_map if merge_by_name else {})
    if apply and active_merge_map:
        link_tables = [
            (TABLE_CONTROL_MAPPINGS, "applied_control_id", mapping_rows),
            (TABLE_EVIDENCE_LINKS, "target_id", evidence_links),
            (TABLE_POLICY_LINKS, "target_id", policy_links),
            (TABLE_EXCEPTION_LINKS, "target_id", exception_links),
            (TABLE_RISK_LINKS, "target_id", risk_links),
            (TABLE_QUESTIONNAIRE_RESPONSES, "applied_control_id", response_rows),
        ]
        by_id = {row.get("id"): row for row in applied}
        canonical_to_duplicates: dict[str, list[str]] = {}
        for duplicate_id, canonical_id in active_merge_map.items():
            canonical_to_duplicates.setdefault(canonical_id, []).append(duplicate_id)

        for canonical_id, duplicate_ids in canonical_to_duplicates.items():
            duplicate_ids = sorted(set(duplicate_ids))
            canonical = by_id.get(canonical_id)
            if not canonical:
                for duplicate_id in duplicate_ids:
                    applied_merges.append({"duplicate_id": duplicate_id, "canonical_id": canonical_id, "error": "missing canonical row"})
                continue
            duplicates = [by_id.get(duplicate_id) for duplicate_id in duplicate_ids]
            missing = [duplicate_id for duplicate_id, duplicate in zip(duplicate_ids, duplicates) if not duplicate]
            duplicates = [duplicate for duplicate in duplicates if duplicate]
            for duplicate_id in missing:
                applied_merges.append({"duplicate_id": duplicate_id, "canonical_id": canonical_id, "error": "missing duplicate row"})
            if not duplicates:
                continue
            merged_scope = _merge_effective_scopes([canonical, *duplicates])
            duplicate_snapshots = [
                {
                    "id": duplicate.get("id"),
                    "name": duplicate.get("name"),
                    "organization_id": duplicate.get("organization_id"),
                    "applied_organizations": duplicate.get("applied_organizations"),
                    "excluded_organizations": duplicate.get("excluded_organizations"),
                    "source_system": duplicate.get("source_system"),
                    "source_id": duplicate.get("source_id"),
                    "status": duplicate.get("status"),
                    "review_status": duplicate.get("review_status"),
                }
                for duplicate in duplicates
            ]
            metadata = _json_loads(canonical.get("metadata_json"), {})
            metadata.setdefault("merged_duplicate_ids", [])
            metadata["merged_duplicate_ids"] = sorted(set(metadata["merged_duplicate_ids"] + duplicate_ids))
            metadata.setdefault("merged_duplicate_records", [])
            metadata["merged_duplicate_records"] = metadata["merged_duplicate_records"] + duplicate_snapshots
            await tables.update(TABLE_APPLIED_CONTROLS, canonical_id, {
                **merged_scope,
                "metadata_json": _json_dumps(metadata),
            })

            repointed_by_table: dict[str, int] = {}
            for duplicate in duplicates:
                duplicate_id = duplicate.get("id")
                if not duplicate_id:
                    continue
                for table, field, rows in link_tables:
                    repointed = 0
                    for row in rows:
                        if row.get(field) != duplicate_id:
                            continue
                        if field == "target_id" and row.get("target_type") != "applied_control":
                            continue
                        await tables.update(table, row["id"], {field: canonical_id})
                        repointed += 1
                    repointed_by_table[table] = repointed_by_table.get(table, 0) + repointed
                if delete_duplicates:
                    await tables.delete_document(TABLE_APPLIED_CONTROLS, duplicate_id)
                else:
                    await tables.update(TABLE_APPLIED_CONTROLS, duplicate_id, {
                        "review_status": "rejected",
                        "metadata_json": _json_dumps({**_json_loads(duplicate.get("metadata_json"), {}), "merged_into": canonical_id}),
                    })
                applied_merges.append({
                    "duplicate_id": duplicate_id,
                    "canonical_id": canonical_id,
                    "deleted": delete_duplicates,
                    "repointed_by_table": repointed_by_table,
                })

    return {
        "mode": "apply" if apply else "dry_run",
        "merge_by_name": merge_by_name,
        "delete_duplicates": delete_duplicates,
        "candidate_groups": len(candidates),
        "candidates": candidates[:50],
        "generated_merge_map": generated_merge_map,
        "applied_merges": applied_merges,
    }
