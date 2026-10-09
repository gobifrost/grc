import { useGovernedTables } from "../../lib/governed-tables";
import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTable } from "bifrost";

import { AlertOctagon, Plus, Search, Loader2, X } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import { useCurrentUser, useGrcPermissions } from "../../lib/current-user";
import EmptyState from "../../components/shared/EmptyState";
import LoadingSkeleton from "../../components/shared/LoadingSkeleton";
import BifrostDialogFrame from "../../components/shared/BifrostDialogFrame";
import StatusBadge from "../../components/shared/StatusBadge";
import ScopeBadge from "../../components/shared/ScopeBadge";
import ExpiryChip, { isExpired, isExpiringSoon } from "../../components/risks/ExpiryChip";
import OrgScopeField from "../../components/shared/OrgScopeField";
import ThemedSelect from "../../components/shared/ThemedSelect";
import StateSegmented, { type StateOption } from "../../components/shared/StateSegmented";
import {
  TABLE_EXCEPTIONS,
  TABLE_CONTROLS,
  TABLE_FRAMEWORKS } from "../../lib/grc-tables";
import { useUserNameLookup } from "../../lib/directory";
import { appliesToOrg, rowOrganizationIdForScope, scopeOrgIds } from "../../lib/scope";
import { useOrganizationView } from "../../lib/organization-view";
import type {
  Exception as ExceptionRow,
  Control,
  Framework,
  ExceptionStatus } from "../../lib/types";

const STATUS_FILTERS: Array<{ value: "all" | ExceptionStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "expired", label: "Expired" },
];
const EXCEPTION_STATE_OPTIONS: Array<StateOption<ExceptionStatus>> = [
  { value: "pending", label: "Pending", tone: "gold" },
  { value: "approved", label: "Approved", tone: "green" },
  { value: "denied", label: "Denied", tone: "red" },
  { value: "expired", label: "Expired", tone: "purple" },
];

type ExpiryFilter = "all" | "active" | "soon" | "expired";

const EXPIRY_FILTERS: Array<{ value: ExpiryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "soon", label: "Expiring soon" },
  { value: "expired", label: "Expired" },
];

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric" });
  } catch {
    return iso;
  }
}

export default function ExceptionsPage() {
  const { canEdit } = useGrcPermissions();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ExceptionStatus>("all");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const { organizationId } = useOrganizationView();

  const userName = useUserNameLookup();

  const { rows: excRows, loading, error } = useTable<ExceptionRow>(TABLE_EXCEPTIONS, {
    pageSize: 500,
    order_by: "updated_at",
    order_dir: "desc" });
  const { rows: controlRows } = useTable<Control>(TABLE_CONTROLS, { pageSize: 1000 });
  const { rows: frameworkRows } = useTable<Framework>(TABLE_FRAMEWORKS, { pageSize: 200 });

  const exceptions: ExceptionRow[] = Array.isArray(excRows) ? excRows : [];
  const controls: Control[] = Array.isArray(controlRows) ? controlRows : [];
  const frameworks: Framework[] = Array.isArray(frameworkRows) ? frameworkRows : [];

  const controlById = useMemo(() => {
    const m = new Map<string, Control>();
    controls.forEach((c) => m.set(c.id, c));
    return m;
  }, [controls]);

  const fwName = (fid?: string | null) =>
    frameworks.find((f) => f.id === fid)?.name ?? "Framework";

  const filtered = useMemo(() => {
    let list = exceptions;
    if (statusFilter !== "all") list = list.filter((e) => e.status === statusFilter);
    if (expiryFilter === "expired") list = list.filter((e) => isExpired(e.expires_at));
    if (expiryFilter === "soon") list = list.filter((e) => isExpiringSoon(e.expires_at));
    if (expiryFilter === "active")
      list = list.filter((e) => !isExpired(e.expires_at));
    if (organizationId) list = list.filter((e) => appliesToOrg(e, organizationId));
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((e) => {
        const c = e.control_id ? controlById.get(e.control_id) : null;
        return (
          e.reason?.toLowerCase().includes(q) ||
          e.name?.toLowerCase().includes(q) ||
          e.approved_by?.toLowerCase().includes(q) ||
          c?.title?.toLowerCase().includes(q) ||
          c?.control_id?.toLowerCase().includes(q)
        );
      });
    }
    return list;
  }, [exceptions, statusFilter, expiryFilter, organizationId, search, controlById]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, minHeight: 0, flex: 1 }}>
      <PageHeader
        title="Exceptions"
        subtitle="Documented waivers from control requirements — with justification, compensating measures, and expiry."
        actions={canEdit ? (
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New exception
          </button>
        ) : undefined}
      />

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 380 }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--cv-fg-3)",
              pointerEvents: "none" }}
          />
          <input
            aria-label="Search exceptions"
            className="cv-field"
            style={{ paddingLeft: 30 }}
            placeholder="Search by justification, control, approver…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              className={"cv-chip " + (statusFilter === f.value ? "cv-chip--teal" : "cv-chip--neutral")}
              onClick={() => setStatusFilter(f.value)}
              style={{ cursor: "pointer", border: "none" }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {EXPIRY_FILTERS.map((f) => (
            <button
              key={f.value}
              className={"cv-chip " + (expiryFilter === f.value ? "cv-chip--gold" : "cv-chip--neutral")}
              onClick={() => setExpiryFilter(f.value)}
              style={{ cursor: "pointer", border: "none" }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton rows={6} label="Loading exceptions" />
      ) : error ? (
        <EmptyState icon={AlertOctagon} title="Couldn't load exceptions" body={String(error)} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={AlertOctagon}
          title={exceptions.length === 0 ? "No exceptions logged" : "No matching exceptions"}
          body={
            exceptions.length === 0
              ? "Track waivers from control requirements here — with justification, expiry, and compensating controls."
              : "Try widening the filters."
          }
          cta={
            canEdit && exceptions.length === 0 ? (
              <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={() => setCreateOpen(true)}>
                <Plus size={14} /> New exception
              </button>
            ) : null
          }
        />
      ) : (
        <div
          className="cv-card"
          style={{ padding: 0, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
        >
          <div style={{ overflow: "auto", flex: 1 }}>
            <table className="cv-data-table">
              <thead>
                <tr style={{ position: "sticky", top: 0, zIndex: 1 }}>
                  <Th>Scope</Th>
                  <Th>Exception</Th>
                  <Th>Applies to</Th>
                  <Th>State</Th>
                  <Th>Expiry</Th>
                  <Th>Approver</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const c = e.control_id ? controlById.get(e.control_id) : null;
                  return (
                    <tr key={e.id} style={{ borderTop: "1px solid var(--cv-border)" }}>
                      <Td>
                        <ScopeBadge row={e} />
                      </Td>
                      <Td>
                        <Link
                          to={`/exceptions/${e.id}`}
                          style={{
                            color: "var(--cv-fg-1)",
                            textDecoration: "none",
                            display: "block",
                            maxWidth: 360 }}
                        >
                          <div
                            style={{
                              fontWeight: 500,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis" }}
                          >
                            {e.name || (c ? `Exception for ${c.control_id}` : "Untitled exception")}
                          </div>
                          <div className="cv-data-table__secondary">
                            {e.reason || `Created ${fmtDate(e.created_at)}`}
                          </div>
                        </Link>
                      </Td>
                      <Td>
                        {c ? (
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                              <code
                                style={{
                                  fontFamily: "var(--cv-font-mono)",
                                  fontSize: 11,
                                  color: "var(--cv-fg-2)" }}
                              >
                                {c.control_id}
                              </code>
                              <span style={{ color: "var(--cv-fg-1)", fontSize: 12 }}>{c.title}</span>
                            </div>
                            <div style={{ fontSize: 10, color: "var(--cv-fg-3)" }}>
                              {fwName(c.framework_id)}
                            </div>
                          </div>
                        ) : (
                          <span style={{ color: "var(--cv-fg-3)" }}>
                            Managed in the record
                          </span>
                        )}
                      </Td>
                      <Td>
                        <StatusBadge kind="exception" value={e.status} />
                      </Td>
                      <Td>
                        <ExpiryChip expiresAt={e.expires_at} />
                      </Td>
                      <Td>{e.approved_by ? userName(e.approved_by) : <span style={{ color: "var(--cv-fg-3)" }}>—</span>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canEdit ? <ExceptionCreateDialog open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}

interface ExceptionCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ExceptionCreateDialog({ open, onOpenChange }: ExceptionCreateDialogProps) {
  const tables = useGovernedTables();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const userOrgId = user?.organizationId && user.organizationId.length > 0 ? user.organizationId : null;
  const [reason, setReason] = useState("");
  const [name, setName] = useState("");
  const [compensating, setCompensating] = useState("");
  const [controlId, setControlId] = useState("");
  const [controlSearch, setControlSearch] = useState("");
  const [showControlPicker, setShowControlPicker] = useState(false);
  const [status, setStatus] = useState<ExceptionStatus>("pending");
  const [expiresAt, setExpiresAt] = useState("");
  const [organizationScope, setOrganizationScope] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const { rows: controls } = useTable<Control>(TABLE_CONTROLS, {
    pageSize: 1000,
    order_by: "control_id",
    order_dir: "asc" });
  const { rows: frameworks } = useTable<Framework>(TABLE_FRAMEWORKS, { pageSize: 200 });

  const controlList: Control[] = Array.isArray(controls) ? controls : [];
  const frameworkList: Framework[] = Array.isArray(frameworks) ? frameworks : [];
  const fwName = (id?: string | null) => frameworkList.find((f) => f.id === id)?.name ?? "Framework";

  const selectedControl = useMemo(
    () => controlList.find((c) => c.id === controlId) ?? null,
    [controlList, controlId],
  );

  const matches = useMemo(() => {
    const q = controlSearch.trim().toLowerCase();
    if (!q) return controlList.slice(0, 100);
    return controlList
      .filter(
        (c) =>
          c.title?.toLowerCase().includes(q) ||
          c.control_id?.toLowerCase().includes(q),
      )
      .slice(0, 100);
  }, [controlList, controlSearch]);

  if (!open) return null;

  const reset = () => {
    setReason("");
    setName("");
    setCompensating("");
    setControlId("");
    setControlSearch("");
    setShowControlPicker(false);
    setStatus("pending");
    setExpiresAt("");
    setOrganizationScope(null);
    setBusy(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onOpenChange(false);
  };

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Summary is required");
      return;
    }
    if (organizationScope?.length === 0) {
      toast.error("Choose at least one organization or select All");
      return;
    }
    if (!reason.trim()) {
      toast.error("Justification is required");
      return;
    }
    setBusy(true);
    try {
      const row = await tables.insert(TABLE_EXCEPTIONS, {
        organization_id: rowOrganizationIdForScope(organizationScope, userOrgId),
        applied_organizations: organizationScope,
        excluded_organizations: [],
        control_id: controlId || null,
        name: name.trim(),
        reason: reason.trim(),
        compensating_controls: compensating.trim() || null,
        status,
        expires_at: expiresAt || null });
      onOpenChange(false);
      reset();
      const id = (row as { id?: string })?.id;
      if (id) navigate(`/exceptions/${id}`);
    } catch (err) {
      toast.error("Failed to create exception: " + ((err as Error)?.message ?? "unknown"));
      setBusy(false);
    }
  };

  return (
    <BifrostDialogFrame
      onDismiss={close}
      dismissDisabled={busy}
      labelledBy="new-exception-title"
      style={{ width: "min(600px, calc(100vw - 32px))" }}
    >
        <div className="cv-dialog__header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 id="new-exception-title" className="cv-dialog__title">New exception</h2>
            <p id="new-exception-description" className="cv-small" style={{ margin: "4px 0 0" }}>
              Record a time-bound customer waiver, its justification, and compensating controls.
            </p>
          </div>
          <button className="cv-btn cv-btn--ghost cv-btn--sm" onClick={close} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="cv-dialog__body" style={{ display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          <OrgScopeField
            id="new-exception-organization-scope"
            value={organizationScope}
            onChange={setOrganizationScope}
            disabled={busy}
          />
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-exception-name">Summary</label>
            <input
              id="new-exception-name"
              className="cv-field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Temporary MFA exception for legacy VPN"
            />
            <div className="cv-field-help">A short title used in lists and approvals.</div>
          </div>
          <div className="cv-field-group">
            <div className="cv-field-label">Initial reference control</div>
            <div style={{ fontSize: 11, color: "var(--cv-fg-3)", marginBottom: 6 }}>
              Optional. You can attach additional records from the exception after creation.
            </div>
            {selectedControl && !showControlPicker ? (
              <div
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--cv-border)",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8 }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <code style={{ fontFamily: "var(--cv-font-mono)", fontSize: 12, color: "var(--cv-fg-2)" }}>
                      {selectedControl.control_id}
                    </code>
                    <span style={{ fontWeight: 500, color: "var(--cv-fg-1)" }}>{selectedControl.title}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--cv-fg-3)", marginTop: 2 }}>
                    {fwName(selectedControl.framework_id)}
                  </div>
                </div>
                <button
                  className="cv-btn cv-btn--ghost cv-btn--sm"
                  onClick={() => setShowControlPicker(true)}
                >
                  Change
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ position: "relative" }}>
                  <Search
                    size={14}
                    style={{
                      position: "absolute",
                      left: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--cv-fg-3)",
                      pointerEvents: "none" }}
                  />
                  <input
                    aria-label="Search reference controls"
                    className="cv-field"
                    style={{ paddingLeft: 30 }}
                    placeholder="Search controls…"
                    value={controlSearch}
                    onChange={(e) => setControlSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                <div
                  style={{
                    maxHeight: 220,
                    overflowY: "auto",
                    border: "1px solid var(--cv-border)",
                    borderRadius: 8 }}
                >
                  {matches.length === 0 ? (
                    <div style={{ padding: 14, fontSize: 12, color: "var(--cv-fg-3)" }}>No controls match.</div>
                  ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {matches.map((c) => (
                        <li
                          key={c.id}
                          style={{
                            borderBottom: "1px solid var(--cv-border)",
                            fontSize: 13 }}
                        >
                          <button
                            type="button"
                            className="cv-picker-option"
                            onClick={() => {
                              setControlId(c.id);
                              setShowControlPicker(false);
                              setControlSearch("");
                            }}
                          >
                            <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                              <code style={{ fontFamily: "var(--cv-font-mono)", fontSize: 11, color: "var(--cv-fg-2)" }}>
                                {c.control_id}
                              </code>
                              <span style={{ color: "var(--cv-fg-1)" }}>{c.title}</span>
                            </span>
                            <span style={{ fontSize: 10, color: "var(--cv-fg-3)" }}>{fwName(c.framework_id)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-exception-justification">Justification</label>
            <textarea
              id="new-exception-justification"
              className="cv-field"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="Why does this exception need to exist?"
            />
          </div>
          <div className="cv-field-group">
            <label className="cv-field-label" htmlFor="new-exception-compensating">Compensating controls</label>
            <textarea
              id="new-exception-compensating"
              className="cv-field"
              value={compensating}
              onChange={(e) => setCompensating(e.target.value)}
              rows={3}
              placeholder="Optional — describe what offsets the exception."
            />
          </div>
          <div className="cv-form-grid">
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-exception-status">Status</label>
              <StateSegmented
                value={status}
                onChange={setStatus}
                options={EXCEPTION_STATE_OPTIONS}
                ariaLabel="Exception status"
                compact
              />
            </div>
            <div className="cv-field-group">
              <label className="cv-field-label" htmlFor="new-exception-expiry">Expires</label>
              <input
                id="new-exception-expiry"
                className="cv-field"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          </div>
          <p className="cv-field-label">Approvals record the signed-in user automatically.</p>
        </div>
        <div className="cv-dialog__footer">
          <button className="cv-btn cv-btn--secondary cv-btn--sm" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="cv-btn cv-btn--primary cv-btn--sm" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create exception"}
          </button>
        </div>
    </BifrostDialogFrame>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "10px 14px",
        fontSize: 11,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: "var(--cv-fg-3)",
        fontWeight: 600,
        borderBottom: "1px solid var(--cv-border)" }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>{children}</td>;
}
