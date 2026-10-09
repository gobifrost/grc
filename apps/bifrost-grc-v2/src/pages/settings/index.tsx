import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useWorkflowMutation, useWorkflowQuery } from "bifrost";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Loader2, AlertCircle, Save, RotateCcw, EyeOff, Replace } from "lucide-react";

import PageHeader from "../../components/shared/PageHeader";
import ThemedSelect, { type ThemedSelectOption } from "../../components/shared/ThemedSelect";
import { useAnonymize } from "../../lib/anonymize-store";
import { useGrcPermissions } from "../../lib/current-user";

const WF_LIST_PDF_MODELS = "workflows/grc_v2/grc_settings.py::grc_list_pdf_models";
const WF_GET_SETTINGS = "workflows/grc_v2/grc_settings.py::grc_get_questionnaire_settings";
const WF_SET_SETTINGS = "workflows/grc_v2/grc_settings.py::grc_set_questionnaire_settings";

interface PdfModel {
  model_id: string;
  name: string;
  context_length?: number | null;
  pricing_input_per_mtok?: number | null;
  pricing_output_per_mtok?: number | null;
}

interface SettingsData {
  override_model: string;
  integration_default_model: string;
  effective_model: string;
  config_key: string;
}

function formatPrice(p: number | null | undefined): string {
  if (p == null || p < 0) return "—";
  return `$${p.toFixed(2)}`;
}

function formatContext(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export default function SettingsPage() {
  const { canEdit } = useGrcPermissions();
  const {
    data: modelsData,
    loading: modelsLoading,
    error: modelsError,
  } = useWorkflowQuery<{ models: PdfModel[]; count: number }>(WF_LIST_PDF_MODELS, {});

  const {
    data: settings,
    loading: settingsLoading,
    error: settingsError,
    refresh: refetchSettings,
  } = useWorkflowQuery<SettingsData>(WF_GET_SETTINGS, {});

  const { mutate: saveSettings, loading: saving } = useWorkflowMutation(WF_SET_SETTINGS);

  const { enabled: anonEnabled, setEnabled: setAnonEnabled, reset: resetAnon } = useAnonymize();

  const [selectedModel, setSelectedModel] = useState<string>("");

  useEffect(() => {
    if (settings) setSelectedModel(settings.override_model || "");
  }, [settings?.override_model]);

  const models = modelsData?.models ?? [];

  const selectedDetails = useMemo(
    () => models.find((m) => m.model_id === selectedModel) ?? null,
    [models, selectedModel],
  );

  const options = useMemo<ThemedSelectOption[]>(
    () => [
      { value: "", label: "Use integration default" },
      ...models.map((m) => ({
        value: m.model_id,
        label: m.name,
        hint: m.model_id,
      })),
    ],
    [models],
  );

  const dirty = (selectedModel || "") !== (settings?.override_model || "");
  const integrationDefault = settings?.integration_default_model || "—";
  const effective = selectedModel || settings?.integration_default_model || "—";

  async function handleSave() {
    try {
      await saveSettings({ model: selectedModel || null });
      toast.success(
        selectedModel
          ? "Questionnaire model override saved."
          : "Override cleared — using integration default.",
      );
      await refetchSettings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to save: ${msg}`);
    }
  }

  function handleReset() {
    setSelectedModel(settings?.override_model || "");
  }

  return (
    <div className="flex flex-col gap-6" style={{ maxWidth: 880, margin: "0 auto", width: "100%" }}>
      <PageHeader
        title="Settings"
        subtitle="Configure how Bifrost GRC processes questionnaires and source documents."
      />

      <Card className="cv-card" style={{ padding: 24 }}>
        <div className="flex flex-col gap-4">
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--cv-fg-1)", marginBottom: 4 }}>
              Questionnaire AI Model
            </h2>
            <p style={{ fontSize: 13, color: "var(--cv-fg-2)" }}>
              Model used for extracting questions from source documents and drafting answers. Only
              models that support PDF input are listed. Leave on "Use integration default" to
              follow the OpenRouter integration's <code>default_model</code> setting.
            </p>
          </div>

          {settingsLoading || modelsLoading ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cv-fg-2)" }}>
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          ) : settingsError || modelsError ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cv-danger)" }}>
              <AlertCircle size={14} />
              Failed to load settings.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--cv-fg-2)" }}>
                  Model override
                </label>
                <ThemedSelect
                  value={selectedModel}
                  onChange={setSelectedModel}
                  options={options}
                  searchable
                  ariaLabel="Questionnaire model"
                  disabled={!canEdit}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(180px, max-content) 1fr",
                  rowGap: 8,
                  columnGap: 16,
                  fontSize: 13,
                  background: "var(--cv-bg-2)",
                  borderRadius: 8,
                  padding: "12px 16px",
                  border: "1px solid var(--cv-border-1)",
                }}
              >
                <div style={{ color: "var(--cv-fg-2)" }}>Integration default</div>
                <div style={{ color: "var(--cv-fg-1)", fontFamily: "var(--cv-font-mono)" }}>
                  {integrationDefault}
                </div>
                <div style={{ color: "var(--cv-fg-2)" }}>Effective model</div>
                <div style={{ color: "var(--cv-fg-1)", fontFamily: "var(--cv-font-mono)" }}>
                  {effective}
                </div>
                {selectedDetails ? (
                  <>
                    <div style={{ color: "var(--cv-fg-2)" }}>Context window</div>
                    <div style={{ color: "var(--cv-fg-1)" }}>
                      {formatContext(selectedDetails.context_length)} tokens
                    </div>
                    <div style={{ color: "var(--cv-fg-2)" }}>Pricing (in / out)</div>
                    <div style={{ color: "var(--cv-fg-1)" }}>
                      {formatPrice(selectedDetails.pricing_input_per_mtok)} /{" "}
                      {formatPrice(selectedDetails.pricing_output_per_mtok)} per 1M tokens
                    </div>
                  </>
                ) : null}
              </div>

              {canEdit ? <div className="flex items-center gap-2 justify-end">
                <Button
                  variant="ghost"
                  onClick={handleReset}
                  disabled={!dirty || saving}
                >
                  <RotateCcw size={14} /> Reset
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={!dirty || saving}
                >
                  {saving ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Saving…
                    </>
                  ) : (
                    <>
                      <Save size={14} /> Save
                    </>
                  )}
                </Button>
              </div> : null}
            </>
          )}
        </div>
      </Card>

      <Card className="cv-card" style={{ padding: 24 }}>
        <div className="flex flex-col gap-4">
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--cv-fg-1)", marginBottom: 4 }}>
              Anonymize data
            </h2>
            <p style={{ fontSize: 13, color: "var(--cv-fg-2)" }}>
              Replace client names, domains, and user identities with stable demo tokens
              (e.g. <code>Client A</code>, <code>contact1@example.com</code>) throughout the app.
              Real data is untouched — only what's displayed changes. Tokens stay consistent
              across pages and reloads. Use this for screen-shares and demos.
            </p>
          </div>

          <div
            className="flex items-center justify-between"
            style={{
              background: "var(--cv-bg-2)",
              borderRadius: 8,
              padding: "14px 16px",
              border: "1px solid var(--cv-border-1)",
            }}
          >
            <div className="flex items-center gap-2">
              <EyeOff size={16} style={{ color: "var(--cv-fg-2)" }} />
              <div className="flex flex-col">
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--cv-fg-1)" }}>
                  Anonymize displayed data
                </span>
                <span style={{ fontSize: 12, color: "var(--cv-fg-3)" }}>
                  {anonEnabled ? "On — showing demo tokens" : "Off — showing real data"}
                </span>
              </div>
            </div>
            <Switch
              aria-label="Anonymize displayed data"
              checked={anonEnabled}
              onCheckedChange={(v: boolean) => {
                setAnonEnabled(v);
                toast.success(v ? "Anonymization on — showing demo tokens." : "Anonymization off.");
              }}
            />
          </div>

          {anonEnabled ? (
            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                onClick={() => {
                  resetAnon();
                  toast.success("Token map reset — new tokens will be assigned.");
                }}
              >
                <RotateCcw size={14} /> Reset tokens
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
