import { useGovernedTables } from "../../lib/governed-tables";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { Policy, PolicyStatus } from "../../lib/types";
import { TABLE_POLICIES } from "../../lib/grc-tables";
import { useUserNameLookup } from "../../lib/directory";
import UserPicker from "../shared/UserPicker";
import StateSegmented, { type StateOption } from "../shared/StateSegmented";

interface PolicySideRailProps {
  policy: Policy;
  onUpdated: () => void;
  disabled?: boolean;
}

const STATUS_OPTIONS: Array<StateOption<PolicyStatus>> = [
  { value: "draft", label: "Draft", tone: "neutral" },
  { value: "active", label: "Active", tone: "green" },
  { value: "archived", label: "Archived", tone: "purple" },
];

function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  // Trim ISO to YYYY-MM-DD for <input type="date">.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

export default function PolicySideRail({ policy, onUpdated, disabled = false }: PolicySideRailProps) {
  const tables = useGovernedTables();
  const [status, setStatus] = useState<PolicyStatus>(
    (policy.status as PolicyStatus) ?? "draft",
  );
  const [version, setVersion] = useState(policy.version ?? "");
  const [reviewDate, setReviewDate] = useState(fmtDate(policy.review_date));
  const [saving, setSaving] = useState<string | null>(null);
  const userName = useUserNameLookup();

  // Keep local state in sync if the parent refetches.
  useEffect(() => {
    setStatus((policy.status as PolicyStatus) ?? "draft");
    setVersion(policy.version ?? "");
    setReviewDate(fmtDate(policy.review_date));
  }, [
    policy.id,
    policy.status,
    policy.version,
    policy.approved_at,
    policy.review_date,
  ]);

  async function patch(field: string, data: Record<string, unknown>) {
    if (disabled) return;
    setSaving(field);
    try {
      await tables.update(TABLE_POLICIES, policy.id, data);
      onUpdated();
    } catch (err) {
      toast.error(`Failed to save ${field}`);
      console.error(err);
    } finally {
      setSaving(null);
    }
  }

  async function changeStatus(next: PolicyStatus) {
    setStatus(next);
    const data: Record<string, unknown> = { status: next };
    await patch("status", data);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Field label="Status" saving={saving === "status"}>
        <StateSegmented
          value={status}
          onChange={changeStatus}
          options={STATUS_OPTIONS}
          ariaLabel="Policy status"
          compact
          disabled={disabled}
        />
      </Field>

      <Field label="Version" htmlFor="policy-version" saving={saving === "version"}>
        <Input
          id="policy-version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          onBlur={() => {
            if ((policy.version ?? "") !== version) {
              patch("version", { version });
            }
          }}
          placeholder="e.g. 1.0"
          disabled={disabled}
        />
      </Field>

      <ReadonlyField label="Document type" value={(policy.policy_type ?? "policy").replace(/_/g, " ")} />
      <ReadonlyField label="Relationship" value={policy.policy_role ?? "standalone"} />
      {policy.policy_role === "extension" ? (
        <ReadonlyField
          label="Reviewed master version"
          value={policy.reviewed_base_version ? `v${policy.reviewed_base_version}` : "Needs review"}
        />
      ) : null}

      <div style={{ position: "relative" }}>
        <UserPicker
          id="policy-owner"
          label="Owner"
          value={policy.owner ?? null}
          onChange={(owner) => patch("owner", { owner })}
          disabled={disabled}
        />
        {saving === "owner" ? (
          <Loader2 size={12} className="animate-spin" style={{ position: "absolute", right: 8, top: 2 }} />
        ) : null}
      </div>

      <ReadonlyField label="Approved by" value={userName(policy.approved_by)} />
      <ReadonlyField label="Approval date" value={fmtDateTime(policy.approved_at)} />

      <Field label="Review date" htmlFor="policy-review-date" saving={saving === "review_date"}>
        <input
          id="policy-review-date"
          type="date"
          value={reviewDate}
          onChange={(e) => setReviewDate(e.target.value)}
          onBlur={(e) => {
            const v = e.target.value;
            const prev = fmtDate(policy.review_date);
            if (v !== prev) {
              patch("review_date", {
                review_date: v ? new Date(v + "T00:00:00.000Z").toISOString() : null,
              });
            }
          }}
          className="cv-field"
          disabled={disabled}
        />
      </Field>

      <div role="separator" style={{ borderTop: "1px solid var(--cv-border)", margin: "4px 0" }} />

      <ReadonlyField label="Created" value={fmtDateTime(policy.created_at)} />
      <ReadonlyField label="Created by" value={userName(policy.created_by)} />
      <ReadonlyField label="Last updated" value={fmtDateTime(policy.updated_at)} />
      <ReadonlyField label="Updated by" value={userName(policy.updated_by)} />
    </div>
  );
}

function Field({
  label,
  htmlFor,
  saving,
  children,
}: {
  label: string;
  htmlFor?: string;
  saving: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <label
          htmlFor={htmlFor}
          style={{
            fontSize: 11,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--cv-fg-3)",
          }}
        >
          {label}
        </label>
        {saving ? <Loader2 size={12} className="animate-spin" /> : null}
      </div>
      {children}
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--cv-fg-3)",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13, color: "var(--cv-fg-2)" }}>{value}</span>
    </div>
  );
}
