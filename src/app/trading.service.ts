import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getRuntimeConfig, isConfigured } from './runtime-config';

/**
 * Read-only access to the trading-simulation tables. Trading itself runs
 * server-side (the `market-scan` Edge Function, on a 6-hourly cron) using the
 * service-role key — the browser only ever reads via the public anon key, and
 * RLS on these tables grants no insert/update/delete to that role.
 */
@Injectable({ providedIn: 'root' })
export class TradingService {
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

  async getPortfolio(): Promise<PortfolioRow> {
    const { data, error } = await this.getClient()
      .from('portfolio')
      .select('*')
      .eq('id', true)
      .single();
    if (error) {
      throw error;
    }
    return data as PortfolioRow;
  }

  async getPositions(): Promise<PositionRow[]> {
    const { data, error } = await this.getClient()
      .from('positions')
      .select('*')
      .order('opened_at', { ascending: false });
    if (error) {
      throw error;
    }
    return (data ?? []) as PositionRow[];
  }

  async getTransactionLog(limit = 50): Promise<TransactionRow[]> {
    const { data, error } = await this.getClient()
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw error;
    }
    return (data ?? []) as TransactionRow[];
  }

  async getBalanceHistory(limit = 200): Promise<BalanceHistoryRow[]> {
    const { data, error } = await this.getClient()
      .from('balance_history')
      .select('*')
      .order('recorded_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw error;
    }
    return ((data ?? []) as BalanceHistoryRow[]).reverse();
  }

  /** Latest signal per watched ticker, newest scan first per ticker. */
  async getWatchlistSignals(): Promise<SignalRow[]> {
    const { data, error } = await this.getClient()
      .from('signals')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(200);
    if (error) {
      throw error;
    }
    const latestByTicker = new Map<string, SignalRow>();
    for (const row of (data ?? []) as SignalRow[]) {
      if (!latestByTicker.has(row.ticker)) {
        latestByTicker.set(row.ticker, row);
      }
    }
    return [...latestByTicker.values()];
  }
}

export interface PortfolioRow {
  cash: number;
  realized_pnl: number;
  total_fees: number;
  trade_count: number;
  blocked_count: number;
  blocked_capital: number;
  updated_at: string;
}

export interface PositionRow {
  id: number;
  ticker: string;
  shares: number;
  entry_price: number;
  opened_at: string;
}

export interface TransactionRow {
  id: number;
  ticker: string;
  action: 'buy' | 'sell';
  shares: number;
  price: number;
  fee: number;
  gross_amount: number;
  realized_pnl: number | null;
  reason: string;
  created_at: string;
}

export interface BalanceHistoryRow {
  id: number;
  recorded_at: string;
  cash: number;
  positions_value: number;
  total_value: number;
}

export interface SignalRow {
  id: number;
  ticker: string;
  scanned_at: string;
  price: number;
  mention_count: number;
  hype_score: number;
  verdict: 'organic' | 'spike' | 'pure-hype';
  blocked: boolean;
  reason: string;
}
