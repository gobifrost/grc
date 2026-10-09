"""Governed writes for compliance records with server-owned attribution."""
from typing import Any
from bifrost import UserError, tables, workflow
from functions.grc_auth import caller_organization_id, is_platform_scope, require_organization_access, require_provider
from functions.grc_attribution import EDITABLE_FIELDS, authenticated_actor_id, attributed_payload


def _document(raw: Any) -> dict | None:
    if raw is None: return None
    if isinstance(raw, dict): return raw if "data" in raw else {"id": raw.get("id"), "data": raw}
    if hasattr(raw, "model_dump"): return raw.model_dump(mode="json")
    data = dict(getattr(raw, "data", None) or {})
    return {"id": str(getattr(raw, "id", "")), "data": data}


@workflow(name="grc_v2_mutate_record", category="grc", description="Edit compliance records with authenticated approval and attribution.")
async def grc_v2_mutate_record(table: str, action: str, payload: dict | None = None, row_id: str | None = None) -> Any:
    authenticated_actor_id()
    if table not in EDITABLE_FIELDS: raise UserError("Unsupported governed table.")
    if action not in {"create", "update", "delete"}: raise UserError("Unsupported action.")
    if action != "create" and not row_id: raise UserError("row_id is required.")
    if action != "delete" and not isinstance(payload, dict): raise UserError("payload is required.")
    existing_doc = _document(await tables.get(table, row_id)) if row_id else None
    if action != "create" and not existing_doc: raise UserError("Record not found.")
    existing = existing_doc["data"] if existing_doc else None
    if existing:
        owner = existing.get("organization_id")
        if owner is None: require_provider("Provider access is required for global records.")
        else: require_organization_access(owner, resource="compliance record")
    proposed = dict(payload or {})
    owner = proposed.get("organization_id", existing.get("organization_id") if existing else caller_organization_id())
    if owner is None: require_provider("Provider access is required for global records.")
    else: require_organization_access(owner, resource="compliance record")
    if not is_platform_scope():
        if existing and owner != existing.get("organization_id"): raise UserError("Record ownership cannot be changed.")
        for key in ("applied_organizations", "excluded_organizations"):
            if key in proposed and proposed[key] != ([owner] if key == "applied_organizations" else []):
                raise UserError("Customer records must remain scoped to your organization.")
        if not existing:
            proposed["organization_id"] = owner
            if "applied_organizations" in EDITABLE_FIELDS[table]:
                proposed["applied_organizations"] = [owner]
                proposed["excluded_organizations"] = []
    from workflows.grc_v2.grc_agent_tools import _record_change
    if action == "delete":
        require_provider("Only provider users may hard-delete compliance records; customers must archive them.")
        deleted = bool(await tables.delete_document(table, row_id))
        if deleted:
            await _record_change(entity_type=table, entity_id=row_id, event_type="delete", organization_id=owner, before=existing, after=None, strict=True)
        return deleted
    governed = attributed_payload(table, proposed, existing)
    if action == "create":
        result = _document(await tables.insert(table, governed))
    else:
        result = _document(await tables.update(table, row_id, governed)) or _document(await tables.get(table, row_id))
    if result:
        await _record_change(entity_type=table, entity_id=result["id"], event_type=action, organization_id=owner, before=existing, after=result["data"], strict=True)
    return result
