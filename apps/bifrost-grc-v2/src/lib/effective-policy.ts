import { appliesToOrg } from "./scope";
import type { Policy } from "./types";

export function effectivePoliciesForOrganization(policies: Policy[], organizationId: string | null): Policy[] {
  if (!organizationId) return policies;
  const applicable = policies.filter((policy) => appliesToOrg(policy, organizationId));
  const extendedBaseIds = new Set(
    applicable
      .filter((policy) => policy.policy_role === "extension" && policy.base_policy_id)
      .map((policy) => policy.base_policy_id as string),
  );
  return applicable.filter((policy) => !extendedBaseIds.has(policy.id));
}

export function composeEffectivePolicy(base: Policy, extension: Policy): string {
  const baseContent = (base.content ?? "").trim();
  const extensionContent = (extension.content ?? "").trim().replace(/^\s*#\s+[^\n]+\n+/, "");
  return [
    baseContent,
    "---",
    "## Customer addendum",
    extensionContent,
  ].filter(Boolean).join("\n\n");
}
