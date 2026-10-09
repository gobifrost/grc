import assert from "node:assert/strict";
import test from "node:test";

import { basePolicyOrganizationRows } from "./base-policy-organizations.ts";

test("basePolicyOrganizationRows preserves each organization’s addendum and sign-off summary", () => {
  assert.deepEqual(
    basePolicyOrganizationRows([
      {
        organization_id: "org-b",
        organization_name: "Beacon LLC",
        addendum_policy_id: "addendum-b",
        addendum_version: "1.2",
        accepted: 7,
        required: 9,
        last_sent: "2026-09-18T12:00:00Z",
      },
      {
        organization_id: "org-a",
        organization_name: "Arcadia Inc.",
        addendum_policy_id: "addendum-a",
        addendum_version: "1.0",
        accepted: 3,
        required: 3,
        last_sent: null,
      },
    ]),
    [
      { organizationId: "org-a", organizationName: "Arcadia Inc.", addendumPolicyId: "addendum-a", addendumVersion: "1.0", signoff: "3 of 3", lastSent: null },
      { organizationId: "org-b", organizationName: "Beacon LLC", addendumPolicyId: "addendum-b", addendumVersion: "1.2", signoff: "7 of 9", lastSent: "2026-09-18T12:00:00Z" },
    ],
  );
});

test("basePolicyOrganizationRows keeps an empty sign-off summary readable", () => {
  assert.deepEqual(
    basePolicyOrganizationRows([{ organization_id: "org-a", organization_name: "Arcadia Inc.", addendum_version: "1.0" }]),
    [{ organizationId: "org-a", organizationName: "Arcadia Inc.", addendumPolicyId: null, addendumVersion: "1.0", signoff: "Not sent", lastSent: null }],
  );
});
