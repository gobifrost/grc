import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";
interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  body?: string;
  cta?: ReactNode;
}

export default function EmptyState({ icon: Icon = Inbox, title, body, cta }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--bf-radius-surface)] border border-dashed border-[var(--bf-line)] bg-[var(--bf-paper)] px-8 py-10 text-center">
      <div className="inline-flex size-10 items-center justify-center rounded-[var(--bf-radius-control)] bg-[var(--bf-cool)] text-[var(--bf-muted)]">
        <Icon size={22} />
      </div>
      <div className="font-[var(--bf-font-display)] text-base font-semibold text-[var(--bf-ink)]">{title}</div>
      {body ? <div className="max-w-md text-sm text-[var(--bf-muted)]">{body}</div> : null}
      {cta ? <div className="mt-1.5">{cta}</div> : null}
    </div>
  );
}
