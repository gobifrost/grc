import React, { useState } from "react";
import { GripVertical, Trash2, ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { Domain, Control } from "../../lib/types";
import InlineEdit from "./InlineEdit";
import ControlItem from "./ControlItem";

interface DomainGroupProps {
  domain: Domain;
  controls: Control[];
  onPatchDomain: (patch: Partial<Domain>) => Promise<void>;
  onDeleteDomain: () => Promise<void>;
  onAddControl: () => Promise<void>;
  onPatchControl: (controlId: string, patch: Partial<Control>) => Promise<void>;
  onDeleteControl: (controlId: string) => Promise<void>;
  // drag plumbing — domain itself draggable; serves as drop target for controls/domains
  isDragging: boolean;
  isDropTarget: boolean;
  draggedControlId: string | null;
  dropTargetControlId: string | null;
  onDragStartDomain: (id: string, e: React.DragEvent) => void;
  onDragEndDomain: () => void;
  onDragOverDomain: (id: string, e: React.DragEvent) => void;
  onDragLeaveDomain: (id: string) => void;
  onDropDomain: (id: string, e: React.DragEvent) => void;
  onDragStartControl: (id: string, e: React.DragEvent) => void;
  onDragEndControl: () => void;
  onDragOverControl: (id: string, e: React.DragEvent) => void;
  onDragLeaveControl: (id: string) => void;
  onDropControl: (id: string, e: React.DragEvent) => void;
  readOnly?: boolean;
}

export default function DomainGroup({
  domain,
  controls,
  onPatchDomain,
  onDeleteDomain,
  onAddControl,
  onPatchControl,
  onDeleteControl,
  isDragging,
  isDropTarget,
  draggedControlId,
  dropTargetControlId,
  onDragStartDomain,
  onDragEndDomain,
  onDragOverDomain,
  onDragLeaveDomain,
  onDropDomain,
  onDragStartControl,
  onDragEndControl,
  onDragOverControl,
  onDragLeaveControl,
  onDropControl,
  readOnly = false,
}: DomainGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragArmed, setDragArmed] = useState(false);

  return (
    <div
      draggable={!readOnly && dragArmed}
      onDragStart={(e) => onDragStartDomain(domain.id, e)}
      onDragEnd={() => {
        setDragArmed(false);
        onDragEndDomain();
      }}
      onDragOver={(e) => onDragOverDomain(domain.id, e)}
      onDragLeave={() => onDragLeaveDomain(domain.id)}
      onDrop={(e) => onDropDomain(domain.id, e)}
      className="cv-card"
      style={{
        opacity: isDragging ? 0.4 : 1,
        outline: isDropTarget ? "2px solid var(--cv-cb)" : undefined,
        boxShadow: isDropTarget ? "0 0 0 2px var(--bf-primary)" : undefined,
        background: isDropTarget ? "var(--cv-bg-3)" : undefined,
        transition: "outline var(--bf-motion-feedback) var(--bf-ease-standard), box-shadow var(--bf-motion-feedback) var(--bf-ease-standard), opacity var(--bf-motion-feedback) var(--bf-ease-standard)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: 14,
          borderBottom: collapsed ? "none" : "1px solid var(--cv-border)",
        }}
      >
        <span
          role="button"
          tabIndex={0}
          aria-label="Drag domain"
          className="cv-drag-handle"
          onMouseDown={readOnly ? undefined : () => setDragArmed(true)}
          onMouseUp={() => setDragArmed(false)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 4,
            cursor: "grab",
            color: "var(--cv-fg-3)",
            userSelect: "none",
          }}
        >
          <GripVertical size={16} />
        </span>
        <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          style={{ padding: 4 }}
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand domain" : "Collapse domain"}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 160, fontSize: 16, fontWeight: 600, color: "var(--cv-fg-1)" }}>
              <InlineEdit
                value={domain.name ?? ""}
                placeholder="Domain name"
                onCommit={(v) => onPatchDomain({ name: v.trim() })}
                readOnly={readOnly}
              />
            </div>
            <span className="cv-chip cv-chip--neutral">{controls.length} controls</span>
          </div>
          <div style={{ color: "var(--cv-fg-2)", fontSize: 13 }}>
            <InlineEdit
              value={domain.description ?? ""}
              placeholder="Add description"
              multiline
              onCommit={(v) => onPatchDomain({ description: v.trim() || null })}
              readOnly={readOnly}
            />
          </div>
        </div>
        {!readOnly ? <button
          type="button"
          className="cv-btn cv-btn--secondary cv-btn--sm"
          onClick={onAddControl}
        >
          <Plus size={14} /> Control
        </button> : null}
        {!readOnly ? <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          style={{ padding: 6, color: "var(--cv-red)" }}
          onClick={onDeleteDomain}
          aria-label="Delete domain"
        >
          <Trash2 size={14} />
        </button> : null}
      </div>

      {collapsed ? null : (
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          {controls.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "18px 12px",
                border: "1px dashed var(--cv-border)",
                borderRadius: 8,
                color: "var(--cv-fg-3)",
                fontSize: 13,
              }}
            >
              No controls in this domain yet.
              <div style={{ marginTop: 8 }}>
                {!readOnly ? <button
                  type="button"
                  className="cv-btn cv-btn--secondary cv-btn--sm"
                  onClick={onAddControl}
                >
                  <Plus size={14} /> Add first control
                </button> : null}
              </div>
            </div>
          ) : (
            controls.map((c) => (
              <ControlItem
                key={c.id}
                control={c}
                onPatch={(p) => onPatchControl(c.id, p)}
                onDelete={() => onDeleteControl(c.id)}
                isDragging={draggedControlId === c.id}
                isDropTarget={dropTargetControlId === c.id}
                onDragStartItem={onDragStartControl}
                onDragEndItem={onDragEndControl}
                onDragOverItem={onDragOverControl}
                onDragLeaveItem={onDragLeaveControl}
                onDropItem={onDropControl}
                readOnly={readOnly}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
