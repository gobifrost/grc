interface BifrostAppBootstrap {
  basename: string;
  baseUrl: string;
  token: string;
  orgScope: string | null;
  appId: string | null;
  onLogout: () => void;
  theme: "light" | "dark";
}

interface BifrostAppModule {
  mount: (mountEl: HTMLElement, bootstrap: BifrostAppBootstrap) => () => void;
}

interface Window {
  __BIFROST_APP_MODULES__?: Map<string, BifrostAppModule>;
}
