declare module "bifrost" {
  import type { ComponentType, ReactNode } from "react";

  export interface BifrostContextValue {
    baseUrl: string;
    token: string;
    orgScope: string | null;
    appId: string | null;
    authedFetch: typeof fetch;
    logout: () => void;
    theme: "light" | "dark";
    setTheme: (theme: "light" | "dark") => void;
    toggleTheme: () => void;
    supportsTheme: boolean;
  }

  export interface BifrostProviderProps {
    baseUrl: string;
    token: string;
    orgScope?: string | null;
    appId?: string | null;
    fetchImpl?: typeof fetch;
    onLogout?: () => void;
    supportsTheme?: boolean;
    theme?: "light" | "dark";
    onThemeChange?: (theme: "light" | "dark") => void;
    children: ReactNode;
  }

  export const BifrostProvider: ComponentType<BifrostProviderProps>;
  export function useBifrostContext(): BifrostContextValue;

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

  export interface BifrostHeaderProps {
    title?: string;
    appName?: string;
    logo?: string | null;
    action?: ReactNode;
    className?: string;
  }
  export const BifrostHeader: ComponentType<BifrostHeaderProps>;

  export type FilterValue =
    | string
    | number
    | boolean
    | null
    | {
        eq?: unknown;
        neq?: unknown;
        ne?: unknown;
        contains?: string;
        starts_with?: string;
        ends_with?: string;
        gt?: unknown;
        gte?: unknown;
        lt?: unknown;
        lte?: unknown;
        in?: unknown[];
        is_null?: boolean;
        has_key?: boolean;
      };

  export type DocumentFilter = Record<string, FilterValue>;
  export interface UseTableQuery {
    where?: DocumentFilter;
    page?: number;
    pageSize?: number;
    order_by?: string;
    order_dir?: "asc" | "desc";
    scope?: string;
  }
  export interface UseTableResult<T> {
    rows: T[];
    total: number;
    totalPages: number;
    loading: boolean;
    error: Error | null;
  }
  export function useTable<T extends { id: string } = Record<string, unknown> & { id: string }>(
    name: string,
    query?: UseTableQuery,
  ): UseTableResult<T>;

  export interface DocumentPublic {
    id: string;
    table_id?: string;
    data?: Record<string, unknown>;
    created_by?: string | null;
    updated_by?: string | null;
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
  }

  export const tables: {
    get(table: string, id: string, scope?: string): Promise<DocumentPublic | null>;
    insert(
      table: string,
      data: Record<string, unknown>,
      scope?: string,
    ): Promise<DocumentPublic>;
    insert(
      table: string,
      data: Array<{ data: Record<string, unknown>; id?: string }>,
      scope?: string,
    ): Promise<DocumentPublic[]>;
    upsert(
      table: string,
      item: { id: string; data: Record<string, unknown> } | Array<{ id: string; data: Record<string, unknown> }>,
      scope?: string,
    ): Promise<DocumentPublic | DocumentPublic[]>;
    update(table: string, id: string, data: Record<string, unknown>, scope?: string): Promise<DocumentPublic | null>;
    delete(table: string, id: string | string[], scope?: string): Promise<boolean | number>;
    query(
      table: string,
      options?: UseTableQuery & { limit?: number; offset?: number },
      scope?: string,
    ): Promise<{ table_id: string; documents?: DocumentPublic[]; rows?: DocumentPublic[]; total?: number }>;
    subscribe(
      tableId: string,
      filter: Record<string, unknown> | null,
      onEvent: (event: { type: string; message?: string }) => void,
      onReconnect?: () => void,
    ): () => void;
  };

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
