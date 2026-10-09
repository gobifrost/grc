import OrgPicker from "./OrgPicker";
import MultiSelectDropdown from "./MultiSelectDropdown";
import StateSegmented, { type StateOption } from "./StateSegmented";
import { useOrgsList } from "../../lib/directory";

export type OrgScopeMode = "one" | "some" | "all";

interface OrgScopeFieldProps {
  id: string;
  label?: string;
  value: string[] | null;
  onChange: (organizationIds: string[] | null) => void;
  disabled?: boolean;
  modeLabels?: Partial<Record<OrgScopeMode, string>>;
  oneOrganizationId?: string;
  hideOnePicker?: boolean;
}

const MODES: Array<StateOption<OrgScopeMode>> = [
  { value: "one", label: "One", tone: "teal" },
  { value: "some", label: "Some", tone: "purple" },
  { value: "all", label: "All", tone: "green" },
];

function initialMode(value: string[] | null): OrgScopeMode {
  if (value === null) return "all";
  return value.length > 1 ? "some" : "one";
}

/**
 * Canonical GRC organization relationship: one organization, a selected set,
 * or all organizations (including organizations added later).
 */
export default function OrgScopeField({
  id,
  label = "Organizations",
  value,
  onChange,
  disabled = false,
  modeLabels,
  oneOrganizationId,
  hideOnePicker = false,
}: OrgScopeFieldProps) {
  const mode = initialMode(value);
  const { orgs } = useOrgsList();
  const selected = value ?? [];
  const modes = MODES.map((option) => ({ ...option, label: modeLabels?.[option.value] ?? option.label }));

  const changeMode = (next: OrgScopeMode) => {
    if (next === "all") onChange(null);
    else if (next === "one") onChange(oneOrganizationId ? [oneOrganizationId] : selected.slice(0, 1));
    else onChange(selected);
  };

  return (
    <fieldset className="cv-fieldset" disabled={disabled}>
      <legend className="cv-field-label">{label}</legend>
      <StateSegmented
        value={mode}
        options={modes}
        onChange={changeMode}
        ariaLabel={`${label} scope`}
        disabled={disabled}
        compact
      />
      <div className="cv-org-scope__editor">
        {mode === "one" && !hideOnePicker ? (
          <OrgPicker
            id={`${id}-one`}
            value={selected[0] ?? oneOrganizationId ?? null}
            onChange={(organizationId) => onChange(organizationId ? [organizationId] : [])}
            allowGlobal={false}
            label="Organization"
            disabled={disabled}
          />
        ) : null}
        {mode === "some" ? (
          <MultiSelectDropdown
            label="Selected organizations"
            options={orgs.map((organization) => ({
              value: organization.id,
              label: organization.name,
              hint: organization.domain ?? undefined,
            }))}
            selectedValues={selected}
            onToggle={(organizationId, isSelected) => {
              onChange(
                isSelected
                  ? [...selected, organizationId]
                  : selected.filter((id) => id !== organizationId),
              );
            }}
            placeholder="Select organizations…"
            disabled={disabled}
          />
        ) : null}
        {mode === "all" ? (
          <div className="cv-callout cv-callout--note">
            <div className="cv-callout__body">
              Applies to every organization, including organizations added later.
            </div>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
