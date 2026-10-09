import assert from "node:assert/strict";
import test from "node:test";

import { campaignSummary, filterPolicyAssignments, isRecentReminder, nextPolicyMinorVersion, noticePresentation, notificationRequestPresentation } from "./policy-signoff.ts";

test("editing a base policy advances its minor version", () => {
  assert.equal(nextPolicyMinorVersion("2.0"), "2.1");
  assert.equal(nextPolicyMinorVersion("2.9"), "2.10");
  assert.throws(() => nextPolicyMinorVersion("draft"), /major.minor/);
});

test("campaignSummary keeps waived people out of the signing denominator", () => {
  assert.deepEqual(
    campaignSummary([
      { status: "signed" },
      { status: "not_signed" },
      { status: "waived" },
      { status: "overdue" },
    ]),
    { required: 3, signed: 1, waived: 1, outstanding: 2 },
  );
});

test("isRecentReminder applies the 24 hour reminder window", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  assert.equal(isRecentReminder("2026-09-29T12:01:00Z", now), true);
  assert.equal(isRecentReminder("2026-09-29T12:00:00Z", now), false);
  assert.equal(isRecentReminder(undefined, now), false);
});

test("All retains every assignee and Not signed includes overdue people", () => {
  const assignments = [
    { status: "signed" as const },
    { status: "not_signed" as const },
    { status: "overdue" as const },
    { status: "waived" as const },
  ];
  assert.equal(filterPolicyAssignments(assignments, "all").length, 4);
  assert.deepEqual(filterPolicyAssignments(assignments, "not_signed").map((row) => row.status), ["not_signed", "overdue"]);
  assert.deepEqual(campaignSummary(assignments), { required: 3, signed: 1, waived: 1, outstanding: 2 });
});

test("noticePresentation gives the tracker accurate status copy without implying delivery", () => {
  assert.deepEqual(noticePresentation({ status: "requested", requested_at: "2026-10-01T09:00:00Z" }), { label: "Requested", tooltip: "Requested" });
  assert.deepEqual(noticePresentation({ status: "sent", requested_at: "2026-10-01T09:00:00Z" }), { label: "Sent", tooltip: "Sent" });
  assert.deepEqual(noticePresentation({ status: "failed", error: "Provider unavailable" }), { label: "Failed", tooltip: "Failed: Provider unavailable" });
  assert.deepEqual(noticePresentation({ status: "no_listener" }), { label: "No Listener", tooltip: "No Listener" });
});

test("notificationRequestPresentation marks an all-failed request as needing attention", () => {
  assert.deepEqual(notificationRequestPresentation(2, 0), { title: "Email Requests Published", message: "GRC published email requests for 2 people." });
  assert.deepEqual(notificationRequestPresentation(0, 1), { title: "Email Requests Need Attention", message: "No email requests were published. 1 request needs attention." });
});
