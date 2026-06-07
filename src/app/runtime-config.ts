export interface AppRuntimeConfig {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

declare global {
  interface Window {
    APP_CONFIG?: AppRuntimeConfig;
  }
}

export function getRuntimeConfig(): AppRuntimeConfig {
  const cfg = window.APP_CONFIG;
  return {
    SUPABASE_URL: cfg?.SUPABASE_URL ?? '',
    SUPABASE_ANON_KEY: cfg?.SUPABASE_ANON_KEY ?? '',
  };
}

export function isConfigured(): boolean {
  const cfg = getRuntimeConfig();
  return cfg.SUPABASE_URL.length > 0 && cfg.SUPABASE_ANON_KEY.length > 0;
}
