export function splitAssignments(assignments) {
  const rows = Array.isArray(assignments) ? assignments : [];
  return {
    toSign: rows.filter((assignment) => assignment.status === "assigned"),
    signed: rows.filter((assignment) => assignment.status === "accepted"),
  };
}

export function assignmentForId(assignments, assignmentId) {
  return (Array.isArray(assignments) ? assignments : []).find(
    (assignment) => assignment.assignment_id === assignmentId,
  );
}

export function policySummary(policies) {
  const bundle = addendumBundle(policies);
  if (bundle) return `${bundle.base.name} (version ${bundle.base.version}) with the ${bundle.organizationName} addendum (version ${bundle.extension.version})`;
  const labels = (Array.isArray(policies) ? policies : [])
    .filter((policy) => policy?.name)
    .map((policy) => `${policy.name}${policy.version ? ` (version ${policy.version})` : ""}`);
  if (labels.length < 2) return labels[0] ?? "Policy";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

export function addendumBundle(policies) {
  if (!Array.isArray(policies) || policies.length !== 2) return null;
  const base = policies.find((policy) => policy?.policy_role === "base");
  const extension = policies.find((policy) => policy?.policy_role === "extension" && policy.base_policy_id === base?.id);
  if (!base || !extension) return null;
  return { base, extension, organizationName: extension.organization_name || "Your Organization" };
}

export function assignmentVersionLabel(policies) {
  const bundle = addendumBundle(policies);
  if (bundle) return `Version ${bundle.base.version} · Addendum ${bundle.extension.version}`;
  const versions = [...new Set((policies ?? []).map((policy) => policy.version).filter(Boolean))];
  return versions.length === 1 ? `Version ${versions[0]}` : "";
}
