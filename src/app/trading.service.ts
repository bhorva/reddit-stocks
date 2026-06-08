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

  /**
   * Timestamp of the most recent full `market-scan` run — derived from the
   * newest `signals` row (only `market-scan` writes to that table;
   * `price-refresh` writes only `balance_history`/`transactions`). Lets the
   * dashboard show a "data freshness" indicator, so a silently-stuck cron job
   * is visible at a glance instead of just looking like a flat chart.
   */
  async getLastScanTime(): Promise<string | null> {
    const { data, error } = await this.getClient()
      .from('signals')
      .select('scanned_at')
      .order('scanned_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw error;
    }
    return (data as { scanned_at: string } | null)?.scanned_at ?? null;
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

  /**
   * Reads the `trade_outcomes_by_verdict` / `trade_outcomes_by_zscore_bucket`
   * views (see `trading_schema_v3_signal_performance_views.sql`) — they turn
   * the structured `signal_snapshot` data captured since the v2 migration into
   * "does our hype classification / z-score actually predict outcomes?".
   *
   * Both queries fail soft (return `[]`) rather than throwing: the views won't
   * exist until the v3 migration has been run, and even after that they'll be
   * empty until enough v2-era trades have closed — neither case should break
   * the rest of the dashboard, it should just render as "not enough data yet".
   */
  async getVerdictPerformance(): Promise<VerdictPerformanceRow[]> {
    const { data, error } = await this.getClient().from('trade_outcomes_by_verdict').select('*');
    if (error) {
      console.warn('trade_outcomes_by_verdict nicht verfügbar (Migration v3 ausgeführt?):', error.message);
      return [];
    }
    return (data ?? []) as VerdictPerformanceRow[];
  }

  async getZScoreBucketPerformance(): Promise<ZScoreBucketPerformanceRow[]> {
    const { data, error } = await this.getClient().from('trade_outcomes_by_zscore_bucket').select('*');
    if (error) {
      console.warn('trade_outcomes_by_zscore_bucket nicht verfügbar (Migration v3 ausgeführt?):', error.message);
      return [];
    }
    return (data ?? []) as ZScoreBucketPerformanceRow[];
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
  opening_transaction_id: number | null;
}

export interface SignalSnapshot {
  hype_score: number;
  z_score: number;
  mention_count: number;
  baseline_mentions: number;
  sentiment_ratio: number | null;
  price_trend_pct: number;
  drop_from_high_pct: number;
  verdict: string;
  intraday_points: number;
}

export interface TransactionRow {
  id: number;
  ticker: string;
  action: 'buy' | 'sell';
  shares: number;
  price: number;
  fee: number;
  fx_fee: number;
  currency: string;
  gross_amount: number;
  realized_pnl: number | null;
  reason: string;
  created_at: string;
  signal_snapshot: SignalSnapshot | null;
  opening_transaction_id: number | null;
  exit_reason: 'take-profit' | 'stop-loss' | 'interim-take-profit' | 'interim-stop-loss' | null;
}

export interface BalanceHistoryRow {
  id: number;
  recorded_at: string;
  cash: number;
  positions_value: number;
  total_value: number;
  spy_price: number | null;
}

/** Row of `trade_outcomes_by_verdict` — see trading_schema_v3_signal_performance_views.sql */
export interface VerdictPerformanceRow {
  verdict: string;
  closed_trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number | null;
  avg_realized_pnl: number | null;
  total_realized_pnl: number | null;
  avg_holding_hours: number | null;
  exits_take_profit: number;
  exits_stop_loss: number;
}

/** Row of `trade_outcomes_by_zscore_bucket` — see trading_schema_v3_signal_performance_views.sql */
export interface ZScoreBucketPerformanceRow {
  z_score_bucket: string;
  closed_trades: number;
  wins: number;
  win_rate_pct: number | null;
  avg_realized_pnl: number | null;
  avg_z_score_in_bucket: number | null;
  avg_price_trend_pct: number | null;
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
