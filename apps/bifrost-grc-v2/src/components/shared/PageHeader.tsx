import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  crumb?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, subtitle, crumb, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-col items-start justify-between gap-4 border-b border-[var(--bf-line)] pb-5 sm:flex-row sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        {crumb ? <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--bf-muted)]">{crumb}</div> : null}
        <h1 className="m-0 font-[var(--bf-font-display)] text-[26px] font-semibold leading-tight tracking-[-0.025em] text-[var(--bf-ink)]">{title}</h1>
        {subtitle ? <div className="max-w-3xl text-[13px] text-[var(--bf-muted)]">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">{actions}</div> : null}
    </header>
  );
}
