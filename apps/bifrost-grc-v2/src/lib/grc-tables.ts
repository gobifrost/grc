// Central registry of GRC table slugs. Reference these constants instead of
// hard-coding string literals so renames stay sane.

export const TABLE_FRAMEWORKS = "grc-frameworks";
export const TABLE_DOMAINS = "grc-domains";
export const TABLE_CONTROLS = "grc-controls";
export const TABLE_POLICIES = "grc-policies";
export const TABLE_POLICY_TEMPLATES = "grc-policy-templates";
export const TABLE_RISKS = "grc-risks";
export const TABLE_RISK_LINKS = "grc-risk-links";
export const TABLE_ASSESSMENTS = "grc-assessments";
export const TABLE_ASSESSMENT_CONTROLS = "grc-assessment-controls";
export const TABLE_ASSESSMENT_CONTROL_OVERRIDES = "grc-assessment-control-overrides";
export const TABLE_EVIDENCE = "grc-evidence";
export const TABLE_EXCEPTIONS = "grc-exceptions";
export const TABLE_APPLIED_CONTROLS = "grc-applied-controls";
export const TABLE_APPLIED_CONTROL_HISTORY = "grc-applied-control-history";
export const TABLE_CONTROL_MAPPINGS = "grc-control-mappings";
export const TABLE_EVIDENCE_LINKS = "grc-evidence-links";
export const TABLE_POLICY_LINKS = "grc-policy-links";
export const TABLE_EXCEPTION_LINKS = "grc-exception-links";
export const TABLE_SOURCE_DOCUMENTS = "grc-source-documents";
export const TABLE_QUESTIONNAIRES = "grc-questionnaires";
export const TABLE_QUESTIONNAIRE_SECTIONS = "grc-questionnaire-sections";
export const TABLE_QUESTIONNAIRE_ITEMS = "grc-questionnaire-items";
export const TABLE_QUESTIONNAIRE_RUNS = "grc-questionnaire-runs";
export const TABLE_QUESTIONNAIRE_RESPONSES = "grc-questionnaire-responses";
export const TABLE_QUESTIONNAIRE_CONTROL_LINKS = "grc-questionnaire-control-links";
export const TABLE_QUESTIONNAIRE_PROPOSALS = "grc-questionnaire-proposals";
export const TABLE_CONTROL_CROSSWALKS = "grc-control-crosswalks";
export const TABLE_RECOMMENDATIONS = "grc-questionnaire-recommendations";
export const TABLE_FACT_DEFINITIONS = "grc-fact-definitions";
export const TABLE_FACTS = "grc-facts";
export const TABLE_FACT_REQUIREMENTS = "grc-fact-requirements";
export const TABLE_POLICY_FACT_SNAPSHOTS = "grc-policy-fact-snapshots";

// Tenant-safe v2 workflows are registered loose during coexistence. These
// portable references keep working after those same rows are captured.
export const WF_UPDATE_ASSESSMENT_CONTROL = "workflows/grc_v2/grc_assessment.py::update_assessment_control";
export const WF_GET_UPLOAD_URL = "workflows/grc_v2/grc_files.py::grc_v2_get_upload_url";
export const WF_GET_DOWNLOAD_URL = "workflows/grc_v2/grc_files.py::grc_v2_get_download_url";
export const WF_GET_POLICY_UPLOAD_URL = "workflows/grc_v2/grc_files.py::grc_v2_get_policy_upload_url";
export const WF_GET_POLICY_DOWNLOAD_URL = "workflows/grc_v2/grc_files.py::grc_v2_get_policy_download_url";
export const WF_READ_GRC_WORKSPACE_TEXT_FILE = "workflows/grc_v2/grc_files.py::read_grc_workspace_text_file";
export const WF_EXTRACT_GRC_QUESTIONNAIRE = "workflows/grc_v2/grc_questionnaires.py::grc_v2_extract_grc_questionnaire";
export const WF_DRAFT_GRC_QUESTIONNAIRE_ANSWERS = "workflows/grc_v2/grc_questionnaires.py::grc_v2_draft_grc_questionnaire_answers";
export const WF_APPLY_GRC_QUESTIONNAIRE_ANSWERS = "workflows/grc_v2/grc_questionnaires.py::grc_v2_apply_grc_questionnaire_answers";
export const WF_SET_ASSESSMENT_CONTROL_OVERRIDE = "workflows/grc_v2/grc_refactor.py::set_grc_assessment_control_override";
export const WF_CLEAR_ASSESSMENT_CONTROL_OVERRIDE = "workflows/grc_v2/grc_refactor.py::clear_grc_assessment_control_override";
export const WF_COUNT_OPEN_ITEMS = "workflows/grc_v2/grc_agent_tools.py::bifrost_grc_count_open_items";
export const WF_GET_OPEN_ITEMS = "workflows/grc_v2/grc_agent_tools.py::bifrost_grc_get_open_items";
export const WF_RESOLVE_OPEN_ITEM = "workflows/grc_v2/grc_agent_tools.py::bifrost_grc_resolve_open_item";
export const WF_MANAGE_FACT = "workflows/grc_v2/grc_agent_tools.py::bifrost_grc_manage_fact";
export const WF_GET_FACT_WORKSPACE = "workflows/grc_v2/grc_agent_tools.py::bifrost_grc_get_fact_workspace";
export const WF_DEFAULT_POLICY_RECIPIENTS = "workflows/grc_v2/grc_policy_campaign.py::grc_v2_default_policy_recipients";
export const WF_SEND_POLICY_CAMPAIGN = "workflows/grc_v2/grc_policy_campaign.py::grc_v2_send_policy_campaign";
export const WF_LIST_POLICY_CAMPAIGNS = "workflows/grc_v2/grc_policy_admin.py::grc_v2_list_policy_campaigns";
export const WF_GET_POLICY_CAMPAIGN = "workflows/grc_v2/grc_policy_admin.py::grc_v2_get_policy_campaign";
export const WF_WAIVE_POLICY_ASSIGNMENT = "workflows/grc_v2/grc_policy_admin.py::grc_v2_waive_policy_assignment";
export const WF_REMIND_POLICY_ASSIGNEES = "workflows/grc_v2/grc_policy_admin.py::grc_v2_remind_policy_assignees";
export const WF_EXPORT_POLICY_CAMPAIGN_EVIDENCE = "workflows/grc_v2/grc_policy_admin.py::grc_v2_export_policy_campaign_evidence";
export const WF_REISSUE_POLICY_CAMPAIGN = "workflows/grc_v2/grc_policy_admin.py::grc_v2_reissue_policy_campaign";
export const WF_LIST_BASE_POLICY_ORGANIZATIONS = "workflows/grc_v2/grc_policy_admin.py::grc_v2_list_base_policy_organizations";
export const WF_REISSUE_FOR_BASE_POLICY = "workflows/grc_v2/grc_policy_admin.py::grc_v2_reissue_for_base_policy";
export const WF_EXPORT_POLICY_PDF = "workflows/grc_v2/grc_exports.py::grc_v2_export_policy_pdf";
export const WF_EXPORT_ASSESSMENT_PDF = "workflows/grc_v2/grc_exports.py::grc_v2_export_assessment_pdf";
export const WF_EXPORT_CAMPAIGN_PDF = "workflows/grc_v2/grc_exports.py::grc_v2_export_campaign_pdf";

export const PLATFORM_ORG_ID = "00000000-0000-0000-0000-000000000002";
