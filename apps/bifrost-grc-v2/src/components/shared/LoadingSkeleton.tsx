interface LoadingSkeletonProps {
  rows?: number;
  variant?: "page" | "table" | "cards" | "editor";
  label?: string;
}

export default function LoadingSkeleton({
  rows = 4,
  variant = "table",
  label = "Loading content",
}: LoadingSkeletonProps) {
  return (
    <div className={`cv-loading-skeleton cv-loading-skeleton--${variant}`} role="status" aria-label={label}>
      {variant === "page" ? (
        <>
          <div className="cv-skeleton cv-skeleton--title" />
          <div className="cv-skeleton cv-skeleton--subtitle" />
          <div className="cv-loading-skeleton__stats">
            {Array.from({ length: 5 }, (_, index) => <div className="cv-skeleton cv-skeleton--stat" key={index} />)}
          </div>
        </>
      ) : null}
      {variant === "editor" ? <div className="cv-skeleton cv-skeleton--toolbar" /> : null}
      {variant === "table" ? <div className="cv-skeleton cv-skeleton--table-head" /> : null}
      <div className="cv-loading-skeleton__rows">
        {Array.from({ length: rows }, (_, index) => (
          <div className="cv-skeleton cv-skeleton--row" key={index} style={{ "--cv-skeleton-index": index } as CSSProperties} />
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}
import type { CSSProperties } from "react";
