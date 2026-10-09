import { useEffect, useState } from "react";
import { createAnonymizer, type Anonymizer } from "./anonymize";

/**
 * App-wide demo anonymizer store. A single anonymizer instance lives at module
 * scope so its learned token map is shared across every page; `useAnonymize()`
 * subscribes components to the on/off toggle. The toggle persists in
 * localStorage so it survives reloads.
 *
 * The field labels below are the GRC app's sensitive fields. `org_name` /
 * `user_name` are explicit hints passed from lib/directory.ts (both normalize
 * to a generic `name`); the rest let `anon.object()` tokenize raw rows by key
 * and double as a starting set for other apps that copy this module.
 */

const ENABLED_KEY = "grc-anonymize-enabled";

const anon = createAnonymizer({
  storageKey: "grc-anon-token-map",
  labels: {
    org_name: "Client",
    user_name: "User",
    client_name: "Client",
    company: "Client",
    name: "Name",
    address: "Location",
    contact_name: "Contact",
  },
});

function loadEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = loadEnabled();
anon.enabled = enabled;

const listeners: Array<() => void> = [];

export function getAnonymizer(): Anonymizer {
  return anon;
}

export function isAnonymizeEnabled(): boolean {
  return enabled;
}

export function setAnonymizeEnabled(next: boolean): void {
  enabled = next;
  anon.enabled = next;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ENABLED_KEY, next ? "1" : "0");
    }
  } catch {
    // ignore — toggle stays in-memory for this session.
  }
  for (const l of listeners) l();
}

export interface UseAnonymize {
  enabled: boolean;
  anon: Anonymizer;
  setEnabled: (next: boolean) => void;
  reset: () => void;
}

export function useAnonymize(): UseAnonymize {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.push(l);
    return () => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    };
  }, []);
  return {
    enabled,
    anon,
    setEnabled: setAnonymizeEnabled,
    reset: () => {
      anon.reset();
      for (const l of listeners) l();
    },
  };
}
