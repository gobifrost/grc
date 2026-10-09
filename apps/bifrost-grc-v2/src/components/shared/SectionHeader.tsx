import type { ReactNode } from "react";

interface SectionHeaderProps {
  label: string;
  action?: ReactNode;
}

export default function SectionHeader({ label, action }: SectionHeaderProps) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--bf-line)] pb-2">
      <span className="font-[var(--bf-font-display)] text-xs font-semibold uppercase tracking-[0.08em] text-[var(--bf-muted)]">{label}</span>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
