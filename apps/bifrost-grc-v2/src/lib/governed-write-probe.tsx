/** Browser regression fixture; never imported by the application. */
import React from "react";
import { createRoot } from "react-dom/client";
import { BifrostProvider } from "bifrost";
import { useGovernedTables } from "./governed-tables";

export function mountProbe() {
  function Probe() {
    (window as any).__governed = useGovernedTables();
    return null;
  }
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  root.render(<BifrostProvider baseUrl={location.origin} token="fixture" orgScope="own" appId="fixture"><Probe /></BifrostProvider>);
  return () => root.unmount();
}
