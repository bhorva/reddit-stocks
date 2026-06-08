import { Injectable } from '@angular/core';
import { isConfigured } from './runtime-config';

/**
 * Tiny shared "is Supabase configured?" check, used by `AppComponent` to show
 * the setup notice. The actual data access for the trading dashboard lives in
 * `TradingService` — there is no other read-only feature left in the app that
 * needs its own Supabase client (the old manual "stocks" list/form was removed
 * since the watchlist is now fully dynamic and discovered server-side).
 */
@Injectable({ providedIn: 'root' })
export class SupabaseService {
  get configured(): boolean {
    return isConfigured();
  }
}
