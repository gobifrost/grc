import { useState } from "react";
import { useWorkflowMutation } from "bifrost";
import { usePdfBranding } from "../../lib/pdf-branding";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

export interface PdfExportResult { content_base64: string; filename: string; content_type: string }

export default function PdfExportButton({ workflow, params, label = "Export PDF", disabled = false, title }: { workflow: string; params: Record<string, unknown>; label?: string; disabled?: boolean; title?: string }) {
  const exportPdf = useWorkflowMutation<PdfExportResult>(workflow);
  const branding = usePdfBranding();
  const [preparing, setPreparing] = useState(false);
  const download = async () => {
    setPreparing(true);
    try {
      const result = await exportPdf.mutate({ ...params, branding: await branding.prepare() });
      if (!result?.content_base64 || result.content_type !== "application/pdf") throw new Error("The PDF could not be generated.");
      const bytes = Uint8Array.from(atob(result.content_base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename || "grc-export.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t export the PDF. Please try again."); }
    finally { setPreparing(false); }
  };
  return <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={download} disabled={disabled || branding.loading || preparing || exportPdf.loading} title={title}>{preparing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}{preparing ? "Preparing PDF…" : label}</button>;
}
