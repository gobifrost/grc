import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local development reads only process selectors, this app's API URL selector,
// or the CLI credential store. Deployed apps receive their per-viewer bootstrap
// from the Bifrost host. Build never invokes this helper.
function readBifrostEnv() {
  const out = {
    url: process.env.BIFROST_API_URL || "",
    token: process.env.BIFROST_ACCESS_TOKEN || "",
  };
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*BIFROST_API_URL\s*=\s*(.*)\s*$/);
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, "");
        if (!out.url) out.url = v;
      }
    }
  }
  if (!out.token) {
    try {
      const args = ["auth", "token"];
      if (out.url) args.push("--url", out.url);
      const raw = execFileSync("bifrost", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const credentials = JSON.parse(raw) as { access_token?: string; api_url?: string };
      if (credentials.access_token) out.token = credentials.access_token;
      if (credentials.api_url && !out.url) out.url = credentials.api_url;
    } catch {
      // A tokenless preview renders its normal unauthenticated state.
    }
  }
  return out;
}

export default defineConfig(({ command }) => {
  // SECURITY: the dev token is injected ONLY for `vite` (serve / `npm run dev`),
  // never for `vite build`. Baking BIFROST_ACCESS_TOKEN into the production
  // bundle via `define` would ship a usable credential to every app user
  // (Codex R6-P1-c). In a deployed build the token comes from
  // window.__BIFROST_APP__ at runtime (per viewer); the bundle stays tokenless.
  const define = command === "serve"
    ? (() => {
        const env = readBifrostEnv();
        return {
          "import.meta.env.VITE_BIFROST_API_URL": JSON.stringify(env.url),
          "import.meta.env.VITE_BIFROST_TOKEN": JSON.stringify(env.token),
          "import.meta.env.VITE_BIFROST_APP_ID": JSON.stringify(process.env.VITE_BIFROST_APP_ID || ""),
          "import.meta.env.VITE_BIFROST_ORG_ID": JSON.stringify(process.env.VITE_BIFROST_ORG_ID || null),
        };
      })()
    : {};
  return {
    plugins: [react(), tailwindcss()],
    define,
    // Bifrost's standalone app host mounts one entry stylesheet. Keep all
    // Tailwind, application, and design-system CSS in that single asset so a
    // deployed app cannot lose its layout while retaining only its tokens.
    build: { cssCodeSplit: false },
    // `@/` → src, so shadcn component source (which imports `@/lib/utils` and
    // `@/components/ui/*`) resolves the same as in the shadcn docs.
    resolve: { alias: { "@": join(process.cwd(), "src") } },
  };
});
