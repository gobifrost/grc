"""Bifrost GRC settings workflows.

Powers the GRC app's Settings page:
- grc_list_pdf_models: PDF-capable OpenRouter models for the questionnaire-model dropdown.
- grc_get_questionnaire_settings: current effective model (override + integration default).
- grc_set_questionnaire_settings: write the GRC_QUESTIONNAIRE_MODEL override.
"""
from typing import Any

from bifrost import config, integrations, tables, workflow

from functions.grc_auth import require_provider


MODELS_TABLE = "buildfrost-models"
GRC_MODEL_CONFIG_KEY = "GRC_QUESTIONNAIRE_MODEL"


def _docs(result: Any) -> list[dict]:
    docs = getattr(result, "documents", None)
    if docs is None and isinstance(result, dict):
        docs = result.get("documents") or []
    if docs is None:
        try:
            docs = list(result)
        except TypeError:
            docs = []
    out: list[dict] = []
    for d in docs:
        data = getattr(d, "data", None)
        if data is None and isinstance(d, dict):
            data = d.get("data", d)
        if isinstance(data, dict):
            out.append(data)
    return out


@workflow(
    name="grc_list_pdf_models",
    description="List PDF-capable OpenRouter models (Bifrost GRC questionnaire model selector).",
)
async def grc_list_pdf_models() -> dict:
    result = await tables.query(MODELS_TABLE, limit=1000)
    rows = _docs(result)
    pdf = [r for r in rows if r.get("supports_pdf")]
    pdf.sort(key=lambda r: (r.get("name") or r.get("model_id") or "").lower())
    models = [
        {
            "model_id": r.get("model_id"),
            "name": r.get("name") or r.get("model_id"),
            "context_length": r.get("context_length"),
            "pricing_input_per_mtok": r.get("pricing_input_per_mtok"),
            "pricing_output_per_mtok": r.get("pricing_output_per_mtok"),
        }
        for r in pdf
        if r.get("model_id")
    ]
    return {"models": models, "count": len(models)}


@workflow(
    name="grc_get_questionnaire_settings",
    description="Read the Bifrost GRC questionnaire model override and the effective resolved model.",
)
async def grc_get_questionnaire_settings() -> dict:
    override = await config.get(GRC_MODEL_CONFIG_KEY)
    integ = await integrations.get("OpenRouter", scope="global") or await integrations.get("OpenRouter")
    integration_default = None
    if integ and integ.config:
        integration_default = integ.config.get("default_model")
    effective = override or integration_default
    return {
        "override_model": override or "",
        "integration_default_model": integration_default or "",
        "effective_model": effective or "",
        "config_key": GRC_MODEL_CONFIG_KEY,
    }


@workflow(
    name="grc_set_questionnaire_settings",
    description="Set or clear the Bifrost GRC questionnaire model override (GRC_QUESTIONNAIRE_MODEL).",
)
async def grc_set_questionnaire_settings(model: str | None = None) -> dict:
    require_provider("Only Platform Org GRC administrators can change questionnaire settings.")
    cleaned = (model or "").strip()
    if cleaned:
        await config.set(GRC_MODEL_CONFIG_KEY, cleaned)
        return {"status": "set", "config_key": GRC_MODEL_CONFIG_KEY, "value": cleaned}
    await config.delete(GRC_MODEL_CONFIG_KEY)
    return {"status": "cleared", "config_key": GRC_MODEL_CONFIG_KEY}
