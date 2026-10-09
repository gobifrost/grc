export function splitAssignments(assignments: unknown[]): {
  toSign: unknown[];
  signed: unknown[];
};

export function assignmentForId(assignments: unknown[], assignmentId?: string): unknown;

export function policySummary(policies: Array<{ name?: string; version?: string | null }>): string;

export interface ViewerPolicy { id: string; name: string; version?: string | null; content: string; policy_role?: string | null; base_policy_id?: string | null; organization_name?: string | null }
export function addendumBundle(policies: ViewerPolicy[]): { base: ViewerPolicy; extension: ViewerPolicy; organizationName: string } | null;
export function assignmentVersionLabel(policies: ViewerPolicy[]): string;
