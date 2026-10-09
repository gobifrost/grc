import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfDialog } from "@/components/bifrost/BfDialog";

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface DialogState extends ConfirmOptions {
  open: boolean;
  resolve?: (val: boolean) => void;
}

let externalShow: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (!externalShow) {
    // No host mounted yet — fall back to native confirm so callers never hang.
    return Promise.resolve(window.confirm(opts.title));
  }
  return externalShow(opts);
}

/**
 * Mount once near the app root. Exposes a promise-based `confirm()` helper.
 */
export default function ConfirmDialogHost() {
  const [state, setState] = useState<DialogState>({ open: false, title: "" });

  useEffect(() => {
    externalShow = (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, open: true, resolve });
      });
    return () => {
      externalShow = null;
    };
  }, []);

  const close = (val: boolean) => {
    state.resolve?.(val);
    setState((s) => ({ ...s, open: false, resolve: undefined }));
  };

  return (
    <BfDialog
      open={state.open}
      onOpenChange={(open) => !open && close(false)}
      title={state.title}
      footer={
        <>
          <BfButton variant="secondary" onClick={() => close(false)}>
            {state.cancelLabel ?? "Cancel"}
          </BfButton>
          <BfButton
            variant={state.destructive ? "danger" : "primary"}
            onClick={() => close(true)}
            autoFocus
          >
            {state.confirmLabel ?? "Confirm"}
          </BfButton>
        </>
      }
    >
      {state.body ? <div>{state.body}</div> : null}
    </BfDialog>
  );
}
