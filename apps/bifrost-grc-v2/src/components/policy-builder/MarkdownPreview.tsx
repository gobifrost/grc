import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { useWorkflowMutation } from "bifrost";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatFactValue, parseFactValue } from "../../lib/standard-facts";
import { replaceFactMarkers } from "../../lib/fact-markers";
import type { FactDefinition, GrcFact } from "../../lib/types";

import { WF_GET_POLICY_DOWNLOAD_URL } from "../../lib/grc-tables";
interface MarkdownPreviewProps {
  source: string;
  factDefinitions?: FactDefinition[];
  facts?: GrcFact[];
  onFactClick?: (factKey: string) => void;
}

const POLICY_FILE_PREFIX = "bifrost-policy-file://";

function parsePolicyFileUri(src?: string) {
  if (!src?.startsWith(POLICY_FILE_PREFIX)) return null;
  const value = src.slice(POLICY_FILE_PREFIX.length);
  const slash = value.indexOf("/");
  if (slash < 1) return null;
  return {
    policyId: value.slice(0, slash),
    path: decodeURIComponent(value.slice(slash + 1)),
  };
}

function PolicyImage({ src, alt }: { src?: string; alt?: string }) {
  const managed = parsePolicyFileUri(src);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(managed ? null : src ?? null);
  const [failed, setFailed] = useState(false);
  const { mutate: getDownloadUrl } = useWorkflowMutation(WF_GET_POLICY_DOWNLOAD_URL);

  useEffect(() => {
    if (!managed) {
      setResolvedUrl(src ?? null);
      return;
    }
    let active = true;
    setFailed(false);
    getDownloadUrl({ policy_id: managed.policyId, path: managed.path })
      .then((result) => {
        if (active) setResolvedUrl((result as { url?: string })?.url ?? null);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [getDownloadUrl, managed?.path, managed?.policyId, src]);

  if (failed) return <span role="img" aria-label={alt}>[Image unavailable: {alt || "policy image"}]</span>;
  if (!resolvedUrl) return <span style={{ color: "var(--cv-fg-3)" }}>Loading image…</span>;
  return (
    <img
      src={resolvedUrl}
      alt={alt ?? ""}
      style={{ display: "block", maxWidth: "100%", height: "auto", margin: "14px 0", borderRadius: 8 }}
    />
  );
}

function factMarkdownSource(fact?: GrcFact): string {
  const value = parseFactValue(fact);
  if (Array.isArray(value)) return value.map((item) => `- ${String(item)}`).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.name, record.role, record.email, record.phone].filter(Boolean).map(String).join(" · ");
  }
  return value == null ? "Not answered" : String(value);
}

function factInlineLabel(fact?: GrcFact): string {
  return formatFactValue(fact)
    .replace(/[\\`*_{}\[\]#>|~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Markdown preview tuned to CDS tokens. No tailwind classes — every visual
 * style comes from inline style tied to --cv-* variables so it matches the
 * rest of the app even when Tailwind classes get purged.
 */
export default function MarkdownPreview({ source, factDefinitions = [], facts = [], onFactClick }: MarkdownPreviewProps) {
  const [selectedFactKey, setSelectedFactKey] = useState<string | null>(null);
  const definitionsByKey = useMemo(() => new Map(factDefinitions.map((item) => [item.key, item])), [factDefinitions]);
  const factsByKey = useMemo(() => new Map(facts.map((item) => [item.fact_key, item])), [facts]);
  const fieldExpandedSource = useMemo(() => source.split("\n").map((line) => {
    const field = line.match(/^\s*-\s+\*\*([^*]+?):\*\*\s*(\{\{fact:.+\}\})\s*$/i);
    if (!field) return line;
    let expanded = line;
    replaceFactMarkers(field[2], (key, fallback) => {
      const fact = factsByKey.get(key);
      const fallbackText = fallback?.trim() && fallback.trim().toLowerCase() !== "open item" ? fallback.trim() : "Not answered";
      const value = fact ? factMarkdownSource(fact) : fallbackText;
      expanded = `##### [${field[1]}](grc-fact-label:${key})\n\n${value}`;
      return "";
    });
    return expanded;
  }).join("\n"), [factsByKey, source]);
  const renderedSource = useMemo(() => replaceFactMarkers(fieldExpandedSource, (key: string, fallback?: string) => {
    const definition = definitionsByKey.get(key);
    const fact = factsByKey.get(key);
    const value = factInlineLabel(fact);
    const label = fact && value !== "Not answered" ? value : (fallback?.trim() || definition?.title || key);
    return `[${label.replace(/[\[\]]/g, "")}](${`grc-fact:${key}`})`;
  }), [definitionsByKey, factsByKey, fieldExpandedSource]);
  const selectedDefinition = selectedFactKey ? definitionsByKey.get(selectedFactKey) : undefined;
  const selectedFact = selectedFactKey ? factsByKey.get(selectedFactKey) : undefined;
  if (!source || !source.trim()) {
    return (
      <div
        style={{
          color: "var(--cv-fg-3)",
          fontStyle: "italic",
          padding: "32px 4px",
          textAlign: "center",
        }}
      >
        Nothing to preview yet. Switch to the Markdown tab and write the policy.
      </div>
    );
  }

  return (
    <div className="cv-markdown" style={{ color: "var(--cv-fg-1)", lineHeight: 1.65 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          img: ({ src, alt }) => <PolicyImage src={src} alt={alt} />,
          h1: ({ children }) => (
            <h1
              style={{
                fontSize: 26,
                fontWeight: 600,
                color: "var(--cv-fg-1)",
                letterSpacing: "-0.01em",
                margin: "20px 0 12px",
                borderBottom: "1px solid var(--cv-border)",
                paddingBottom: 8,
              }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: "var(--cv-fg-1)",
                margin: "24px 0 10px",
              }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--cv-fg-1)",
                margin: "18px 0 8px",
              }}
            >
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--cv-fg-2)",
                textTransform: "uppercase",
                letterSpacing: 1,
                margin: "16px 0 6px",
              }}
            >
              {children}
            </h4>
          ),
          h5: ({ children }) => <h5 className="cv-fact-field__label">{children}</h5>,
          p: ({ children }) => (
            <p style={{ margin: "10px 0", color: "var(--cv-fg-2)" }}>{children}</p>
          ),
          ul: ({ children }) => (
            <ul
              style={{
                margin: "10px 0",
                paddingLeft: 22,
                color: "var(--cv-fg-2)",
                listStyle: "disc",
              }}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              style={{
                margin: "10px 0",
                paddingLeft: 22,
                color: "var(--cv-fg-2)",
                listStyle: "decimal",
              }}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => <li style={{ margin: "4px 0" }}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: "12px 0",
                padding: "10px 14px",
                borderLeft: "3px solid var(--cv-accent)",
                background: "var(--cv-bS)",
                color: "var(--cv-fg-2)",
                borderRadius: 4,
              }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const isBlock = className && className.startsWith("language-");
            if (isBlock) return <>{children}</>;
            return (
              <code
                style={{
                  background: "var(--cv-bg-3)",
                  color: "var(--cv-fg-1)",
                  padding: "1px 6px",
                  borderRadius: 4,
                  fontFamily: "var(--cv-font-mono)",
                  fontSize: 13,
                }}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre
              style={{
                background: "var(--cv-bg-3)",
                border: "1px solid var(--cv-border)",
                color: "var(--cv-fg-1)",
                padding: 14,
                borderRadius: 8,
                overflow: "auto",
                fontFamily: "var(--cv-font-mono)",
                fontSize: 13,
                margin: "12px 0",
              }}
            >
              {children}
            </pre>
          ),
          a: ({ children, href }) => href?.startsWith("grc-fact-label:") ? (
            <button
              type="button"
              className="cv-fact-field__link"
              onClick={() => {
                const factKey = href.slice(15);
                onFactClick ? onFactClick(factKey) : setSelectedFactKey(factKey);
              }}
              title="View or edit this reusable fact"
            >
              {children}
            </button>
          ) : href?.startsWith("grc-fact:") ? (
            <button
              type="button"
              className={`cv-chip ${factsByKey.get(href.slice(9)) ? "cv-chip--teal" : "cv-chip--neutral"}`}
              onClick={() => onFactClick ? onFactClick(href.slice(9)) : setSelectedFactKey(href.slice(9))}
              title={onFactClick ? "Edit this fact in the policy" : "View reusable GRC fact"}
              style={{ cursor: "pointer", verticalAlign: "baseline" }}
            >
              {children}
            </button>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--cv-accent)", textDecoration: "underline" }}
            >
              {children}
            </a>
          ),
          hr: () => (
            <hr
              style={{
                border: 0,
                borderTop: "1px solid var(--cv-border)",
                margin: "20px 0",
              }}
            />
          ),
          table: ({ children }) => (
            <div style={{ overflow: "auto", margin: "12px 0" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                  color: "var(--cv-fg-2)",
                }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              style={{
                textAlign: "left",
                padding: "8px 10px",
                borderBottom: "1px solid var(--cv-border)",
                color: "var(--cv-fg-1)",
                fontWeight: 600,
                background: "var(--cv-bg-3)",
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                padding: "8px 10px",
                borderBottom: "1px solid var(--cv-border)",
              }}
            >
              {children}
            </td>
          ),
        }}
      >
        {renderedSource}
      </ReactMarkdown>
      <Dialog open={Boolean(selectedFactKey)} onOpenChange={(open) => { if (!open) setSelectedFactKey(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedDefinition?.title ?? selectedFactKey}</DialogTitle>
            <DialogDescription>{selectedDefinition?.description ?? "Reusable customer fact referenced by this document."}</DialogDescription>
          </DialogHeader>
          <div><div className="cv-small">Current value</div><div className="cv-markdown cv-fact-markdown-value"><ReactMarkdown remarkPlugins={[remarkGfm]}>{factMarkdownSource(selectedFact)}</ReactMarkdown></div></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span className="cv-chip cv-chip--neutral">{(selectedFact?.status ?? "unanswered").split("_").join(" ")}</span>
            {selectedFact?.source_system ? <span className="cv-chip cv-chip--neutral">Source: {selectedFact.source_system}</span> : null}
            {selectedFact?.verified_at ? <span className="cv-chip cv-chip--neutral">Verified {new Date(selectedFact.verified_at).toLocaleDateString()}</span> : null}
          </div>
          <Link className="cv-btn cv-btn--secondary" to={`/open-items?fact=${encodeURIComponent(selectedFactKey ?? "")}`}>Open in Open Items</Link>
        </DialogContent>
      </Dialog>
    </div>
  );
}
