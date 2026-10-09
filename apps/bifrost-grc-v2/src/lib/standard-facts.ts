import type { FactDefinition, FactRequirement, GrcFact } from "./types";

type StandardDefinition = FactDefinition & { id: string };
type StandardRequirement = FactRequirement & { id: string };

const definition = (key: string, title: string, category: string, fact_type: FactDefinition["fact_type"], expected_from: FactDefinition["expected_from"], description: string): StandardDefinition => ({
  id: `standard:${key}`, key, title, category, fact_type, expected_from, description,
  organization_id: null, sensitivity: "normal", review_frequency_days: 365, is_active: true,
});

export const STANDARD_FACT_DEFINITIONS: StandardDefinition[] = [
  definition("organization.legal_name", "Legal organization name", "Organization", "short_text", "customer", "The legal name used in contracts and official notices."),
  definition("security.accountable_owner", "Security accountable owner", "Governance", "contact", "customer", "Executive accountable for the security program and plan acceptance."),
  definition("incident.primary_contact", "Primary incident contact", "Incident response", "contact", "customer", "First customer contact for a suspected or confirmed incident."),
  definition("incident.alternate_contact", "Alternate incident contact", "Incident response", "contact", "customer", "Backup customer contact when the primary contact is unavailable."),
  definition("incident.reporting_channel", "Incident reporting channel", "Incident response", "short_text", "shared", "How staff report suspicious activity or a security incident."),
  definition("incident.cyber_insurer", "Cyber insurer and breach hotline", "Incident response", "contact", "customer", "Carrier, policy reference, and incident hotline; avoid storing secrets."),
  definition("incident.privacy_legal_contact", "Privacy or legal contact", "Incident response", "contact", "customer", "Person or firm consulted for legal, privacy, or notification decisions."),
  definition("system.name", "Covered system name", "System boundary", "short_text", "customer", "Plain-language name for the environment covered by the SSP."),
  definition("system.boundary", "System boundary", "System boundary", "long_text", "shared", "People, locations, devices, cloud services, networks, and exclusions covered by the plan."),
  definition("system.data_types", "Sensitive data types", "Data", "list", "customer", "Sensitive or regulated information processed, stored, or transmitted."),
  definition("system.data_retention", "Data retention and disposal", "Data", "long_text", "customer", "Retention periods, business rationale, and disposal approach."),
  definition("system.critical_services", "Critical systems and services", "System boundary", "list", "shared", "Services whose loss would materially affect operations."),
  definition("system.locations", "Operating and data locations", "System boundary", "list", "customer", "Offices, remote work arrangements, hosting regions, and material storage locations."),
  definition("identity.primary_platform", "Identity platform", "Technology", "system_reference", "msp", "Primary directory and authentication platform, including tenant reference."),
  definition("endpoint.management", "Endpoint management coverage", "Technology", "system_reference", "msp", "Endpoint management platform and covered device population."),
  definition("backup.recovery", "Backup and recovery arrangement", "Resilience", "long_text", "shared", "What is backed up, by whom, recovery expectations, and last validation."),
  definition("vendor.critical", "Critical service providers", "Vendors", "list", "shared", "Providers whose access or availability materially affects the covered system."),
  definition("recovery.priority", "Recovery priorities", "Resilience", "long_text", "customer", "Business-approved restoration order and practical recovery objectives."),
];

const req = (key: string, source: string, context: string, priority: FactRequirement["priority"] = "high"): StandardRequirement => ({
  id: `standard:${source}:${key}`, organization_id: null, fact_definition_id: `standard:${key}`, fact_key: key,
  target_type: "policy_template", target_source_id: source, context, required: true, priority,
  responsible_party: STANDARD_FACT_DEFINITIONS.find((item) => item.key === key)?.expected_from ?? "shared", status: "active",
});

export const STANDARD_FACT_REQUIREMENTS: StandardRequirement[] = [
  ...["organization.legal_name", "incident.primary_contact", "incident.alternate_contact", "incident.reporting_channel", "incident.cyber_insurer", "incident.privacy_legal_contact"]
    .map((key) => req(key, "template:incident-response-addendum", "Available to a customer Incident Response addendum")),
  ...["organization.legal_name", "security.accountable_owner", "system.name", "system.boundary", "system.data_types", "system.data_retention", "system.critical_services", "system.locations", "identity.primary_platform", "endpoint.management", "backup.recovery", "vendor.critical", "recovery.priority"]
    .map((key) => req(key, "template:system-security-plan-addendum", "Available to a customer System Security Plan addendum")),
];

export function parseFactValue(fact?: GrcFact | null): unknown {
  if (!fact?.value_json) return null;
  try { return JSON.parse(fact.value_json); } catch { return fact.value_json; }
}

export function formatFactValue(fact?: GrcFact | null): string {
  const value = parseFactValue(fact);
  if (value == null || value === "") return "Not answered";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.name, record.role, record.email, record.phone].filter(Boolean).map(String).join(" · ") || JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
