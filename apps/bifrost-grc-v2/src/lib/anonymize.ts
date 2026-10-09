/**
 * Reusable, framework-agnostic data anonymizer for demos.
 *
 * Tokenizes identifiable values (client names, addresses, emails, …) into stable
 * demo tokens so the UI shows "Client A" instead of "Acme Corp" while real data
 * stays intact underneath. Field-name driven: you configure which field names are
 * sensitive and what label their tokens carry; tokens are auto-assigned per
 * distinct value and persisted so they stay stable across reloads and pages.
 *
 * No React / platform imports — copy this file into any Bifrost app and pair it
 * with a small context provider (see anonymize-context.tsx) to expose a toggle.
 */

export interface AnonymizerConfig {
  /** field name -> human label prefix for generated tokens (e.g. { client_name: "Client" }). */
  labels: Record<string, string>;
  /** force specific real values to a fixed token, bypassing auto-generation. */
  overrides?: Record<string, string>;
  /** localStorage key the learned value->token map persists under. */
  storageKey?: string;
}

export interface Anonymizer {
  /** when false every method is a pass-through. */
  enabled: boolean;
  /** tokenize a single value; `field` selects the label + counter namespace. */
  value(raw: string | null | undefined, field: string): string;
  /** tokenize an email into a realistic demo address (stable per input). */
  email(raw: string | null | undefined): string;
  /** tokenize a domain (stable per input). */
  domain(raw: string | null | undefined): string;
  /** deep-walk an object/array, tokenizing any string prop whose key is a configured field. */
  object<T>(input: T): T;
  /** replace any already-learned real value found as a substring of free text. */
  text(raw: string | null | undefined): string;
  /** forget every learned token (clears the persisted map). */
  reset(): void;
}

interface PersistedState {
  // real value -> token, namespaced by label so the same string under two fields
  // can map to different tokens ("Client A" vs "User A").
  byLabel: Record<string, Record<string, string>>;
  counters: Record<string, number>;
}

const DEFAULT_STORAGE_KEY = "anon-token-map";

function emptyState(): PersistedState {
  return { byLabel: {}, counters: {} };
}

function loadState(storageKey: string): PersistedState {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      byLabel: parsed.byLabel ?? {},
      counters: parsed.counters ?? {},
    };
  } catch {
    return emptyState();
  }
}

function saveState(storageKey: string, state: PersistedState): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(storageKey, JSON.stringify(state));
    }
  } catch {
    // localStorage unavailable (private mode / SSR) — tokens stay in-memory only.
  }
}

/** 0 -> "A", 1 -> "B", … 25 -> "Z", 26 -> "AA". */
function indexToLetters(n: number): string {
  let out = "";
  let i = n;
  do {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

export function createAnonymizer(config: AnonymizerConfig): Anonymizer {
  const storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY;
  const overrides = config.overrides ?? {};
  const labels = config.labels;
  let state = loadState(storageKey);

  function persist(): void {
    saveState(storageKey, state);
  }

  function tokenFor(raw: string, label: string): string {
    if (Object.prototype.hasOwnProperty.call(overrides, raw)) return overrides[raw];
    const bucket = (state.byLabel[label] ??= {});
    const existing = bucket[raw];
    if (existing) return existing;
    const next = state.counters[label] ?? 0;
    state.counters[label] = next + 1;
    const token = `${label} ${indexToLetters(next)}`;
    bucket[raw] = token;
    persist();
    return token;
  }

  const api: Anonymizer = {
    enabled: false,

    value(raw, field) {
      if (!api.enabled || raw == null || raw === "") return raw ?? "";
      const label = labels[field] ?? field;
      return tokenFor(String(raw), label);
    },

    email(raw) {
      if (!api.enabled || raw == null || raw === "") return raw ?? "";
      const key = String(raw);
      const bucket = (state.byLabel["__email__"] ??= {});
      const existing = bucket[key];
      if (existing) return existing;
      const next = state.counters["__email__"] ?? 0;
      state.counters["__email__"] = next + 1;
      const token = `contact${next + 1}@example.com`;
      bucket[key] = token;
      persist();
      return token;
    },

    domain(raw) {
      if (!api.enabled || raw == null || raw === "") return raw ?? "";
      const key = String(raw);
      const bucket = (state.byLabel["__domain__"] ??= {});
      const existing = bucket[key];
      if (existing) return existing;
      const next = state.counters["__domain__"] ?? 0;
      state.counters["__domain__"] = next + 1;
      const token = `demo-${next + 1}.example`;
      bucket[key] = token;
      persist();
      return token;
    },

    object(input) {
      if (!api.enabled || input == null) return input;
      const walk = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (typeof v === "string" && Object.prototype.hasOwnProperty.call(labels, k)) {
              out[k] = tokenFor(v, labels[k]);
            } else {
              out[k] = walk(v);
            }
          }
          return out;
        }
        return node;
      };
      return walk(input) as typeof input;
    },

    text(raw) {
      if (!api.enabled || raw == null || raw === "") return raw ?? "";
      let out = String(raw);
      // collect every learned real value, longest first so "Acme Corp Ltd"
      // is replaced before "Acme Corp".
      const pairs: Array<[string, string]> = [];
      for (const bucket of Object.values(state.byLabel)) {
        for (const [real, token] of Object.entries(bucket)) pairs.push([real, token]);
      }
      pairs.sort((a, b) => b[0].length - a[0].length);
      for (const [real, token] of pairs) {
        if (real && out.includes(real)) out = out.split(real).join(token);
      }
      return out;
    },

    reset() {
      state = emptyState();
      persist();
    },
  };

  return api;
}
