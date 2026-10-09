import React, { useState } from "react";
import { GripVertical, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { Control } from "../../lib/types";
import InlineEdit from "./InlineEdit";

interface ControlItemProps {
  control: Control;
  onPatch: (patch: Partial<Control>) => Promise<void>;
  onDelete: () => Promise<void>;
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStartItem: (id: string, e: React.DragEvent) => void;
  onDragEndItem: () => void;
  onDragOverItem: (id: string, e: React.DragEvent) => void;
  onDragLeaveItem: (id: string) => void;
  onDropItem: (id: string, e: React.DragEvent) => void;
  readOnly?: boolean;
}

export default function ControlItem({
  control,
  onPatch,
  onDelete,
  isDragging,
  isDropTarget,
  onDragStartItem,
  onDragEndItem,
  onDragOverItem,
  onDragLeaveItem,
  onDropItem,
  readOnly = false,
}: ControlItemProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [dragArmed, setDragArmed] = useState(false);

  return (
    <div
      draggable={!readOnly && dragArmed}
      onDragStart={(e) => onDragStartItem(control.id, e)}
      onDragEnd={() => {
        setDragArmed(false);
        onDragEndItem();
      }}
      onDragOver={(e) => onDragOverItem(control.id, e)}
      onDragLeave={() => onDragLeaveItem(control.id)}
      onDrop={(e) => onDropItem(control.id, e)}
      className="cv-card cv-card--recessed cv-card--pad-sm"
      style={{
        opacity: isDragging ? 0.4 : control.is_active === false ? 0.55 : 1,
        outline: isDropTarget ? "2px solid var(--cv-cb)" : undefined,
        transition: "outline var(--bf-motion-feedback) var(--bf-ease-standard), opacity var(--bf-motion-feedback) var(--bf-ease-standard)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          role="button"
          tabIndex={0}
          aria-label="Drag control"
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
          <GripVertical size={14} />
        </span>

        <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          style={{ padding: 4 }}
          onClick={() => setShowDetails((s) => !s)}
          aria-label={showDetails ? "Hide details" : "Show details"}
        >
          {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span
              className="cv-chip cv-chip--mono cv-chip--neutral"
              style={{ padding: 0, background: "transparent" }}
            >
              <InlineEdit
                value={control.control_id ?? ""}
                placeholder="ID"
                mono
                onCommit={(v) => onPatch({ control_id: v.trim() })}
                readOnly={readOnly}
              />
            </span>
            <div style={{ flex: 1, minWidth: 160, fontWeight: 500, color: "var(--cv-fg-1)" }}>
              <InlineEdit
                value={control.title ?? ""}
                placeholder="Control title"
                onCommit={(v) => onPatch({ title: v.trim() })}
                readOnly={readOnly}
              />
            </div>
          </div>

          {showDetails ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              <div>
                <div className="cv-field-label">Description</div>
                <InlineEdit
                  value={control.description ?? ""}
                  placeholder="What this control covers"
                  multiline
                  onCommit={(v) => onPatch({ description: v.trim() || null })}
                  readOnly={readOnly}
                />
              </div>
              <div>
                <div className="cv-field-label">Guidance</div>
                <InlineEdit
                  value={control.guidance ?? ""}
                  placeholder="Implementation guidance"
                  multiline
                  onCommit={(v) => onPatch({ guidance: v.trim() || null })}
                  readOnly={readOnly}
                />
              </div>
            </div>
          ) : null}
        </div>

        {!readOnly ? <ActiveToggle
          active={control.is_active !== false}
          onChange={(v) => onPatch({ is_active: v })}
        /> : null}

        {!readOnly ? <button
          type="button"
          className="cv-btn cv-btn--ghost cv-btn--sm"
          style={{ padding: 4, color: "var(--cv-red)" }}
          onClick={onDelete}
          aria-label="Delete control"
        >
          <Trash2 size={14} />
        </button> : null}
      </div>
    </div>
  );
}

function ActiveToggle({ active, onChange }: { active: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={active ? "Active — click to deactivate" : "Inactive — click to activate"}
      title={active ? "Active — click to deactivate" : "Inactive — click to activate"}
      onClick={() => onChange(!active)}
      style={{
        flexShrink: 0,
        width: 42,
        height: 24,
        borderRadius: 12,
        background: active ? "var(--bf-primary)" : "var(--bf-line)",
        border: `1px solid ${active ? "var(--cv-cb)" : "var(--cv-border)"}`,
        position: "relative",
        cursor: "pointer",
        padding: 0,
        transition: "background var(--bf-motion-disclosure) var(--bf-ease-standard), border-color var(--bf-motion-disclosure) var(--bf-ease-standard)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: active ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bf-paper)",
          border: "1px solid var(--bf-line-strong)",
          transition: "left var(--bf-motion-disclosure) var(--bf-ease-standard)",
        }}
      />
    </button>
  );
}
