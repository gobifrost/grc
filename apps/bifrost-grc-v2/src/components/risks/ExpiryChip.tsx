

// Smart expiry chip — red if expired, amber if within 30 days, neutral otherwise.

interface ExpiryChipProps {
  expiresAt?: string | null;
}

function daysDiff(target: Date, now: Date): number {
  const ms = target.getTime() - now.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function ExpiryChip({ expiresAt }: ExpiryChipProps) {
  if (!expiresAt) {
    return <span className="cv-chip cv-chip--neutral">No expiry</span>;
  }
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return <span className="cv-chip cv-chip--neutral">{expiresAt}</span>;
  }
  const now = new Date();
  const days = daysDiff(parsed, now);
  if (days < 0) {
    return <span className="cv-chip cv-chip--red">Expired {Math.abs(days)}d ago</span>;
  }
  if (days <= 30) {
    return <span className="cv-chip cv-chip--gold">Expires in {days}d</span>;
  }
  return <span className="cv-chip cv-chip--neutral">Expires {fmtDate(expiresAt)}</span>;
}

export function isExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

export function isExpiringSoon(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return false;
  const days = daysDiff(d, new Date());
  return days >= 0 && days <= 30;
}
