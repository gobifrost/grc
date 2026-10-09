"""Server-owned attribution for user-editable compliance records."""
from datetime import datetime, timezone
from bifrost import UserError, context

PROTECTED_FIELDS = {'completed_by', 'resolved_by', 'resolved_at', 'completed_at', 'approved_by', 'approved_at', 'uploaded_by'}
EDITABLE_FIELDS = {
    'grc-evidence': {
        'applied_organizations', 'assessment_id', 'attachments_json', 'control_id',
        'excluded_organizations', 'file_path', 'last_reviewed_at', 'name', 'notes',
        'notes_markdown', 'organization_id', 'provenance_json', 'review_due',
        'review_frequency_days', 'review_status', 'tags', 'type', 'url', 'urls_json',
    },
    'grc-exceptions': {
        'applied_organizations', 'compensating_controls', 'control_id', 'excluded_organizations',
        'expires_at', 'name', 'organization_id', 'reason', 'status',
    },
    'grc-findings': {
        'body', 'organization_id', 'owner', 'related_record_id', 'related_record_type',
        'resolution_notes', 'severity', 'source_id', 'source_system', 'source_url', 'status',
        'target_date', 'title',
    },
    'grc-policies': {
        'applied_organizations', 'attachments_json', 'base_policy_id', 'content', 'description',
        'excluded_organizations', 'extension_mode', 'fact_snapshot_at', 'fact_snapshot_json',
        'last_reviewed_at', 'name', 'organization_id', 'owner', 'policy_role', 'policy_type',
        'review_date', 'review_frequency_days', 'reviewed_base_version', 'source_id',
        'source_system', 'source_url', 'status', 'template_id', 'template_version', 'version',
    },
    'grc-questionnaire-recommendations': {
        'body', 'completion_notes', 'content_hash', 'gap_kind', 'item_id', 'metadata_json',
        'organization_id', 'questionnaire_id', 'response_id', 'severity', 'status', 'title',
        'who_acts',
    },
}


def authenticated_actor_id(execution_context=None) -> str:
    caller = context if execution_context is None else execution_context
    user = getattr(caller, "user", None)
    actor = getattr(user, "id", None) or getattr(caller, "user_id", None)
    if getattr(caller, "is_function_key", False) or not actor or str(actor) == "00000000-0000-0000-0000-000000000001":
        raise UserError("An authenticated user is required for compliance attribution.")
    return str(actor)


def attributed_payload(table: str, payload: dict, existing: dict | None = None, *, execution_context=None) -> dict:
    supplied = set(payload) & PROTECTED_FIELDS
    if supplied:
        raise UserError("Attribution is recorded from your authenticated context; remove: " + ", ".join(sorted(supplied)))
    unknown = set(payload) - EDITABLE_FIELDS[table]
    if unknown:
        raise UserError("Unsupported record fields: " + ", ".join(sorted(unknown)))
    actor = authenticated_actor_id(execution_context)
    result = dict(payload)
    before = existing or {}
    now = datetime.now(timezone.utc).isoformat()
    state = payload.get("status", before.get("status"))
    if table in {"grc-policies", "grc-exceptions"}:
        approved = "active" if table == "grc-policies" else "approved"
        content_fields = {"content", "version", "name", "base_policy_id", "extension_mode"} if table == "grc-policies" else {"reason", "compensating_controls", "control_id"}
        changed = existing and any(key in payload and payload[key] != before.get(key) for key in content_fields)
        if changed and state == approved:
            state = "draft" if table == "grc-policies" else "pending"
            result["status"] = state
        if state == approved and (not existing or before.get("status") != approved or changed or not before.get("approved_by")):
            result["approved_by"] = actor
            if table == "grc-policies": result["approved_at"] = now
        elif state != approved:
            result["approved_by"] = None
            if table == "grc-policies": result["approved_at"] = None
    elif table == "grc-evidence":
        if not existing or any(key in payload and payload[key] != before.get(key) for key in {"file_path", "attachments_json"}):
            result["uploaded_by"] = actor
    else:
        prefix = "resolved" if table == "grc-findings" else "completed"
        terminal = {"resolved", "dismissed", "accepted"} if table == "grc-findings" else {"done", "dismissed"}
        if state in terminal and (not existing or state != before.get("status") or not before.get(prefix + "_by")):
            result[prefix + "_by"] = actor
            result[prefix + "_at"] = now
        elif state not in terminal:
            result[prefix + "_by"] = None
            result[prefix + "_at"] = None
    return result
