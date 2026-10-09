// Row shapes for grc-* tables. `useTable` returns rows with JSONB columns
// flattened to the top level alongside id/created_at/etc., so these
// interfaces describe the merged shape.

export interface RowBase {
  id: string;
  organization_id?: string | null;
  applied_organizations?: string[] | null;
  excluded_organizations?: string[] | null;
  created_at?: string;
  updated_at?: string;
  created_by?: string | null;
  updated_by?: string | null;
}

// ----- grc-frameworks -----
export interface Framework extends RowBase {
  name: string;
  description?: string | null;
  version?: string | null;
  scope?: "global" | "organization" | null;
  is_active?: boolean;
}

// ----- grc-domains -----
export interface Domain extends RowBase {
  framework_id: string;
  name: string;
  description?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

// ----- grc-controls -----
export interface Control extends RowBase {
  framework_id: string;
  domain_id?: string | null;
  control_id: string;
  title: string;
  description?: string | null;
  guidance?: string | null;
  sort_order?: number;
  is_active?: boolean;
  scope?: "global" | "organization" | null;
}

// ----- grc-policies -----
export type PolicyStatus = "draft" | "active" | "archived";
export type PolicyType = "policy" | "ai_acceptable_use" | "incident_response_plan" | "system_security_plan" | "procedure";
export type PolicyRole = "standalone" | "base" | "extension";
export type PolicyExtensionMode = "supplement" | "deviation";
export interface PolicyAttachment {
  id: string;
  path: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  kind: "image" | "file";
}
export interface Policy extends RowBase {
  name: string;
  description?: string | null;
  content?: string | null;
  version?: string;
  status?: PolicyStatus;
  approved_by?: string | null;
  approved_at?: string | null;
  review_date?: string | null;
  last_reviewed_at?: string | null;
  review_frequency_days?: number | null;
  policy_type?: PolicyType | null;
  policy_role?: PolicyRole | null;
  base_policy_id?: string | null;
  extension_mode?: PolicyExtensionMode | null;
  reviewed_base_version?: string | null;
  owner?: string | null;
  source_system?: string | null;
  source_id?: string | null;
  source_url?: string | null;
  attachments_json?: string | null;
  fact_snapshot_json?: string | null;
  fact_snapshot_at?: string | null;
  template_id?: string | null;
  template_version?: string | null;
}

export interface PolicyTemplate extends RowBase {
  name: string;
  description?: string | null;
  content?: string | null;
  content_updated_at?: string | null;
  field_schema?: Array<{ key: string; required: boolean; description: string }> | null;
  version?: string;
  status?: PolicyStatus;
  policy_type?: PolicyType | null;
  default_policy_role?: PolicyRole | null;
  default_extension_mode?: PolicyExtensionMode | null;
  default_name?: string | null;
  base_policy_type?: PolicyType | null;
  source_system?: string | null;
  source_id?: string | null;
  source_url?: string | null;
}

export type FactType = "contact" | "short_text" | "long_text" | "boolean" | "date" | "duration" | "number" | "select" | "list" | "system_reference" | "vendor_reference" | "evidence_reference";
export type FactStatus = "unanswered" | "proposed" | "needs_verification" | "verified" | "stale" | "not_applicable" | "accepted_unknown";
export interface FactDefinition extends RowBase {
  key: string;
  title: string;
  description?: string | null;
  category?: string | null;
  fact_type?: FactType;
  expected_from?: "msp" | "customer" | "shared";
  sensitivity?: "normal" | "restricted";
  review_frequency_days?: number;
  options_json?: string | null;
  default_value_json?: string | null;
  is_active?: boolean;
}
export interface GrcFact extends RowBase {
  organization_id?: string | null;
  applied_organizations?: string[] | null;
  excluded_organizations?: string[] | null;
  scope_id?: string | null;
  scope_kind?: "one" | "some" | "all";
  scope_size?: number | null;
  effective_scope_kind?: "one" | "some" | "all";
  effective_scope_size?: number | null;
  fact_definition_id: string;
  fact_key: string;
  value_json?: string | null;
  status?: FactStatus;
  source_system?: string | null;
  source_id?: string | null;
  source_url?: string | null;
  confidence?: number | null;
  provided_by?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
  review_due?: string | null;
  notes?: string | null;
  revision?: number;
}
export interface FactRequirement extends RowBase {
  fact_definition_id: string;
  fact_key: string;
  target_type: "policy" | "policy_template" | "assessment" | "assessment_control" | "control" | "risk" | "exception" | "organization";
  target_id?: string | null;
  target_source_id?: string | null;
  context?: string | null;
  required?: boolean;
  priority?: "low" | "medium" | "high" | "critical";
  responsible_party?: "msp" | "customer" | "shared";
  assigned_to?: string | null;
  due_date?: string | null;
  status?: "active" | "waived";
  waiver_reason?: string | null;
}
export interface PolicyFactSnapshot extends RowBase {
  organization_id: string;
  policy_id: string;
  effective_policy_id?: string | null;
  policy_version?: string | null;
  base_version?: string | null;
  snapshot_json: string;
  captured_at: string;
  captured_by?: string | null;
}

// ----- grc-risks -----
export type RiskLevel = "very_high" | "high" | "medium" | "low";
export type RiskStatus = "open" | "mitigated" | "accepted" | "closed";
export interface Risk extends RowBase {
  name: string;
  description?: string | null;
  category?: string | null;
  likelihood?: RiskLevel | null;
  impact?: RiskLevel | null;
  risk_level?: RiskLevel | null;
  status?: RiskStatus;
  owner?: string | null;
  mitigation_plan?: string | null;
}

export interface RiskLink extends RowBase {
  organization_id: string;
  risk_id: string;
  target_type: GrcLinkTarget;
  target_id: string;
  relationship?: string | null;
  source_system?: string | null;
  source_id?: string | null;
  metadata_json?: string | null;
}

// ----- grc-assessments -----
export type AssessmentStatus = "draft" | "in_progress" | "completed" | "reviewed";
export interface Assessment extends RowBase {
  framework_id: string;
  name: string;
  status?: AssessmentStatus;
  progress_percentage?: number;
  started_at?: string | null;
  completed_at?: string | null;
  assigned_to?: string | null;
  // Org scope for this single assessment:
  //   null       → applies to ALL orgs (perpetual; new orgs auto-included)
  //   []         → applied to none yet (draft)
  //   [a, b, c]  → applied to those orgs only
  applied_organizations?: string[] | null;
}

// ----- grc-assessment-controls -----
// Represents the DEFAULT status of a control across all orgs the assessment
// applies to. Per-org divergence is stored in grc-assessment-control-overrides.
export type ControlStatus =
  | "compliant"
  | "partially_compliant"
  | "non_compliant"
  | "not_assessed"
  | "not_applicable";
export interface AssessmentControl extends RowBase {
  assessment_id: string;
  control_id: string;
  status?: ControlStatus;
  implementation_percentage?: number;
  notes?: string | null;
  assessed_by?: string | null;
  assessed_at?: string | null;
}

// ----- grc-assessment-control-overrides -----
// Sparse: only rows that DIFFER from the assessment-control default exist.
export interface AssessmentControlOverride extends RowBase {
  assessment_id: string;
  control_id: string;
  /** Customer whose effective result diverges from the provider default. */
  customer_organization_id: string;
  status: ControlStatus;
  implementation_percentage?: number;
  notes?: string | null;
  assessed_by?: string | null;
  assessed_at?: string | null;
}

// ----- grc-evidence -----
export type EvidenceType = "document" | "url" | "screenshot" | "note";
export type ReviewStatus = "draft" | "needs_review" | "approved" | "rejected";
export interface Evidence extends RowBase {
  assessment_id?: string | null;
  control_id?: string | null;
  name: string;
  type?: EvidenceType | null;
  url?: string | null;
  file_path?: string | null;
  notes?: string | null;
  notes_markdown?: string | null;
  urls_json?: string | null;
  attachments_json?: string | null;
  provenance_json?: string | null;
  review_status?: ReviewStatus | null;
  last_reviewed_at?: string | null;
  review_due?: string | null;
  review_frequency_days?: number | null;
  uploaded_by?: string | null;
  tags?: string[] | null;
}

// ----- grc-exceptions -----
export type ExceptionStatus = "pending" | "approved" | "denied" | "expired";
export interface Exception extends RowBase {
  control_id?: string | null;
  name?: string | null;
  reason: string;
  status?: ExceptionStatus;
  approved_by?: string | null;
  expires_at?: string | null;
  compensating_controls?: string | null;
}

// ----- grc-applied-controls -----
export type AppliedControlStatus = "active" | "planned" | "partial" | "retired" | "unknown";
export type AppliedControlMaturity =
  | "informal"
  | "documented"
  | "implemented"
  | "measured"
  | "optimized"
  | "unknown";
export interface AppliedControl extends RowBase {
  organization_id?: string | null;
  name: string;
  description?: string | null;
  control_type?: string | null;
  status?: AppliedControlStatus | null;
  maturity?: AppliedControlMaturity | null;
  owner?: string | null;
  review_status?: ReviewStatus | null;
  last_reviewed_at?: string | null;
  source_system?: string | null;
  source_id?: string | null;
  source_url?: string | null;
  tags_json?: string | null;
  metadata_json?: string | null;
}

// ----- grc-control-mappings -----
export type ControlMappingRelationship =
  | "satisfies"
  | "partially_satisfies"
  | "supports"
  | "conflicts"
  | "informational";
export type LinkStatus = "suggested" | "accepted" | "rejected" | "imported" | "applied";
export interface ControlMapping extends RowBase {
  organization_id?: string | null;
  applied_control_id: string;
  control_id: string;
  relationship: ControlMappingRelationship;
  confidence?: number | null;
  status?: LinkStatus | null;
  rationale?: string | null;
  source_system?: string | null;
  source_id?: string | null;
  metadata_json?: string | null;
}

// ----- reusable GRC links -----
export type GrcLinkTarget =
  | "applied_control"
  | "control"
  | "assessment"
  | "assessment_control"
  | "policy"
  | "exception"
  | "risk"
  | "source_document"
  | "questionnaire_item"
  | "questionnaire_response"
  | "evidence";
export interface EvidenceLink extends RowBase {
  organization_id?: string | null;
  evidence_id: string;
  target_type: GrcLinkTarget;
  target_id: string;
  relationship?: string | null;
  citation?: string | null;
  source_system?: string | null;
  source_id?: string | null;
  metadata_json?: string | null;
}
export interface PolicyLink extends RowBase {
  organization_id?: string | null;
  policy_id: string;
  target_type: GrcLinkTarget;
  target_id: string;
  relationship?: string | null;
  source_system?: string | null;
  source_id?: string | null;
}
export interface ExceptionLink extends RowBase {
  organization_id?: string | null;
  exception_id: string;
  target_type: GrcLinkTarget;
  target_id: string;
  relationship?: string | null;
  source_system?: string | null;
  source_id?: string | null;
}

// ----- grc-source-documents -----
export interface SourceDocument extends RowBase {
  organization_id: string;
  name: string;
  document_type?: string | null;
  file_name?: string | null;
  file_path?: string | null;
  url?: string | null;
  mime_type?: string | null;
  checksum?: string | null;
  page_count?: number | null;
  extracted_text_path?: string | null;
  source_system?: string | null;
  source_id?: string | null;
  metadata_json?: string | null;
}

// ----- grc-questionnaires -----
export type QuestionnaireStatus =
  | "draft"
  | "extracting"
  | "answering"
  | "needs_review"
  | "completed"
  | "failed";
export interface Questionnaire extends RowBase {
  organization_id: string;
  name: string;
  source_document_id?: string | null;
  assessment_id?: string | null;
  carrier?: string | null;
  status: QuestionnaireStatus;
  extraction_model?: string | null;
  extracted_at?: string | null;
  completed_at?: string | null;
  metadata_json?: string | null;
}
export interface QuestionnaireSection extends RowBase {
  organization_id: string;
  questionnaire_id: string;
  parent_section_id?: string | null;
  title: string;
  sort_order?: number | null;
  source_page?: number | null;
  source_anchor?: string | null;
}
export type QuestionnaireItemStatus =
  | "extracted"
  | "answering"
  | "answered"
  | "needs_review"
  | "accepted"
  | "rejected";
export interface QuestionnaireItem extends RowBase {
  organization_id: string;
  questionnaire_id: string;
  section_id?: string | null;
  question_text: string;
  normalized_topic?: string | null;
  answer_type?: string | null;
  audience?: "msp" | "customer" | null;
  sort_order?: number | null;
  source_page?: number | null;
  source_anchor?: string | null;
  source_excerpt?: string | null;
  extraction_confidence?: number | null;
  status?: QuestionnaireItemStatus | null;
  metadata_json?: string | null;
}
export type QuestionnaireResponseStatus = "draft" | "needs_review" | "accepted" | "rejected" | "applied";
export interface QuestionnaireResponse extends RowBase {
  organization_id: string;
  questionnaire_id: string;
  item_id: string;
  draft_answer?: string | null;
  final_answer?: string | null;
  status: QuestionnaireResponseStatus;
  confidence?: number | null;
  generated_by?: string | null;
  citations_json?: string | null;
  applied_control_id?: string | null;
  assessment_control_id?: string | null;
  metadata_json?: string | null;
}
export type QuestionnaireRunType = "extraction" | "answering" | "apply_to_grc" | "import";
export type QuestionnaireRunStatus = "queued" | "running" | "completed" | "failed";
export interface QuestionnaireRun extends RowBase {
  organization_id: string;
  questionnaire_id: string;
  run_type: QuestionnaireRunType;
  status: QuestionnaireRunStatus;
  model?: string | null;
  prompt_version?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  stats_json?: string | null;
  metadata_json?: string | null;
}
export type QuestionnaireControlLinkTarget =
  | "applied_control"
  | "control"
  | "assessment_control"
  | "evidence"
  | "policy";
export type QuestionnaireControlLinkStatus = "suggested" | "accepted" | "rejected" | "applied";
export interface QuestionnaireControlLink extends RowBase {
  organization_id: string;
  questionnaire_id: string;
  item_id?: string | null;
  response_id?: string | null;
  target_type: QuestionnaireControlLinkTarget;
  target_id: string;
  relationship?: string | null;
  confidence?: number | null;
  rationale?: string | null;
  status?: QuestionnaireControlLinkStatus | null;
}

export type QuestionnaireProposalAction = "use_existing" | "create" | "update_scope";
export type QuestionnaireProposalTarget = "applied_control" | "evidence" | "policy" | "risk" | "mapping" | "link";
export type QuestionnaireProposalStatus = "proposed" | "accepted" | "rejected" | "applied";
export interface QuestionnaireProposal extends RowBase {
  organization_id: string;
  questionnaire_id: string;
  item_id?: string | null;
  response_id?: string | null;
  action: QuestionnaireProposalAction;
  target_type: QuestionnaireProposalTarget;
  target_id?: string | null;
  draft_payload_json?: string | null;
  relationship_payloads_json?: string | null;
  status?: QuestionnaireProposalStatus | null;
  confidence?: number | null;
  needs_review?: boolean | null;
  rationale?: string | null;
  content_hash: string;
  metadata_json?: string | null;
}
