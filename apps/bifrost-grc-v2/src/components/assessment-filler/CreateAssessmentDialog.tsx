import { useEffect, useMemo, useState } from "react";
import ThemedSelect, { type ThemedSelectOption } from "../shared/ThemedSelect";
import OrgScopeField from "../shared/OrgScopeField";
import UserPicker from "../shared/UserPicker";
import { BfDialog } from "../bifrost/BfDialog";
import { BfButton } from "../bifrost/BfButton";
import type { Framework } from "../../lib/types";

interface CreateAssessmentDialogProps {
  open: boolean;
  onClose: () => void;
  frameworks: Framework[];
  onCreate: (input: {
    framework_id: string;
    name: string;
    applied_organizations: string[] | null;
    assigned_to?: string;
  }) => Promise<void>;
}

export default function CreateAssessmentDialog({
  open,
  onClose,
  frameworks,
  onCreate,
}: CreateAssessmentDialogProps) {
  const [name, setName] = useState("");
  const [frameworkId, setFrameworkId] = useState<string>("");
  const [organizationScope, setOrganizationScope] = useState<string[] | null>(null);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const first = frameworks[0];
      setFrameworkId(first ? first.id : "");
      setName("");
      setOrganizationScope(null);
      setAssignedTo(null);
      setErr(null);
      setBusy(false);
    }
  }, [open, frameworks]);

  const selectedFramework = useMemo(
    () => frameworks.find((f) => f.id === frameworkId) ?? null,
    [frameworks, frameworkId],
  );

  // Default the name to the framework; scope is represented independently.
  useEffect(() => {
    if (!open || !selectedFramework) return;
    if (name.trim().length > 0) return; // don't override user edits
    setName(selectedFramework.name);
    // We intentionally do not depend on `name` — only re-fill while name is empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFramework, open]);

  if (!open) return null;

  const handleSubmit = async () => {
    setErr(null);
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    if (!frameworkId) {
      setErr("Pick a framework");
      return;
    }
    if (organizationScope?.length === 0) {
      setErr("Choose at least one organization or select All.");
      return;
    }
    setBusy(true);
    try {
      await onCreate({
        framework_id: frameworkId,
        name: name.trim(),
        applied_organizations: organizationScope,
        assigned_to: assignedTo ?? undefined,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const frameworkOptions: ThemedSelectOption[] = frameworks.map((fw) => ({
    label: fw.name + (fw.version ? ` · ${fw.version}` : ""),
    value: fw.id,
  }));

  return (
    <BfDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
      title="New assessment"
      description="Define the provider default once, then apply it to one, some, or all customers. Customer-specific differences remain sparse overrides."
      footer={
        <>
          <BfButton variant="secondary" disabled={busy} onClick={onClose}>Cancel</BfButton>
          <BfButton disabled={busy || frameworks.length === 0} aria-busy={busy} onClick={handleSubmit}>
            {busy ? "Creating…" : "Create assessment"}
          </BfButton>
        </>
      }
    >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cv-field-group">
            <label className="cv-field-label">Framework</label>
            {frameworks.length === 0 ? (
              <div className="cv-small" style={{ color: "var(--cv-fg-3)" }}>
                No active frameworks — create one first.
              </div>
            ) : (
              <ThemedSelect
                value={frameworkId}
                onChange={setFrameworkId}
                options={frameworkOptions}
                placeholder="Pick a framework…"
                searchable
                ariaLabel="Framework"
              />
            )}
          </div>

          <div className="cv-field-group">
            <OrgScopeField
              id="new-assessment-scope"
              label="Applies to"
              value={organizationScope}
              onChange={setOrganizationScope}
              disabled={busy}
            />
          </div>

          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-assessment-name">Name</label>
            <input
              id="new-assessment-name"
              type="text"
              className="cv-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 2026 Q2 NIST CSF Self-Assessment"
            />
          </div>

          <UserPicker
            label="Assigned to (optional)"
            value={assignedTo}
            onChange={(uid) => setAssignedTo(uid)}
            allowClear
          />

          {err ? (
            <div className="cv-callout cv-callout--danger">
              <div className="cv-callout__body">{err}</div>
            </div>
          ) : null}
        </div>
    </BfDialog>
  );
}
