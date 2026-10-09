declare module "bifrost" {
  import type { ComponentType, ReactNode } from "react";

  export interface BifrostProviderProps {
    baseUrl: string;
    token: string;
    orgScope?: string | null;
    appId?: string | null;
    theme?: "light" | "dark";
    supportsTheme?: boolean;
    onLogout?: () => void;
    children: ReactNode;
  }

  export const BifrostProvider: ComponentType<BifrostProviderProps>;
  export function useBifrostContext(): { appId: string | null; baseUrl: string; authedFetch: typeof fetch };
  export interface BrandPaletteTheme {
    primary: string;
    primaryHover: string;
    primaryForeground: string;
    ring: string;
    activityGradient: string;
  }
  export interface BrandPalette { light: BrandPaletteTheme; dark: BrandPaletteTheme; isCustom: boolean }
  export interface UseBrandingResult {
    data: { application_name: string | null; primary_color: string | null; square_logo_url: string | null; rectangle_logo_url: string | null } | null;
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
    squareLogoUrl: string | null;
    rectangleLogoUrl: string | null;
    applicationName: string | null;
    primaryColor: string | null;
    palette: BrandPalette;
    colors: BrandPaletteTheme;
  }
  export function useBranding(options?: { applyTheme?: boolean }): UseBrandingResult;
  export const BifrostHeader: ComponentType<{ title?: string; className?: string }>;

  export interface UseWorkflowQueryState<T> {
    data: T | null;
    loading: boolean;
    error: Error | null;
    refresh: (input?: Record<string, unknown>) => Promise<T>;
  }

  export interface UseWorkflowMutationState<T> {
    mutate: (input?: Record<string, unknown>) => Promise<T>;
    data: T | null;
    loading: boolean;
    error: Error | null;
  }

  export function useWorkflowQuery<T = unknown>(
    workflowRef: string,
    params?: Record<string, unknown>,
  ): UseWorkflowQueryState<T>;
  export function useWorkflowMutation<T = unknown>(workflowRef: string): UseWorkflowMutationState<T>;
}
