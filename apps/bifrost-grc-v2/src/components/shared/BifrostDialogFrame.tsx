import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

interface BifrostDialogFrameProps {
  children: ReactNode;
  onDismiss: () => void;
  dismissDisabled?: boolean;
  labelledBy?: string;
  style?: CSSProperties;
}

/**
 * Compatibility frame for legacy dialog bodies. Native dialog owns focus
 * trapping, Escape, backdrop dismissal, and viewport containment while the
 * body is progressively moved to the narrower BfDialog API.
 */
export default function BifrostDialogFrame({
  children,
  onDismiss,
  dismissDisabled = false,
  labelledBy,
  style,
}: BifrostDialogFrameProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="bds-dialog"
      aria-labelledby={labelledBy}
      style={style}
      onCancel={(event) => {
        event.preventDefault();
        if (!dismissDisabled) onDismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !dismissDisabled) onDismiss();
      }}
    >
      <div className="bds-dialog__surface cv-dialog">{children}</div>
    </dialog>
  );
}
