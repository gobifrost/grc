"""Assessment result mutations."""

from __future__ import annotations

from typing import Any

from bifrost import UserError, tables, workflow

from functions.grc_auth import require_row_access


TABLE_ASSESSMENTS = "grc-assessments"
TABLE_ASSESSMENT_CONTROLS = "grc-assessment-controls"


def _row(document: Any) -> dict | None:
    if document is None:
        return None
    data = getattr(document, "data", None)
    if data is None and isinstance(document, dict):
        data = document.get("data", document)
    if not isinstance(data, dict):
        return None
    output = dict(data)
    output["id"] = str(
        getattr(document, "id", None)
        or (document.get("id") if isinstance(document, dict) else output.get("id"))
        or ""
    )
    return output


def _rows(result: Any) -> list[dict]:
    documents = getattr(result, "documents", None)
    if documents is None and isinstance(result, dict):
        documents = result.get("documents") or result.get("rows")
    if documents is None and isinstance(result, list):
        documents = result
    return [row for row in (_row(doc) for doc in (documents or [])) if row]


@workflow(
    name="update_grc_assessment_control",
    description="Update one tenant assessment control and recompute assessment progress.",
    category="grc",
)
async def update_assessment_control(
    assessment_control_id: str,
    status: str | None = None,
    implementation_percentage: float | None = None,
    notes: str | None = None,
) -> dict:
    if not assessment_control_id:
        raise UserError("assessment_control_id is required")
    current = _row(await tables.get(TABLE_ASSESSMENT_CONTROLS, assessment_control_id))
    owner_organization_id = require_row_access(current, resource="assessment control")

    patch: dict[str, Any] = {}
    if status is not None:
        allowed = {
            "compliant",
            "partially_compliant",
            "non_compliant",
            "not_assessed",
            "not_applicable",
        }
        if status not in allowed:
            raise UserError(f"invalid control status: {status}")
        patch["status"] = status
    if implementation_percentage is not None:
        value = max(0.0, min(float(implementation_percentage), 100.0))
        patch["implementation_percentage"] = value
    if notes is not None:
        patch["notes"] = notes
    if not patch:
        raise UserError("at least one field is required")

    assessment_id = current.get("assessment_id")
    if not assessment_id:
        raise UserError("assessment control has no assessment_id")
    assessment = _row(await tables.get(TABLE_ASSESSMENTS, assessment_id))
    assessment_owner_id = require_row_access(assessment, resource="assessment")
    if assessment_owner_id != owner_organization_id:
        raise UserError("assessment control owner does not match its assessment owner")

    updated = _row(await tables.update(TABLE_ASSESSMENT_CONTROLS, assessment_control_id, patch))
    progress = 0.0
    children = _rows(
        await tables.query(
            TABLE_ASSESSMENT_CONTROLS,
            where={
                "assessment_id": assessment_id,
            },
            limit=1000,
        )
    )
    if children:
        assessed = sum(1 for row in children if row.get("status") not in (None, "not_assessed"))
        progress = round(assessed * 100 / len(children), 2)
    await tables.update(TABLE_ASSESSMENTS, assessment_id, {"progress_percentage": progress})
    return {"success": True, "assessment_control": updated, "progress_percentage": progress}
