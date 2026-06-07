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
      <p class="section-subtitle">
        Server-seitige Auswertung alle 6 Stunden · echte Reddit-Signale + Kursdaten ·
        Swissquote-Gebühren · Startkapital 10 000 CHF
      </p>

      @if (error()) {
        <div class="error">{{ error() }}</div>
      }

      @if (loading()) {
        <p>Lade …</p>
      } @else {
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
            @if (balanceHistory().length === 0) {
              <p class="muted">Noch keine Auswertung gelaufen.</p>
            } @else {
              <div class="chart-wrap"><canvas #chartCanvas></canvas></div>
            }
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

        <div class="grid-bot">
          <div class="card">
            <h3>Offene Positionen</h3>
            @if (positions().length === 0) {
              <p class="muted">Keine offenen Positionen.</p>
            } @else {
              @for (p of positions(); track p.id) {
                <div class="pos-row">
                  <div>
                    <div class="pos-name">{{ p.ticker }}</div>
                    <div class="pos-detail">
                      {{ p.shares | number: '1.4-4' }} Stk. &#64; {{ p.entry_price | number: '1.2-2' }} CHF ·
                      seit {{ p.opened_at | date: 'short' }}
                    </div>
                  </div>
                </div>
              }
            }
          </div>
          <div class="card">
            <h3>Transaktionslog</h3>
            @if (transactions().length === 0) {
              <p class="muted">Noch keine Transaktionen.</p>
            } @else {
              <div class="log">
                @for (t of transactions(); track t.id) {
                  <div class="log-entry" [class.log-buy]="t.action === 'buy'" [class.log-sell]="t.action === 'sell'">
                    <strong [class.pos]="t.action === 'buy'" [class.neg]="t.action === 'sell'">
                      {{ t.action === 'buy' ? 'KAUF' : 'VERKAUF' }} {{ t.ticker }}
                    </strong>
                    — {{ t.shares | number: '1.4-4' }} Stk. &#64; {{ t.price | number: '1.2-2' }} CHF
                    (Gebühr {{ t.fee | number: '1.2-2' }} CHF
                    @if (t.realized_pnl !== null) {
                      · PnL <span [class.pos]="t.realized_pnl >= 0" [class.neg]="t.realized_pnl < 0">{{ t.realized_pnl | number: '1.2-2' }} CHF</span>
                    })
                    <div class="log-meta">{{ t.reason }}</div>
                    <div class="log-meta">{{ t.created_at | date: 'short' }}</div>
                  </div>
                }
              </div>
            }
          </div>
        </div>
      }
    }
  `,
  styles: [
    `
      .section-title { margin-top: 2rem; margin-bottom: 0.25rem; }
      .section-subtitle { color: #666; margin-bottom: 1rem; font-size: 0.85rem; }
      .grid-top { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .grid-mid { display: grid; grid-template-columns: 2fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .grid-bot { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
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
      .chart-wrap { position: relative; height: 220px; }
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
      .pos-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; }
      .pos-row:last-child { border-bottom: none; }
      .pos-name { font-weight: 600; }
      .pos-detail { font-size: 0.75rem; color: #888; margin-top: 2px; }
      .log { max-height: 340px; overflow-y: auto; font-size: 0.8rem; }
      .log-entry { padding: 8px 10px; margin-bottom: 6px; border-radius: 6px; border-left: 3px solid #ddd; background: #fafafa; line-height: 1.5; }
      .log-buy { border-color: #1a8a3c; }
      .log-sell { border-color: #c0392b; }
      .log-meta { color: #888; font-size: 0.7rem; }
      .notice { background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 1rem; }
      .error { background: #fdecea; border: 1px solid #f5c6cb; color: #a12622; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
    `,
  ],
})
export class TradingDashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  protected readonly trading = inject(TradingService);

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

      queueMicrotask(() => this.renderChart());
    } catch (e) {
      this.error.set(this.toMessage(e));
    } finally {
      this.loading.set(false);
    }
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
    const history = this.balanceHistory();
    if (!canvas || history.length === 0) {
      return;
    }
    this.chart?.destroy();
    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: history.map((h) => new Date(h.recorded_at).toLocaleString('de-CH', { month: 'short', day: 'numeric', hour: '2-digit' })),
        datasets: [
          {
            label: 'Portfoliowert (CHF)',
            data: history.map((h) => h.total_value),
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
