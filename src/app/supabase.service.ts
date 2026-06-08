import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getRuntimeConfig, isConfigured } from './runtime-config';

/**
 * Owns the SINGLE shared Supabase client for the whole app, plus the tiny
 * "is Supabase configured?" check `AppComponent` uses for its setup notice.
 *
 * Why centralized here rather than each service creating its own (as
 * `TradingService` originally did, back when the app had no auth and every
 * client was functionally identical/stateless): `@supabase/supabase-js`
 * clients each run their own GoTrue (auth) instance, and multiple instances
 * pointed at the same project share the same `localStorage` session-storage
 * key — which trips the library's own "Multiple GoTrueClient instances
 * detected" warning and risks session/refresh-token races between them. Now
 * that the app has a real login (see `AuthService` / `trading_schema_v8_auth_
 * gate.sql`), there is exactly ONE thing in the browser that may legitimately
 * hold a session, and exactly one client must own it. `AuthService` and
 * `TradingService` both obtain their client from here.
 */
@Injectable({ providedIn: 'root' })
export class SupabaseService {
  private client: SupabaseClient | null = null;

  get configured(): boolean {
    return isConfigured();
  }

  getClient(): SupabaseClient {
    if (!this.client) {
      const cfg = getRuntimeConfig();
      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
        throw new Error(
          'Supabase ist nicht konfiguriert. Setze SUPABASE_URL und SUPABASE_ANON_KEY.',
        );
      }
      this.client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    }
    return this.client;
  }
}
