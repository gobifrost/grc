import { useBifrostContext, useBranding } from "bifrost";

/** Branding is presentation only; callers still authorize every exported record. */
export interface PdfBranding {
  name: string;
  primary_color: string;
  logo_base64?: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);

async function pngBase64(blob: Blob): Promise<string> {
  if (blob.size > 2_000_000 || !IMAGE_TYPES.has(blob.type.split(";")[0])) throw new Error("Unsupported logo");
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { image.src = ""; reject(new Error("Logo load timed out")); }, 5000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("Logo could not be read")); };
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error("Unsupported logo dimensions");
    const scale = Math.min(512 / image.naturalWidth, 128 / image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("Logo could not be prepared");
    drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  } finally { URL.revokeObjectURL(url); }
}

type RuntimeBranding = Pick<ReturnType<typeof useBranding>, "primaryColor" | "rectangleLogoUrl" | "squareLogoUrl" | "palette">;

/** Convert the hook's runtime branding into a bounded, byte-backed PDF logo. */
export async function loadPdfBranding(authedFetch: typeof fetch, source: RuntimeBranding, baseUrl: string): Promise<PdfBranding> {
  const branding: PdfBranding = {
    name: "",
    primary_color: source.primaryColor || source.palette.light.primary,
  };
  for (const logoUrl of [source.rectangleLogoUrl, source.squareLogoUrl]) {
    if (!logoUrl) continue;
    try {
      const url = new URL(logoUrl, window.location.origin);
      const api = new URL(baseUrl || "/", window.location.origin);
      // Do not forward the viewer's credentials to an external image host.
      if (url.origin !== api.origin || !/^\/api\/branding\/logo\/(rectangle|square)$/.test(url.pathname)) continue;
      const response = await authedFetch(url.href, { signal: AbortSignal.timeout(5000) });
      if (response.ok) branding.logo_base64 = await pngBase64(await response.blob());
      if (branding.logo_base64) break;
    } catch { /* Missing branding images must not prevent downloading the document. */ }
  }
  return branding;
}

export function usePdfBranding() {
  // PDFs use the print palette; this hook does not change the app's CSS tokens.
  const branding = useBranding({ applyTheme: false });
  const { authedFetch, baseUrl } = useBifrostContext();
  return { loading: branding.loading, prepare: () => loadPdfBranding(authedFetch, branding, baseUrl) };
}
