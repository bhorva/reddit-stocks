import { Injectable, inject } from '@angular/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';

/**
 * Read-only access to the trading-simulation tables. Trading itself runs
 * server-side (the `market-scan` Edge Function, on a 6-hourly cron) using the
 * service-role key — the browser only ever reads via the public anon key.
 *
 * Since the v8 migration, RLS on these tables additionally requires an
 * AUTHENTICATED session to read at all (see `trading_schema_v8_auth_gate.sql`
 * / `AuthService`) — logged-out callers now simply get empty results instead
 * of data, the same "fail soft, render an empty state" shape the dashboard
 * already handles for "not configured" / "no rows yet".
 *
 * Shares the ONE app-wide Supabase client via `SupabaseService` rather than
 * creating its own — see that service's doc comment for why running two
 * independent GoTrue (auth) instances against the same project would be a
 * real problem now that there's an actual session to manage.
 */
@Injectable({ providedIn: 'root' })
export class TradingService {
  private readonly supabase = inject(SupabaseService);

  get configured(): boolean {
    return this.supabase.configured;
  }

  private getClient(): SupabaseClient {
    return this.supabase.getClient();
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

  /**
   * Raw `watchlist` rows — mainly needed for `is_etf` (see
   * `trading_schema_v7_etf_flag.sql`), which lives on `watchlist` rather than
   * `signals` because it's a per-ticker classification (Yahoo's own
   * `instrumentType`), not a per-scan measurement. The dashboard joins this
   * against `getWatchlistSignals()` by ticker to tell stocks and ETFs apart
   * without the engine having to duplicate the flag onto every signal row.
   */
  async getWatchlist(): Promise<WatchlistRow[]> {
    const { data, error } = await this.getClient().from('watchlist').select('*');
    if (error) {
      throw error;
    }
    return (data ?? []) as WatchlistRow[];
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
   * Signals where the heuristic wanted to open a new position — verdict
   * organic, dip threshold cleared, market open, no existing position in that
   * ticker — but `MAX_POSITIONS` was already full (`skipped_for_capacity`,
   * see `trading_schema_v6_missed_opportunities.sql`). The ONE "not bought"
   * case that represents a genuine "the system wanted to act but the risk cap
   * stopped it" situation, as opposed to "the heuristic itself said no" —
   * which is why this is a narrow, separate query rather than a generic
   * "everything that wasn't bought" dump (lumping those together would
   * conflate two completely different questions, see the migration's comment
   * for the full reasoning). Newest first, so the dashboard tab naturally
   * surfaces the most recent — and therefore most "trackable" — misses.
   */
  async getMissedOpportunities(limit = 100): Promise<SignalRow[]> {
    const { data, error } = await this.getClient()
      .from('signals')
      .select('*')
      .eq('skipped_for_capacity', true)
      .order('scanned_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw error;
    }
    return (data ?? []) as SignalRow[];
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

/**
 * Row of `watchlist` — the set of tickers the engine currently watches (or
 * once watched: `active = false` means it fell off the current "hot list" but
 * is kept around for history/held-position re-evaluation).
 */
export interface WatchlistRow {
  ticker: string;
  name: string | null;
  active: boolean;
  /**
   * `true`/`false` from Yahoo Finance's own `meta.instrumentType`
   * ("ETF" vs "EQUITY") — fetched as a side effect of the price-history call
   * the engine makes anyway (`fetchInstrumentInfo`, no extra request) and
   * opportunistically backfilled onto every row it touches. `null` means
   * "not yet (re-)evaluated since the v7 migration" — the honest "we don't
   * know yet" state, not a fabricated guess (see
   * trading_schema_v7_etf_flag.sql for the full reasoning, including why this
   * is now ALSO a hard buy-time gate — closing the gap that the hand-curated
   * `BROAD_MARKET_ETFS` discovery filter alone left open for non-broad-market
   * ETFs like leveraged/thematic ones).
   */
  is_etf: boolean | null;
  discovered_at: string;
}

export interface PositionRow {
  id: number;
  ticker: string;
  shares: number;
  entry_price: number;
  opened_at: string;
  opening_transaction_id: number | null;
  /** Highest price seen since open. Trailing stop fires at high_since_entry × 0.94.
   *  null only for legacy positions opened before v14 and not yet re-priced. */
  high_since_entry: number | null;
}

export interface SignalSnapshot {
  hype_score: number;
  z_score: number;
  mention_count: number;
  baseline_mentions: number;
  sentiment_ratio: number | null;
  price_trend_pct: number;
  /** Ticker's price-trend % minus the SPY benchmark's over the same window —
   *  positive means genuine stock-specific outperformance, not just riding a
   *  rising tide. New in the swing-trading classification (5-lens "organic"
   *  check); absent on signals captured before that change. */
  relative_strength_pct?: number;
  /** Ratio of the last ~5 trading days' average volume to the prior ~3-4
   *  weeks' average — "is the crowd actually trading this, or just talking
   *  about it?" `null` when Yahoo had too little history to compare. New in
   *  the swing-trading classification; absent on older signals. */
  volume_ratio?: number | null;
  drop_from_high_pct: number;
  verdict: string;
  intraday_points: number;
  /** CNN Fear & Greed score at buy time (v11). `null` for buys before v10. */
  fear_greed_score?: number | null;
  /** Whether the ticker was on YF Trending at buy time (v11). Absent on pre-v10 buys. */
  yf_trending?: boolean;
  /** Whether the ticker appeared in FinViz news headlines at buy time (v12). Absent on pre-v12 buys. */
  finviz_news?: boolean;
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
  /**
   * USD→CHF spot rate ("how many CHF does 1 USD buy") that applied when this
   * transaction was recorded — fetched live (Yahoo Finance `USDCHF=X`) by the
   * Edge Function and used to convert the USD-denominated trade value into
   * the CHF `gross_amount` that actually moved `cash`. `null` for legacy rows
   * that predate the v4 FX-rate migration (the simulation used to assume
   * 1 USD ≈ 1 CHF outright). Divide `gross_amount` by this to recover the
   * USD trade value (`shares * price`).
   */
  usd_chf_rate: number | null;
  realized_pnl: number | null;
  reason: string;
  created_at: string;
  signal_snapshot: SignalSnapshot | null;
  opening_transaction_id: number | null;
  exit_reason:
    | 'take-profit'
    | 'stop-loss'               // legacy: fixed stop-loss (pre-v14)
    | 'interim-take-profit'
    | 'interim-stop-loss'       // legacy: fixed interim stop (pre-v14)
    | 'trailing-stop'           // v14+: trailing stop via market-scan
    | 'interim-trailing-stop'   // v14+: trailing stop via price-refresh
    | null;
  /** Highest price the position reached during its hold (set on SELL rows only, v14+).
   *  Combined with the linked BUY's price, lets you measure how much the trailing
   *  stop protected vs. the old fixed stop. */
  high_since_entry: number | null;
}

export interface BalanceHistoryRow {
  id: number;
  recorded_at: string;
  cash: number;
  positions_value: number;
  total_value: number;
  spy_price: number | null;
  /**
   * USD→CHF spot rate used to convert this snapshot's USD-denominated
   * `positions_value` mark-to-market into CHF (see `TransactionRow.usd_chf_rate`
   * for the full reasoning). `null` for legacy rows that predate the v4
   * FX-rate migration.
   */
  usd_chf_rate: number | null;
  /**
   * CNN Fear & Greed Index score (0–100) at snapshot time. `null` for legacy
   * rows that predate the v10 migration. Score < 40 = Fear territory; buy-gate
   * was active for that run (no new positions opened).
   */
  fear_greed_score: number | null;
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
  /**
   * How far (in %, negative = below) the price had fallen from its recent
   * (~6-week) high at the moment this signal was recorded — e.g. `-4.2` means
   * "4.2% below its recent high". `null` for rows that predate the v6
   * "Verpasste Chancen" migration (it was computed inline and discarded
   * before then). See `TransactionRow.usd_chf_rate` for the analogous
   * "null = predates this column" convention.
   */
  drop_from_high_pct: number | null;
  /**
   * StockTwits bullish/(bullish+bearish) ratio at scan time (0..1) — the same
   * crowd-sentiment "Korrelations-Check" number `classify()` already folds
   * into the Verdict (one of five independent confirmation lenses; see
   * `market-scan/index.ts`). `null` means "fewer than 5 tagged messages were
   * available", the honest "not enough data for a meaningful read" state —
   * NOT "neutral 0%" or "no opinion either way", which would misrepresent
   * thin data as a measured result. Persisted on every signal row since the
   * v9 migration (`trading_schema_v9_sentiment_column.sql`); `null` also for
   * legacy rows that predate it, same convention as `drop_from_high_pct`.
   */
  sentiment_ratio: number | null;
  /**
   * True iff every condition for opening a new position here was met EXCEPT
   * the `MAX_POSITIONS` capacity check — i.e. market open, no existing
   * position in this ticker, verdict organic, dip threshold cleared. Mirrors
   * the real buy-check in `market-scan/index.ts` minus the capacity gate.
   * `false` (not `null`) for legacy rows — they simply predate this
   * bookkeeping, which is the accurate "we don't know" state here (a boolean
   * has no natural `null`-safe default that wouldn't misrepresent the row).
   */
  would_have_bought: boolean;
  /**
   * Narrows `would_have_bought` down to the one case worth reviewing: the
   * heuristic wanted to buy and a full portfolio (`MAX_POSITIONS`) was the
   * ONLY thing stopping it — a genuine "the system wanted to act but
   * couldn't" miss, as opposed to "the heuristic itself said no". This is
   * what `TradingService.getMissedOpportunities` filters on; see
   * `trading_schema_v6_missed_opportunities.sql` for the full reasoning on
   * why this distinction matters for any "would this have been profitable?"
   * analysis. `false` for legacy rows, same convention as `would_have_bought`.
   */
  skipped_for_capacity: boolean;
  /**
   * CNN Fear & Greed Index score (0–100) at scan time. `null` for legacy rows
   * that predate the v10 migration. Score < 40 at this moment means the
   * buy-gate was active — no new positions were opened in this scan run.
   */
  fear_greed_score: number | null;
  /**
   * True iff this ticker appeared on Yahoo Finance US Trending at scan time.
   * Informative only — no trade-logic effect. `false` for legacy rows
   * (pre-v10 migration), treated as "was not trending" rather than "unknown".
   */
  yf_trending: boolean;
  /**
   * True iff ALL buy conditions were met (organic verdict, dip threshold,
   * market open, no existing position, not an ETF) but the CNN Fear & Greed
   * gate (score < 40) was the sole reason no position was opened. Analogous
   * to `skipped_for_capacity` — keeps the two "why didn't we buy" reasons
   * orthogonal and independently queryable. `false` for legacy rows (pre-v10).
   */
  skipped_for_fear_greed: boolean;
  /**
   * True iff this ticker appeared in FinViz mainstream-news headlines at scan
   * time. Informative only — no trade-logic effect. `false` for legacy rows
   * (pre-v12). Stored for future analysis: do news-backed organic signals
   * outperform Reddit-only ones?
   */
  finviz_news: boolean;
}
