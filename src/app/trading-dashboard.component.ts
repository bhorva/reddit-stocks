import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { Chart, registerables } from 'chart.js';
import {
  BalanceHistoryRow,
  PortfolioRow,
  PositionRow,
  SignalRow,
  TradingService,
  TransactionRow,
} from './trading.service';

Chart.register(...registerables);

@Component({
  selector: 'app-trading-dashboard',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (!trading.configured) {
      <div class="notice">
        <strong>Supabase ist noch nicht konfiguriert.</strong>
        <p>Die Trading-Simulation benötigt dieselbe Supabase-Verbindung wie oben beschrieben.</p>
      </div>
    } @else {
      <h2 class="section-title">📈 Pump-&amp;-Dip-Simulation</h2>

      <div class="tabs">
        <button type="button" class="tab" [class.active]="activeTab() === 'overview'" (click)="activeTab.set('overview')">
          Übersicht
        </button>
        <button type="button" class="tab" [class.active]="activeTab() === 'transactions'" (click)="activeTab.set('transactions')">
          Transaktionen
          @if (transactions().length > 0) {
            <span class="tab-count">{{ transactions().length }}</span>
          }
        </button>
      </div>

      @if (error()) {
        <div class="error">{{ error() }}</div>
      }

      <!--
        IMPORTANT: the grid (and therefore the chart canvas) must always be
        rendered, never gated behind loading(). ngOnInit sets loading to true
        synchronously, BEFORE ngAfterViewInit runs — so an
        '@if (loading()) {...} @else { canvas }' structure means the canvas
        doesn't exist in the DOM on first render, the ViewChild stays
        undefined, and renderChart() (called once data arrives, before
        loading flips back to false in the finally block) silently no-ops.
        The result: a permanently empty chart. Showing "Lade ..." as a small
        inline note alongside the (initially empty-state) grid avoids the
        remount entirely.
      -->
      @if (loading()) {
        <p class="muted loading-note">Lade …</p>
      }

      <!--
        Both tab panels stay mounted (toggled with [hidden], not @if) so the
        chart canvas is never removed/recreated when switching tabs — that
        would detach the existing Chart.js instance from the DOM and require
        re-creating it on every switch back.
      -->
      <div [hidden]="activeTab() !== 'overview'">
      <div class="grid-top">
          <div class="card">
            <h3>Portfoliowert</h3>
            <div class="stat-value">{{ totalValue() | number: '1.2-2' }} CHF</div>
            <div class="stat-sub">Cash: {{ portfolio()?.cash | number: '1.2-2' }} CHF</div>
          </div>
          <div class="card">
            <h3>Realisierte Gewinne</h3>
            <div class="stat-value" [class.pos]="(portfolio()?.realized_pnl ?? 0) >= 0" [class.neg]="(portfolio()?.realized_pnl ?? 0) < 0">
              {{ portfolio()?.realized_pnl | number: '1.2-2' }} CHF
            </div>
            <div class="stat-sub">
              {{ portfolio()?.trade_count ?? 0 }} Trades · {{ portfolio()?.total_fees | number: '1.2-2' }} CHF Gebühren
            </div>
          </div>
          <div class="card">
            <h3>Hype-Blocks</h3>
            <div class="stat-value neu">{{ portfolio()?.blocked_count ?? 0 }}</div>
            <div class="stat-sub">{{ portfolio()?.blocked_capital | number: '1.2-2' }} CHF nicht riskiert</div>
          </div>
        </div>

        <div class="grid-mid">
          <div class="card">
            <h3>Portfolioentwicklung (CHF)</h3>
            <div class="chart-wrap">
              <canvas #chartCanvas></canvas>
              @if (balanceHistory().length === 0) {
                <p class="muted chart-empty">Noch keine Auswertung gelaufen.</p>
              }
            </div>
          </div>
          <div class="card">
            <h3>Watchlist &amp; Signale</h3>
            @if (signals().length === 0) {
              <p class="muted">Noch keine Signale erfasst.</p>
            } @else {
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th><th>Preis</th><th>Erwähnungen</th><th>Hype</th><th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of signals(); track s.id) {
                    <tr [title]="s.reason">
                      <td class="ticker">{{ s.ticker }}</td>
                      <td>{{ s.price | number: '1.2-2' }}</td>
                      <td>{{ s.mention_count }}</td>
                      <td>
                        <div class="hype-bar-wrap">
                          <div class="hype-bar-bg">
                            <div
                              class="hype-bar-fill"
                              [style.width.%]="s.hype_score"
                              [style.background]="hypeColor(s.hype_score)"
                            ></div>
                          </div>
                          <span>{{ s.hype_score | number: '1.0-0' }}</span>
                        </div>
                      </td>
                      <td><span class="badge" [class]="verdictClass(s)">{{ verdictLabel(s) }}</span></td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
        </div>

        <div class="grid-bot grid-bot-single">
          <div class="card">
            <h3>Offene Positionen</h3>
            @if (positions().length === 0) {
              <p class="muted">Keine offenen Positionen.</p>
            } @else {
              @for (p of positions(); track p.id) {
                <div class="pos-row pos-row-rich">
                  <div class="pos-head">
                    <div class="pos-name">{{ p.ticker }}</div>
                    @if (positionView(p).changePct !== null) {
                      <span class="badge" [class.badge-organic]="positionView(p).changePct! >= 0" [class.badge-blocked]="positionView(p).changePct! < 0">
                        {{ positionView(p).changePct! >= 0 ? '+' : '' }}{{ positionView(p).changePct! * 100 | number: '1.1-1' }}%
                      </span>
                    }
                  </div>
                  <div class="pos-detail">
                    {{ p.shares | number: '1.4-4' }} Stk. &#64; Einstieg {{ p.entry_price | number: '1.2-2' }} CHF
                    @if (positionView(p).current !== null) {
                      · aktuell {{ positionView(p).current | number: '1.2-2' }} CHF
                    } @else {
                      · noch kein aktueller Kurs erfasst
                    }
                    · seit {{ p.opened_at | date: 'short' }}
                  </div>
                  <div class="pos-detail">
                    Positionswert {{ positionView(p).value | number: '1.2-2' }} CHF
                    @if (positionView(p).unrealized !== null) {
                      · unrealisiert
                      <span [class.pos]="positionView(p).unrealized! >= 0" [class.neg]="positionView(p).unrealized! < 0">{{ positionView(p).unrealized | number: '1.2-2' }} CHF</span>
                    }
                  </div>
                  @if (positionView(p).changePct !== null) {
                    <div class="exit-bar-wrap" title="Position zwischen Stop-Loss ({{ stopLoss * 100 }}%) und Take-Profit (+{{ takeProfit * 100 }}%)">
                      <div class="exit-bar-bg">
                        <div class="exit-bar-zero"></div>
                        <div
                          class="exit-bar-marker"
                          [style.left.%]="exitBarPosition(positionView(p).changePct!)"
                          [style.background]="positionView(p).changePct! >= 0 ? '#1a8a3c' : '#c0392b'"
                        ></div>
                      </div>
                      <div class="exit-bar-labels">
                        <span>Stop {{ stopLoss * 100 }}%</span>
                        <span>Take-Profit +{{ takeProfit * 100 }}%</span>
                      </div>
                    </div>
                  }
                </div>
              }
              <div class="pos-summary muted">
                Gesamtwert offener Positionen: {{ positionsValue() | number: '1.2-2' }} CHF
                ({{ positions().length }} / {{ maxPositions }} Slots belegt)
              </div>
            }
          </div>
        </div>
      </div>

      <div [hidden]="activeTab() !== 'transactions'" class="tx-wide">
        <div class="card">
          <h3>Transaktionshistorie</h3>
          @if (transactions().length === 0) {
            <p class="muted">Noch keine Transaktionen.</p>
          } @else {
            <div class="tx-summary muted">
              {{ transactions().length }} Transaktionen ·
              {{ buyCount() }} Käufe · {{ sellCount() }} Verkäufe ·
              Gesamtgebühren {{ totalFeesInLog() | number: '1.2-2' }} CHF
            </div>
            <div class="tx-table-wrap">
              <table class="tx-table">
                <colgroup>
                  <col class="col-date" />
                  <col class="col-action" />
                  <col class="col-ticker" />
                  <col class="col-shares" />
                  <col class="col-price" />
                  <col class="col-fee" />
                  <col class="col-gross" />
                  <col class="col-pnl" />
                  <col class="col-reason" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Aktion</th>
                    <th>Ticker</th>
                    <th>Menge</th>
                    <th>Kurs</th>
                    <th>Gebühr</th>
                    <th>Brutto</th>
                    <th>PnL</th>
                    <th>Begründung</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of transactions(); track t.id) {
                    <tr [class.tx-buy]="t.action === 'buy'" [class.tx-sell]="t.action === 'sell'">
                      <td class="nowrap">{{ t.created_at | date: 'dd.MM.yy HH:mm' }}</td>
                      <td>
                        <span class="badge" [class.badge-organic]="t.action === 'buy'" [class.badge-blocked]="t.action === 'sell'">
                          {{ t.action === 'buy' ? 'KAUF' : 'VERKAUF' }}
                        </span>
                      </td>
                      <td class="ticker">{{ t.ticker }}</td>
                      <td class="nowrap">{{ t.shares | number: '1.4-4' }}</td>
                      <td class="nowrap">{{ t.price | number: '1.2-2' }} CHF</td>
                      <td class="nowrap">{{ t.fee | number: '1.2-2' }} CHF</td>
                      <td class="nowrap">{{ t.gross_amount | number: '1.2-2' }} CHF</td>
                      <td class="nowrap">
                        @if (t.realized_pnl !== null) {
                          <span [class.pos]="t.realized_pnl >= 0" [class.neg]="t.realized_pnl < 0">{{ t.realized_pnl | number: '1.2-2' }} CHF</span>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td class="tx-reason">{{ t.reason }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      .section-title { margin-top: 2rem; margin-bottom: 0.25rem; }
      .grid-top { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .grid-mid { display: grid; grid-template-columns: 2fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .grid-bot { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .grid-bot-single { grid-template-columns: 1fr; }
      .tx-wide {
        width: 100vw;
        max-width: 1180px;
        margin-left: calc(50% - 50vw);
        margin-right: calc(50% - 50vw);
        padding: 0 1rem;
        box-sizing: border-box;
      }
      @media (max-width: 1180px) {
        .tx-wide { width: auto; max-width: none; margin-left: 0; margin-right: 0; padding: 0; }
      }
      @media (max-width: 900px) {
        .grid-top, .grid-mid, .grid-bot { grid-template-columns: 1fr; }
      }
      .card {
        background: #fafafa; border: 1px solid #e2e2e2;
        border-radius: 10px; padding: 1rem;
      }
      .card h3 {
        font-size: 0.75rem; text-transform: uppercase; letter-spacing: .08em;
        color: #888; margin-bottom: 0.5rem;
      }
      .stat-value { font-size: 1.4rem; font-weight: 700; }
      .stat-sub { font-size: 0.8rem; color: #888; margin-top: 2px; }
      .pos { color: #1a8a3c; }
      .neg { color: #c0392b; }
      .neu { color: #c98a00; }
      .muted { color: #888; font-size: 0.85rem; }
      .loading-note { margin: 0 0 0.75rem; }
      .chart-wrap { position: relative; height: 220px; }
      .chart-empty {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        margin: 0; pointer-events: none;
      }
      table { width: 100%; border-collapse: collapse; }
      th { text-align: left; font-size: 0.7rem; text-transform: uppercase; letter-spacing: .06em; color: #888; padding: 4px 6px; border-bottom: 1px solid #e2e2e2; }
      td { padding: 6px; border-bottom: 1px solid #eee; vertical-align: middle; }
      tr:last-child td { border-bottom: none; }
      .ticker { font-weight: 600; color: #ff4500; }
      .badge { display: inline-block; font-size: 0.68rem; padding: 2px 8px; border-radius: 20px; font-weight: 600; }
      .badge-organic { background: #e6f6ea; color: #1a8a3c; }
      .badge-spike { background: #fff3e0; color: #c98a00; }
      .badge-blocked { background: #fde8e8; color: #c0392b; }
      .hype-bar-wrap { display: flex; align-items: center; gap: 6px; }
      .hype-bar-bg { flex: 1; background: #eee; border-radius: 4px; height: 6px; min-width: 50px; }
      .hype-bar-fill { height: 6px; border-radius: 4px; }
      .pos-row { padding: 10px 0; border-bottom: 1px solid #eee; }
      .pos-row:last-child { border-bottom: none; }
      .pos-row-rich { display: flex; flex-direction: column; gap: 3px; }
      .pos-head { display: flex; align-items: center; gap: 8px; }
      .pos-name { font-weight: 600; }
      .pos-detail { font-size: 0.75rem; color: #888; margin-top: 2px; }
      .pos-summary { margin-top: 6px; font-size: 0.75rem; }
      .exit-bar-wrap { margin-top: 4px; }
      .exit-bar-bg { position: relative; background: #eee; border-radius: 4px; height: 6px; }
      .exit-bar-zero {
        position: absolute; top: -2px; bottom: -2px; left: calc(3.5 / 7.5 * 100%);
        width: 1px; background: #bbb;
      }
      .exit-bar-marker {
        position: absolute; top: -3px; width: 8px; height: 12px; border-radius: 3px;
        transform: translateX(-50%);
      }
      .exit-bar-labels { display: flex; justify-content: space-between; font-size: 0.65rem; color: #aaa; margin-top: 5px; }
      .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; border-bottom: 1px solid #e2e2e2; }
      .tab {
        background: none; border: none; cursor: pointer; padding: 0.5rem 0.9rem;
        font-size: 0.85rem; font-weight: 600; color: #888; border-bottom: 2px solid transparent;
        display: flex; align-items: center; gap: 6px; margin-bottom: -1px;
      }
      .tab.active { color: #ff4500; border-bottom-color: #ff4500; }
      .tab-count {
        background: #eee; color: #666; font-size: 0.68rem; font-weight: 700;
        border-radius: 20px; padding: 1px 7px;
      }
      .tab.active .tab-count { background: #ffe3d6; color: #ff4500; }
      .tx-summary { margin-bottom: 0.75rem; }
      .tx-table-wrap { max-height: 560px; overflow-y: auto; overflow-x: hidden; }
      .tx-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 0.78rem; }
      .tx-table col.col-date { width: 13%; }
      .tx-table col.col-action { width: 8%; }
      .tx-table col.col-ticker { width: 8%; }
      .tx-table col.col-shares { width: 9%; }
      .tx-table col.col-price,
      .tx-table col.col-fee,
      .tx-table col.col-gross,
      .tx-table col.col-pnl { width: 10%; }
      .tx-table col.col-reason { width: 22%; }
      .tx-table th {
        text-align: left; font-size: 0.68rem; text-transform: uppercase; letter-spacing: .05em;
        color: #888; padding: 6px 8px; border-bottom: 1px solid #e2e2e2; position: sticky; top: 0; background: #fafafa;
      }
      .tx-table td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
      .tx-table tr:last-child td { border-bottom: none; }
      .tx-table tr.tx-buy td:first-child { border-left: 3px solid #1a8a3c; }
      .tx-table tr.tx-sell td:first-child { border-left: 3px solid #c0392b; }
      .nowrap { word-break: break-word; }
      .tx-reason { color: #888; font-size: 0.74rem; word-break: break-word; }
      .notice { background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 1rem; }
      .error { background: #fdecea; border: 1px solid #f5c6cb; color: #a12622; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
    `,
  ],
})
export class TradingDashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  protected readonly trading = inject(TradingService);

  // Mirrors the constants in supabase/functions/market-scan/index.ts — shown
  // in the UI so it's clear at which thresholds a position would be closed.
  protected readonly activeTab = signal<'overview' | 'transactions'>('overview');

  protected readonly takeProfit = 0.04;
  protected readonly stopLoss = -0.035;
  protected readonly maxPositions = 5;

  @ViewChild('chartCanvas') private chartCanvas?: ElementRef<HTMLCanvasElement>;
  private chart: Chart | null = null;

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly portfolio = signal<PortfolioRow | null>(null);
  protected readonly positions = signal<PositionRow[]>([]);
  protected readonly transactions = signal<TransactionRow[]>([]);
  protected readonly balanceHistory = signal<BalanceHistoryRow[]>([]);
  protected readonly signals = signal<SignalRow[]>([]);

  protected readonly totalValue = signal(0);

  ngOnInit(): void {
    if (this.trading.configured) {
      void this.load();
    }
  }

  ngAfterViewInit(): void {
    // The canvas is now ALWAYS in the DOM (see template), so it's safe to
    // create the chart here even before any data has loaded — `renderChart`
    // simply renders an empty chart, and later calls update it in place.
    // (Previously the canvas only existed behind an `@if` gated on data being
    // present, which raced with `ViewChild` resolution — `queueMicrotask`
    // sometimes fired before Angular had inserted the canvas into the DOM,
    // so the chart silently never rendered.)
    this.renderChart();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [portfolio, positions, transactions, balanceHistory, signals] = await Promise.all([
        this.trading.getPortfolio(),
        this.trading.getPositions(),
        this.trading.getTransactionLog(),
        this.trading.getBalanceHistory(),
        this.trading.getWatchlistSignals(),
      ]);
      this.portfolio.set(portfolio);
      this.positions.set(positions);
      this.transactions.set(transactions);
      this.balanceHistory.set(balanceHistory);
      this.signals.set(signals);

      const latestSnapshot = balanceHistory[balanceHistory.length - 1];
      this.totalValue.set(latestSnapshot ? latestSnapshot.total_value : portfolio.cash);

      this.renderChart();
    } catch (e) {
      this.error.set(this.toMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Latest known price for a ticker, taken from its most recent signal row. */
  protected currentPrice(ticker: string): number | null {
    const signal = this.signals().find((s) => s.ticker === ticker);
    return signal ? signal.price : null;
  }

  /**
   * Bundles the derived, display-only numbers for one open position so the
   * template can read them without recomputing piecemeal (Angular 17 has no
   * `@let`, and recreating these per access would be wasteful/inconsistent).
   */
  protected positionView(p: PositionRow): {
    current: number | null;
    changePct: number | null;
    unrealized: number | null;
    value: number;
  } {
    const current = this.currentPrice(p.ticker);
    const changePct = current !== null ? (current - p.entry_price) / p.entry_price : null;
    const unrealized = current !== null ? (current - p.entry_price) * p.shares : null;
    const value = (current ?? p.entry_price) * p.shares;
    return { current, changePct, unrealized, value };
  }

  /** Sum of all open positions' mark-to-market value (using latest signal prices where available). */
  protected positionsValue(): number {
    return this.positions().reduce((sum, p) => sum + (this.currentPrice(p.ticker) ?? p.entry_price) * p.shares, 0);
  }

  protected buyCount(): number {
    return this.transactions().filter((t) => t.action === 'buy').length;
  }

  protected sellCount(): number {
    return this.transactions().filter((t) => t.action === 'sell').length;
  }

  protected totalFeesInLog(): number {
    return this.transactions().reduce((sum, t) => sum + t.fee, 0);
  }

  /**
   * Maps a position's current change-since-entry (e.g. -0.035 .. +0.04) onto a
   * 0-100% horizontal position for the exit-range bar, which spans a bit
   * wider than [stopLoss, takeProfit] so the marker doesn't sit at the very
   * edge even when a position is right at its trigger.
   */
  protected exitBarPosition(changePct: number): number {
    const span = this.takeProfit - this.stopLoss;
    const padded = span * 1.25;
    const center = (this.takeProfit + this.stopLoss) / 2;
    const min = center - padded / 2;
    const ratio = (changePct - min) / padded;
    return Math.max(2, Math.min(98, ratio * 100));
  }

  protected hypeColor(score: number): string {
    if (score > 65) return '#c0392b';
    if (score > 40) return '#c98a00';
    return '#1a8a3c';
  }

  protected verdictLabel(s: SignalRow): string {
    if (s.blocked) return 'Geblockt';
    if (s.verdict === 'spike') return 'Spike';
    return 'Organisch';
  }

  protected verdictClass(s: SignalRow): string {
    if (s.blocked) return 'badge badge-blocked';
    if (s.verdict === 'spike') return 'badge badge-spike';
    return 'badge badge-organic';
  }

  private renderChart(): void {
    const canvas = this.chartCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const history = this.balanceHistory();
    const labels = history.map((h) =>
      new Date(h.recorded_at).toLocaleString('de-CH', { month: 'short', day: 'numeric', hour: '2-digit' }),
    );
    const data = history.map((h) => h.total_value);

    if (this.chart) {
      // Update the existing chart in place rather than destroying/recreating
      // it — cheaper, avoids a flicker, and sidesteps any ViewChild timing
      // issues since the canvas (and thus the Chart instance) now persists
      // across data reloads.
      this.chart.data.labels = labels;
      this.chart.data.datasets[0].data = data;
      this.chart.update();
      return;
    }

    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Portfoliowert (CHF)',
            data,
            borderColor: '#4f8ef7',
            backgroundColor: 'rgba(79, 142, 247, 0.12)',
            fill: true,
            tension: 0.25,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: { ticks: { callback: (v) => `${v} CHF` } },
        },
      },
    });
  }

  private toMessage(e: unknown): string {
    if (e instanceof Error) {
      return e.message;
    }
    return String(e);
  }
}
