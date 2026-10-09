import { tables as directTables, useWorkflowMutation } from "bifrost";

const protectedTables = new Set([
  "grc-policies", "grc-exceptions", "grc-findings", "grc-evidence",
  "grc-questionnaire-recommendations",
]);

/** Route compliance attribution through the authenticated workflow. */
export function useGovernedTables(): typeof directTables {
  const { mutate } = useWorkflowMutation("workflows/grc_v2/grc_record_mutations.py::grc_v2_mutate_record");
  const write = (table: string, action: string, payload?: unknown, row_id?: string) =>
    mutate({ table, action, payload, row_id });
  return {
    ...directTables,
    insert: async (table, data, scope) => {
      if (!protectedTables.has(table)) return Array.isArray(data)
        ? directTables.insert(table, data, scope) : directTables.insert(table, data, scope);
      if (Array.isArray(data)) {
        const rows = [];
        for (const item of data) rows.push(await write(table, "create", item.data));
        return rows;
      }
      return write(table, "create", data);
    },
    update: (table, id, data, scope) => protectedTables.has(table)
      ? write(table, "update", data, id)
      : directTables.update(table, id, data, scope),
    delete: async (table, id, scope) => {
      if (!protectedTables.has(table)) return directTables.delete(table, id, scope);
      if (Array.isArray(id)) {
        let count = 0;
        for (const item of id) if (await write(table, "delete", undefined, item)) count++;
        return count;
      }
      return write(table, "delete", undefined, id);
    },
    upsert: (table, data, scope) => {
      if (protectedTables.has(table)) throw new Error("Use create or update for compliance records.");
      return directTables.upsert(table, data, scope);
    },
  } as typeof directTables;
}
