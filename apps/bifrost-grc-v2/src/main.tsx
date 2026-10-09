import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { BifrostProvider } from "bifrost";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/prompt/400.css";
import "@fontsource/prompt/600.css";

import App from "./App";
import "./index.css";
import "./components/bifrost/components.css";

export function mount(mountEl: HTMLElement, bootstrap: BifrostAppBootstrap) {
  const root = createRoot(mountEl);
  root.render(
    <StrictMode>
      <BifrostProvider
        baseUrl={bootstrap.baseUrl}
        token={bootstrap.token}
        orgScope={bootstrap.orgScope}
        appId={bootstrap.appId}
        theme={bootstrap.theme}
        supportsTheme
        onLogout={bootstrap.onLogout}
      >
        <BrowserRouter basename={bootstrap.basename}>
          <App />
        </BrowserRouter>
      </BifrostProvider>
    </StrictMode>,
  );
  return () => root.unmount();
}

// The Bifrost host imports this immutable entry once, then uses the registered
// factory to mount and unmount the app safely during in-shell navigation.
(window.__BIFROST_APP_MODULES__ ??= new Map()).set(import.meta.url, { mount });

// Vite serves this entry directly in development; deployed mounting belongs to
// the Bifrost host through the reusable factory above.
if (import.meta.env.DEV) {
  const mountEl = document.getElementById("root");
  if (!mountEl) throw new Error("Missing #root mount element");
  const previewTheme = new URLSearchParams(window.location.search).get("theme");
  mount(mountEl, {
    basename: "/",
    baseUrl: import.meta.env.VITE_BIFROST_API_URL ?? window.location.origin,
    token: import.meta.env.VITE_BIFROST_TOKEN ?? "",
    orgScope: import.meta.env.VITE_BIFROST_ORG_ID ?? null,
    appId: import.meta.env.VITE_BIFROST_APP_ID ?? null,
    onLogout: () => window.location.assign("/login"),
    theme: previewTheme === "dark" || (!previewTheme && document.documentElement.classList.contains("dark")) ? "dark" : "light",
  });
}
