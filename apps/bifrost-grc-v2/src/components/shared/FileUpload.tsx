import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkflowMutation } from "bifrost";
import { Upload, X } from "lucide-react";
import { WF_GET_UPLOAD_URL } from "../../lib/grc-tables";

export interface UploadedFile {
  path: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}

interface FileUploadProps {
  onUploaded: (file: UploadedFile) => void;
  organizationId: string | null;
  accept?: string;
  acceptLabel?: string;
  maxSizeMb?: number;
  label?: string;
  multiple?: boolean;
  disabled?: boolean;
  initialFile?: File | null;
}

/**
 * Drop-zone + click-to-pick file input. Uses the `Get Upload URL` workflow
 * to mint a signed PUT URL, then uploads the file straight to storage from
 * the browser and reports the saved path back via `onUploaded`.
 */
export default function FileUpload({
  onUploaded,
  organizationId,
  accept,
  acceptLabel,
  maxSizeMb = 25,
  label = "Drop a file or click to choose",
  multiple = false,
  disabled = false,
  initialFile = null,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const initialFileRef = useRef<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { mutate: getUploadUrl } = useWorkflowMutation(WF_GET_UPLOAD_URL);

  const uploadOne = useCallback(async (file: File) => {
      setError(null);
      if (file.size > maxSizeMb * 1024 * 1024) {
        const msg = `File is larger than ${maxSizeMb} MB.`;
        setError(msg);
        toast.error(msg);
        return;
      }
      setProgress(0);
      try {
        const signed = (await getUploadUrl({
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          organization_id: organizationId,
        })) as { url: string; path: string };

        if (!signed?.url || !signed?.path) {
          throw new Error("Upload URL response missing url/path");
        }

        // Use XHR so we can show progress.
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", signed.url, true);
          if (file.type) xhr.setRequestHeader("Content-Type", file.type);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setProgress(Math.round((e.loaded / e.total) * 100));
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`Upload failed (${xhr.status})`));
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.send(file);
        });

        onUploaded({
          path: signed.path,
          name: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? "Upload failed";
        setError(msg);
        toast.error("Upload failed: " + msg);
      } finally {
        setProgress(null);
      }
    }, [getUploadUrl, maxSizeMb, onUploaded, organizationId]);

  useEffect(() => {
    if (!initialFile || initialFileRef.current === initialFile || disabled) return;
    initialFileRef.current = initialFile;
    uploadOne(initialFile);
  }, [disabled, initialFile, uploadOne]);

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    for (const f of files) {
      await uploadOne(f);
      if (!multiple) break;
    }
  };

  const onDrop = (e: { preventDefault: () => void; dataTransfer: DataTransfer }) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className="cv-card"
        style={{
          padding: 20,
          borderStyle: "dashed",
          borderColor: dragOver ? "var(--cv-cb)" : "var(--cv-border)",
          background: dragOver ? "var(--cv-bg-3)" : "var(--cv-bg-2)",
          cursor: disabled ? "not-allowed" : "pointer",
          textAlign: "center",
          transition: "border-color .15s, background .15s",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10, color: "var(--cv-fg-2)" }}>
          <Upload size={18} />
          <span style={{ fontSize: 14 }}>{label}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--cv-fg-3)" }}>
          Max {maxSizeMb} MB{acceptLabel ? ` · ${acceptLabel}` : accept ? " · Supported file types" : ""}
        </div>
        <input
          aria-label={label}
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          style={{ display: "none" }}
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {progress !== null ? (
        <div
          role="progressbar"
          aria-label="File upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          style={{
            height: 6,
            background: "var(--cv-bg-3)",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              background: "var(--cv-action)",
              transition: "width .2s",
            }}
          />
        </div>
      ) : null}
      {error ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--cv-red)",
            fontSize: 12,
          }}
        >
          <X size={12} />
          {error}
        </div>
      ) : null}
    </div>
  );
}
