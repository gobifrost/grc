import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { addendumBundle, assignmentForId, assignmentVersionLabel, policySummary, splitAssignments } from "../src/lib/policy-viewer.js";

const assignments = [
  { assignment_id: "open-1", status: "assigned", policies: [{ id: "policy-1", name: "AI Acceptable Use", version: "1.0" }] },
  { assignment_id: "signed-1", status: "accepted", accepted_at: "2026-09-01T09:30:00Z", policies: [{ id: "policy-2", name: "Security Awareness", version: "2.0" }] },
];

test("separates outstanding and signed assignments for the policies list", () => {
  const groups = splitAssignments(assignments);

  assert.deepEqual(groups.toSign.map((assignment) => assignment.assignment_id), ["open-1"]);
  assert.deepEqual(groups.signed.map((assignment) => assignment.assignment_id), ["signed-1"]);
});

test("finds the assignment selected by the sign route without exposing another assignment", () => {
  assert.equal(assignmentForId(assignments, "signed-1")?.assignment_id, "signed-1");
  assert.equal(assignmentForId(assignments, "missing"), undefined);
});

test("summarizes every policy signed by a multi-policy campaign", () => {
  assert.equal(policySummary([
    { name: "AI Acceptable Use", version: "1.0" },
    { name: "Information Security", version: "2.1" },
  ]), "AI Acceptable Use (version 1.0) and Information Security (version 2.1)");
});

test("combines a linked base and addendum for one signature", () => {
  const policies = [
    { id: "base", name: "AI Acceptable Use Policy", version: "2.0", policy_role: "base" },
    { id: "addendum", name: "AI Acceptable Use Policy Addendum", version: "1.0", policy_role: "extension", base_policy_id: "base", organization_name: "Example Organization" },
  ];
  assert.equal(addendumBundle(policies)?.base.id, "base");
  assert.equal(assignmentVersionLabel(policies), "Version 2.0 · Addendum 1.0");
  assert.equal(policySummary(policies), "AI Acceptable Use Policy (version 2.0) with the Example Organization addendum (version 1.0)");
  assert.equal(addendumBundle([{ ...policies[0] }, { ...policies[1], base_policy_id: "other" }]), null);
});

test("keeps the Viewer as its own mobile scroll container", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/index.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /className="app-scroll"/);
  assert.match(styles, /\.app-scroll\s*\{[^}]*overflow-y:\s*auto/s);
});

test("uses Title Case for the viewer's navigational and action labels", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  for (const label of [
    "Your Policies",
    "To Sign",
    "Review and Sign",
    "Sign Policy",
    "Back to Your Policies",
  ]) {
    assert.ok(app.includes(label), `expected ${label} to be a viewer label`);
  }
});
