import { useCallback, useEffect, useState } from "react";

const EVENT_NAME = "bifrost-grc:app-state";

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * v2 replacement for the legacy useAppState hook. Values survive navigation
 * and refresh, and updates are broadcast to other mounted consumers.
 */
export function useAppState<T>(key: string, initialValue: T) {
  const storageKey = `bifrost-grc:${key}`;
  const [value, setValue] = useState<T>(() => readStored(storageKey, initialValue));

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setValue(readStored(storageKey, initialValue));
    };
    const onLocalUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; value: T }>).detail;
      if (detail?.key === storageKey) setValue(detail.value);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT_NAME, onLocalUpdate);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT_NAME, onLocalUpdate);
    };
  }, [initialValue, storageKey]);

  const update = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
        window.localStorage.setItem(storageKey, JSON.stringify(resolved));
        window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { key: storageKey, value: resolved } }));
        return resolved;
      });
    },
    [storageKey],
  );

  return [value, update] as const;
}
