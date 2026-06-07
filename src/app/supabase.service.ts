import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getRuntimeConfig, isConfigured } from './runtime-config';

@Injectable({ providedIn: 'root' })
export class SupabaseService {
  private client: SupabaseClient | null = null;

  get configured(): boolean {
    return isConfigured();
  }

  private getClient(): SupabaseClient {
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

  /** Reads all rows from the `stocks` table, newest first. */
  async listStocks(): Promise<StockRow[]> {
    const { data, error } = await this.getClient()
      .from('stocks')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      throw error;
    }
    return (data ?? []) as StockRow[];
  }

  /** Inserts a new row into the `stocks` table. */
  async addStock(ticker: string, mentions: number): Promise<void> {
    const { error } = await this.getClient()
      .from('stocks')
      .insert({ ticker, mentions });
    if (error) {
      throw error;
    }
  }
}

export interface StockRow {
  id: number;
  ticker: string;
  mentions: number;
  created_at: string;
}
