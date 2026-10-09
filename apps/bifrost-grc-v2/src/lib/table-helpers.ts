import { tables } from "bifrost";

/**
 * Normalize a single-row read from the tables SDK.
 *
 * `tables.get(table, id)` returns the raw storage shape:
 *   { id, table_id, data: { ...domain fields }, created_at, updated_at, created_by, updated_by }
 * while `useTable` flattens `data.*` onto the row. Detail pages read fields like
 * `row.name` directly, so without flattening every domain field reads as
 * undefined (blank title, "Global" scope, empty form). This lifts `data.*` to
 * the top level while preserving the base audit columns.
 */
export function unwrapRow<T>(raw: unknown): (T & { id: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ("data" in r && r.data && typeof r.data === "object") {
    const { data, ...base } = r;
    return { ...base, ...(data as Record<string, unknown>), id: String(r.id ?? "") } as T & {
      id: string;
    };
  }
  return r as T & { id: string };
}

/** Fetch one row by id and normalize it (see {@link unwrapRow}). */
export async function getRow<T>(table: string, id: string): Promise<(T & { id: string }) | null> {
  const raw = await tables.get(table, id);
  return unwrapRow<T>(raw);
}
