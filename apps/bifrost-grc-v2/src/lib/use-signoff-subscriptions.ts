import { useEffect, useState } from "react";
import { tables } from "bifrost";

const SIGNOFF_TABLES = [
  "grc-policy-campaigns",
  "grc-policy-campaign-assignments",
  "grc-policy-acceptances",
];

/** Subscribe to the records behind the workflow's authorized status projection. */
export function useSignoffSubscriptions(organizationId: string, enabled: boolean) {
  const [revision, setRevision] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const cleanup: Array<() => void> = [];
    const invalidate = () => {
      if (disposed || pending !== undefined) return;
      // A signature changes multiple tables. Refresh their joined projection once.
      pending = setTimeout(() => {
        pending = undefined;
        if (!disposed) setRevision((value) => value + 1);
      }, 50);
    };
    setUnavailable(false);
    const filter = { eq: [{ row: "organization_id" }, organizationId] };
    for (const name of SIGNOFF_TABLES) {
      void tables.query(name, { where: { organization_id: organizationId }, limit: 1 }).then((snapshot) => {
        if (disposed) return;
        if (!snapshot.table_id) throw new Error("Missing subscription table identity");
        cleanup.push(tables.subscribe(snapshot.table_id, filter, (event) => {
          if (disposed) return;
          if (event.type === "document_change" || event.type === "table_invalidated" || event.type === "subscribed") invalidate();
          if (event.type === "error" || event.type === "subscription_revoked") setUnavailable(true);
        }, invalidate));
      }).catch(() => { if (!disposed) setUnavailable(true); });
    }
    return () => {
      disposed = true;
      clearTimeout(pending);
      cleanup.forEach((unsubscribe) => unsubscribe());
    };
  }, [organizationId, enabled, attempt]);

  return { revision, unavailable, retry: () => setAttempt((value) => value + 1) };
}
