import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
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
  VerdictPerformanceRow,
  ZScoreBucketPerformanceRow,
} from './trading.service';

Chart.register(...registerables);

type SignalSortColumn = 'ticker' | 'price' | 'mention_count' | 'hype_score' | 'verdict';
type SortDirection = 'asc' | 'desc';

/** Per-point metadata for the buy/sell-marker overlay dataset on the main chart — see `renderChart`. */
interface TradeMarkerMeta {
  ticker: string;
  action: 'buy' | 'sell';
  realizedPnl: number | null;
  reason: string;
}

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
      <h2 class="section-title">🚀 Reddit-Stonks-Simulation 💎🙌📈</h2>

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
        <span
          class="scan-freshness muted"
          [class.scan-stale]="scanIsStale()"
          [title]="'Der grosse Markt-Scan (Auswertung neuer Trends, Käufe) läuft alle ~6 Stunden automatisch im Hintergrund. Diese Anzeige zeigt, wann er zuletzt lief — wirkt sie deutlich älter, könnte der automatische Job hängengeblieben sein. (Eine separate, schlankere Funktion prüft offene Positionen alle 30 Minuten unabhängig davon.)'"
        >
          @if (lastScanAt(); as t) {
            Letzter Scan: {{ t | date: 'dd.MM. HH:mm' }} ({{ scanAgeLabel() }})
            @if (scanIsStale()) { · evtl. hängengeblieben? }
          } @else {
            Noch kein Scan gelaufen.
          }
        </span>
      </div>

      <p class="muted fx-note">
        Hinweis: Aktienkurse stammen von US-Börsen (USD). Die Simulation rechnet
        1 USD ≈ 1 CHF (kein Wechselkursmodell), bildet aber die reale
        Devisen-Umtauschmarge von Swissquote (≈0,95&nbsp;% pro Transaktion) als
        zusätzliche Gebühr ab — Portfoliowert &amp; Gebühren sind in CHF, Aktienpreise in USD.
      </p>

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
            <h3>Hype-Blocks <span class="info-icon" tabindex="0" title="Anzahl Aktien, bei denen die Engine einen Erwähnungs-Anstieg als reinen, unbegründeten Hype eingestuft und deshalb BEWUSST NICHT gehandelt hat ('Pure-Hype'-Verdict). Das verhinderte Kapital, das damit nicht riskiert wurde, steht darunter — eine Wette, die nicht eingegangen wurde, ist hier ein Erfolg, kein verpasster Gewinn (zumindest, wenn die Klassifikation stimmt — siehe 'Lern-Insights' weiter unten).">ⓘ</span></h3>
            <div class="stat-value neu">{{ portfolio()?.blocked_count ?? 0 }}</div>
            <div class="stat-sub">{{ portfolio()?.blocked_capital | number: '1.2-2' }} CHF nicht riskiert</div>
          </div>
        </div>

        <!--
          Performance metrics derived from closed trades — these are what
          actually answer "is the strategy any good", which raw P&L alone
          doesn't: a high win rate with tiny wins and rare huge losses (or
          vice versa) looks identical in the headline number above.
        -->
        <div class="grid-top grid-top-metrics">
          <div class="card">
            <h3>Trefferquote <span class="info-icon" tabindex="0" title="Anteil der bereits abgeschlossenen (verkauften) Trades, die mit Gewinn endeten. Sagt für sich allein noch nichts über die Höhe von Gewinnen/Verlusten aus — siehe daneben.">ⓘ</span></h3>
            @if (winRate(); as wr) {
              <div class="stat-value" [class.pos]="wr >= 50" [class.neg]="wr < 50">{{ wr | number: '1.0-0' }}%</div>
              <div class="stat-sub">{{ winCount() }} Gewinner · {{ lossCount() }} Verlierer von {{ closedTrades().length }} geschlossenen Trades</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch keine geschlossenen Trades.</div>
            }
          </div>
          <div class="card">
            <h3>Ø Gewinn / Ø Verlust <span class="info-icon" tabindex="0" title="Wie viel im Schnitt bei einem gewonnenen bzw. verlorenen Trade heraus­kommt. Wichtig im Zusammenspiel mit der Trefferquote: Eine hohe Trefferquote mit vielen kleinen Gewinnen und seltenen, riesigen Verlusten kann unterm Strich trotzdem ein Verlustgeschäft sein (und umgekehrt).">ⓘ</span></h3>
            @if (avgWin() !== null || avgLoss() !== null) {
              <div class="stat-value">
                <span class="pos">{{ avgWin() !== null ? '+' + (avgWin() | number: '1.2-2') : '–' }}</span>
                <span class="muted"> / </span>
                <span class="neg">{{ avgLoss() !== null ? (avgLoss() | number: '1.2-2') : '–' }}</span>
                <span class="stat-sub-inline"> CHF</span>
              </div>
              <div class="stat-sub">pro geschlossenem Trade (realisierter PnL)</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch keine geschlossenen Trades.</div>
            }
          </div>
          <div class="card">
            <h3>Max. Drawdown <span class="info-icon" tabindex="0" title="Der grösste Rückgang vom bisherigen Höchststand des Portfoliowerts bis zum darauffolgenden Tiefpunkt — zeigt, wie schmerzhaft die schlimmste bisherige Durststrecke war, selbst wenn die Gesamtbilanz am Ende positiv ausfällt. Ein Standard-Risikomass aus der Finanzwelt.">ⓘ</span></h3>
            @if (maxDrawdownPct(); as dd) {
              <div class="stat-value neg">−{{ dd | number: '1.1-1' }}%</div>
              <div class="stat-sub">grösster Rückgang vom bisherigen Höchststand des Portfoliowerts</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch zu wenige Datenpunkte.</div>
            }
          </div>
          <div class="card">
            <h3>Volatilität <span class="info-icon" tabindex="0" title="Standardabweichung der Schwankungen des Portfoliowerts zwischen aufeinanderfolgenden Snapshots — ein Standard-Risikomass: hohe Werte bedeuten ein 'ruppigeres' Auf und Ab auf dem Weg zum Endergebnis, niedrige Werte einen ruhigeren Verlauf. Ergänzt den Max. Drawdown (der zeigt nur den schlimmsten EINZELNEN Einbruch, nicht wie unruhig der gesamte Verlauf war).">ⓘ</span></h3>
            @if (volatilityPct(); as vol) {
              <div class="stat-value">±{{ vol | number: '1.1-1' }}%</div>
              <div class="stat-sub">Standardabweichung der Wertänderungen zwischen Snapshots</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch zu wenige Datenpunkte.</div>
            }
          </div>
          <div class="card">
            <h3>Ø Haltedauer <span class="info-icon" tabindex="0" title="Wie lange eine Position im Schnitt gehalten wird, bevor sie verkauft wird — egal ob durch Take-Profit, Stop-Loss oder einen Zwischen-Check. Kurze Haltedauern bei volatilen Aktien können auf 'Lärm' statt echte Trends hindeuten.">ⓘ</span></h3>
            @if (avgHoldingHours(); as h) {
              <div class="stat-value">{{ formatHoldingDuration(h) }}</div>
              <div class="stat-sub">über alle verknüpften Buy→Sell-Paare hinweg</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Erfordert verknüpfte Trades (ab dieser Version geloggt).</div>
            }
          </div>
        </div>

        <div class="grid-mid">
          <div class="card">
            <h3>
              Portfolioentwicklung vs. SPY
              <span class="info-icon" tabindex="0" title="Die blaue Linie ist der Wert unseres simulierten Portfolios über die Zeit, die gestrichelte graue Linie das gleiche Startkapital einfach im Aktienindex-Fonds SPY (S&P 500) angelegt — beide auf denselben Startwert normiert, damit der Vergleich fair ist. Die rötliche Fläche zeigt den 'Drawdown' (Abstand vom bisherigen Höchststand); Dreiecke markieren Käufe (▲) und Verkäufe (▼), grün/rot je nach Ergebnis. Liegt die blaue Linie unter der grauen, hätte ein simpler Indexfonds besser abgeschnitten als die aktive Strategie.">ⓘ</span>
              <button type="button" class="chart-mode-toggle" (click)="toggleChartMode()" title="Zwischen absoluten CHF-Beträgen und prozentualer Veränderung seit Start umschalten — letzteres macht 'schlägt die Strategie den Index?' direkt ablesbar, ohne im Kopf umzurechnen.">
                {{ chartMode() === 'value' ? 'In % seit Start anzeigen' : 'In CHF anzeigen' }}
              </button>
            </h3>
            <div class="chart-wrap">
              <canvas #chartCanvas></canvas>
              @if (balanceHistory().length === 0) {
                <p class="muted chart-empty">Noch keine Auswertung gelaufen.</p>
              }
            </div>
            @if (!hasBenchmarkData()) {
              <p class="muted chart-note">
                Vergleichslinie (gestrichelt) erscheint, sobald die nächsten Scan-Läufe
                den SPY-Referenzkurs mitschreiben (Migration v2 erforderlich) — sie zeigt,
                was dasselbe Startkapital bei einer simplen Index-Anlage wert wäre.
              </p>
            }
          </div>
          <div class="card">
            <h3>Watchlist &amp; Signale</h3>
            @if (signals().length === 0) {
              <p class="muted">Noch keine Signale erfasst.</p>
            } @else {
              <input
                type="text"
                class="table-filter"
                placeholder="Nach Ticker filtern…"
                [value]="signalFilter()"
                (input)="signalFilter.set($any($event.target).value)"
              />
              @if (sortedSignals().length === 0) {
                <p class="muted">Kein Ticker passt zum Filter „{{ signalFilter() }}“.</p>
              } @else {
              <table>
                <thead>
                  <tr>
                    <th class="sortable" [class.sorted]="signalSortColumn() === 'ticker'" (click)="toggleSignalSort('ticker')">
                      Ticker <span class="sort-indicator">{{ signalSortIndicator('ticker') }}</span>
                    </th>
                    <th class="sortable" [class.sorted]="signalSortColumn() === 'price'" (click)="toggleSignalSort('price')">
                      Preis (USD) <span class="sort-indicator">{{ signalSortIndicator('price') }}</span>
                    </th>
                    <th class="sortable" [class.sorted]="signalSortColumn() === 'mention_count'" (click)="toggleSignalSort('mention_count')">
                      Erwähnungen <span class="sort-indicator">{{ signalSortIndicator('mention_count') }}</span>
                    </th>
                    <th class="sortable" [class.sorted]="signalSortColumn() === 'hype_score'" (click)="toggleSignalSort('hype_score')">
                      Hype <span class="sort-indicator">{{ signalSortIndicator('hype_score') }}</span>
                      <span class="info-icon" tabindex="0" title="Misst, wie ungewöhnlich oft eine Aktie GERADE JETZT in Reddit/StockTwits erwähnt wird, verglichen mit ihrem üblichen Niveau (statistischer Z-Score, auf 0–100 skaliert). Hoch = aktuell viel Gerede — sagt für sich allein noch nichts darüber aus, ob das Gerede berechtigt ist (das entscheidet erst das 'Verdict'). Standard-Sortierung dieser Tabelle: absteigend nach Hype, weil das den 'lautesten' Tickern zuerst Aufmerksamkeit gibt.">ⓘ</span>
                    </th>
                    <th class="sortable" [class.sorted]="signalSortColumn() === 'verdict'" (click)="toggleSignalSort('verdict')">
                      Verdict <span class="sort-indicator">{{ signalSortIndicator('verdict') }}</span>
                      <span class="info-icon" tabindex="0" title="Versucht zu unterscheiden, ob ein Erwähnungs-Anstieg von echter Kursbewegung & Stimmung begleitet wird ('Organisch' = handelbar) oder nur heisse Luft ist ('Spike' = verdächtig, wird beobachtet aber nicht gehandelt; 'Geblockt' = als reiner Hype eingestuft, kein Trade). Sortierung ordnet nach Handelbarkeit: Organisch → Spike → Geblockt.">ⓘ</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of sortedSignals(); track s.id) {
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
            }
          </div>
        </div>

        <div class="grid-mid grid-mid-reverse">
          <div class="card">
            <h3>
              Kapitalverteilung auf offene Positionen
              <span class="info-icon" tabindex="0" title="Zeigt, wie das aktuell INVESTIERTE Kapital (nicht das gesamte Portfolio inkl. Cash) auf die offenen Positionen verteilt ist — eine grosse Schieflage hier bedeutet 'Klumpenrisiko': fällt genau dieser eine Titel, trifft es das Depot überproportional hart.">ⓘ</span>
            </h3>
            @if (positions().length === 0) {
              <p class="muted">Keine offenen Positionen — nichts zu konzentrieren.</p>
            } @else {
              @for (p of positions(); track p.id) {
                <div class="alloc-row">
                  <div class="alloc-row-head">
                    <span class="ticker">{{ p.ticker }}</span>
                    <span class="muted">{{ positionSizeShare(p) | number: '1.0-1' }}% des investierten Kapitals</span>
                  </div>
                  <div class="alloc-bar-bg">
                    <div class="alloc-bar-fill" [style.width.%]="positionSizeShare(p)"></div>
                  </div>
                </div>
              }
              <p class="muted alloc-hint">
                Bei {{ maxPositions }} Slots wäre eine perfekt gleichmässige Verteilung
                {{ 100 / maxPositions | number: '1.0-0' }}% pro Position — deutliche
                Ausreisser nach oben sind ein Hinweis auf Konzentrationsrisiko, keine
                automatische Fehleinschätzung (eine Position kann auch einfach am
                stärksten gelaufen sein).
              </p>
            }
          </div>
          <div class="card">
            <h3>
              Cash vs. investiert über Zeit
              <span class="info-icon" tabindex="0" title="Wie viel des Portfolios ist gerade als Cash 'in Wartestellung', wie viel steckt in offenen Positionen? Ein durchgehend hoher Cash-Anteil kann heissen, dass die Heuristik selten ein 'organic'-Signal findet — was bei der jetzt strengeren 5-Signale-Klassifikation durchaus erwartbar ist (siehe Lern-Insights).">ⓘ</span>
            </h3>
            <div class="chart-wrap chart-wrap-small">
              <canvas #allocationCanvas></canvas>
              @if (balanceHistory().length === 0) {
                <p class="muted chart-empty">Noch keine Auswertung gelaufen.</p>
              }
            </div>
          </div>
        </div>

        <div class="grid-bot">
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
                    {{ p.shares | number: '1.4-4' }} Stk. &#64; Einstieg {{ p.entry_price | number: '1.2-2' }} USD
                    @if (positionView(p).current !== null) {
                      · aktuell {{ positionView(p).current | number: '1.2-2' }} USD
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
          <div class="card">
            <h3>
              Ticker-Leaderboard
              <span class="info-icon" tabindex="0" title="Aggregiert alle ABGESCHLOSSENEN Trades pro Ticker — 'welche Aktien haben unterm Strich Geld gebracht oder gekostet, nicht nur bei ihrem besten/schlechtesten Einzeltrade?'. Sortiert nach Gesamtbeitrag zum realisierten Ergebnis: die grössten Gewinner oben, die grössten Bremsen unten.">ⓘ</span>
            </h3>
            @if (tickerLeaderboard().length === 0) {
              <p class="muted">Noch keine abgeschlossenen Trades — die Rangliste füllt sich automatisch, sobald die ersten Positionen verkauft wurden.</p>
            } @else {
              <table class="leaderboard-table">
                <thead>
                  <tr><th>Ticker</th><th>Trades</th><th>Trefferquote</th><th>Gesamt-PnL (CHF)</th></tr>
                </thead>
                <tbody>
                  @for (row of tickerLeaderboard(); track row.ticker) {
                    <tr>
                      <td class="ticker">{{ row.ticker }}</td>
                      <td>{{ row.trades }}</td>
                      <td class="muted">{{ row.wins }}/{{ row.trades }} ({{ (row.wins / row.trades) * 100 | number: '1.0-0' }}%)</td>
                      <td>
                        <span [class.pos]="row.totalPnl >= 0" [class.neg]="row.totalPnl < 0">
                          {{ row.totalPnl >= 0 ? '+' : '' }}{{ row.totalPnl | number: '1.2-2' }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
        </div>

        <!--
          "Lern-Insights": surfaces the trade_outcomes_by_verdict /
          trade_outcomes_by_zscore_bucket SQL views (see
          trading_schema_v3_signal_performance_views.sql) — they turn the
          structured signal_snapshot data captured since the v2 migration into
          the question that actually matters for improving the strategy: "does
          our hype classification / z-score heuristic predict outcomes, or
          are the thresholds just guesswork?". Intentionally rendered as an
          (initially empty) card now — it'll start filling in on its own as
          more v2-era trades close, with no further changes needed.
        -->
        <div class="grid-bot grid-bot-single">
          <div class="card">
            <h3>
              Lern-Insights: Treffen unsere Heuristiken zu?
              <span
                class="info-icon"
                tabindex="0"
                title="Diese Tabellen vergleichen, was die Engine beim Kauf über eine Aktie 'dachte' (Verdict, Hype-/Z-Score) mit dem tatsächlichen Ergebnis des Trades. So lässt sich nachvollziehen, ob die Klassifikations-Schwellenwerte sinnvoll sind oder angepasst werden sollten — datenbasiert statt aus dem Bauch heraus."
              >ⓘ</span>
            </h3>
            @if (verdictPerformance().length === 0 && zScorePerformance().length === 0) {
              <p class="muted">
                Noch nicht genug abgeschlossene, verknüpfte Trades für eine aussagekräftige
                Auswertung (Faustregel: mindestens 20–30 pro Gruppe). Diese Karte füllt sich
                automatisch, sobald künftige Käufe verkauft wurden — vorausgesetzt, die
                Migration <code>trading_schema_v3_signal_performance_views.sql</code> wurde
                bereits ausgeführt. Bis dahin: nichts zu tun, einfach laufen lassen.
              </p>
            } @else {
              @if (verdictPerformance().length > 0) {
                <div class="insights-block">
                  <h4>
                    Nach Verdict (Organisch / Spike / Pure-Hype)
                    <span class="info-icon" tabindex="0" title="Die Engine stuft jede Aktie beim Scan als 'organisch' (handelbar), 'spike' (verdächtig, wird nur beobachtet) oder 'pure-hype' (blockiert) ein. Hier siehst du, ob diese Einschätzung beim jeweiligen Trade auch tatsächlich gestimmt hat.">ⓘ</span>
                  </h4>
                  <table class="insights-table">
                    <thead>
                      <tr>
                        <th>Verdict</th><th>Trades</th><th>Trefferquote</th>
                        <th>Ø PnL (CHF)</th><th>Ø Haltedauer</th><th>Take-Profit / Stop-Loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (v of verdictPerformance(); track v.verdict) {
                        <tr>
                          <td><span class="badge" [class]="verdictClassFor(v.verdict)">{{ verdictLabelFor(v.verdict) }}</span></td>
                          <td>{{ v.closed_trades }}</td>
                          <td>
                            @if (v.win_rate_pct !== null) {
                              <span [class.pos]="v.win_rate_pct >= 50" [class.neg]="v.win_rate_pct < 50">{{ v.win_rate_pct | number: '1.0-0' }}%</span>
                              <span class="muted"> ({{ v.wins }}/{{ v.losses }})</span>
                            } @else { <span class="muted">—</span> }
                          </td>
                          <td>
                            @if (v.avg_realized_pnl !== null) {
                              <span [class.pos]="v.avg_realized_pnl >= 0" [class.neg]="v.avg_realized_pnl < 0">{{ v.avg_realized_pnl | number: '1.2-2' }}</span>
                            } @else { <span class="muted">—</span> }
                          </td>
                          <td>{{ v.avg_holding_hours !== null ? formatHoldingDuration(v.avg_holding_hours) : '—' }}</td>
                          <td class="muted">{{ v.exits_take_profit }} / {{ v.exits_stop_loss }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
              @if (zScorePerformance().length > 0) {
                <div class="insights-block">
                  <h4>
                    Nach Stärke des Erwähnungs-Spikes (Z-Score)
                    <span class="info-icon" tabindex="0" title="Der Z-Score misst, wie ungewöhnlich die Erwähnungszahl einer Aktie gerade verglichen mit ihrem üblichen Niveau ist (z.B. z=3 bedeutet 'dreimal so weit vom Durchschnitt entfernt wie normal'). Hier zeigt sich, ob besonders starke Spikes eher gute oder eher schlechte Trades waren — also ob 'viral' eher früh-Signal oder später Hype-Gipfel ist.">ⓘ</span>
                  </h4>
                  <table class="insights-table">
                    <thead>
                      <tr>
                        <th>Z-Score-Bereich</th><th>Trades</th><th>Trefferquote</th>
                        <th>Ø PnL (CHF)</th><th>Ø Kurstrend vorher</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (z of zScorePerformance(); track z.z_score_bucket) {
                        <tr>
                          <td>{{ z.z_score_bucket }}</td>
                          <td>{{ z.closed_trades }}</td>
                          <td>
                            @if (z.win_rate_pct !== null) {
                              <span [class.pos]="z.win_rate_pct >= 50" [class.neg]="z.win_rate_pct < 50">{{ z.win_rate_pct | number: '1.0-0' }}%</span>
                              <span class="muted"> ({{ z.wins }})</span>
                            } @else { <span class="muted">—</span> }
                          </td>
                          <td>
                            @if (z.avg_realized_pnl !== null) {
                              <span [class.pos]="z.avg_realized_pnl >= 0" [class.neg]="z.avg_realized_pnl < 0">{{ z.avg_realized_pnl | number: '1.2-2' }}</span>
                            } @else { <span class="muted">—</span> }
                          </td>
                          <td class="muted">{{ z.avg_price_trend_pct !== null ? (z.avg_price_trend_pct | number: '1.1-1') + '%' : '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
              @if (verdictTrendHasEnoughData()) {
                <div class="insights-block">
                  <h4>
                    Entwicklung über Zeit: Werden wir besser?
                    <span class="info-icon" tabindex="0" title="Vergleicht die Trefferquote pro Verdict zwischen der chronologisch ersten und zweiten Hälfte aller verknüpften, abgeschlossenen Trades. Bewusst nur zwei grobe Zeit-Buckets statt einer geglätteten Trendlinie — bei den realistisch niedrigen Trade-Volumina dieser Strategie wäre eine glatte Kurve grösstenteils Rauschen, das wie ein Signal aussieht.">ⓘ</span>
                  </h4>
                  <table class="insights-table">
                    <thead>
                      <tr>
                        <th>Verdict</th><th>Trefferquote „Früher”</th><th>Trefferquote „Später”</th><th>Tendenz</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of verdictTrend(); track row.verdict) {
                        <tr>
                          <td><span class="badge" [class]="verdictClassFor(row.verdict)">{{ verdictLabelFor(row.verdict) }}</span></td>
                          @for (half of row.halves; track half.label) {
                            <td>
                              @if (half.winRatePct !== null) {
                                <span [class.pos]="half.winRatePct >= 50" [class.neg]="half.winRatePct < 50">{{ half.winRatePct | number: '1.0-0' }}%</span>
                                <span class="muted"> ({{ half.trades }})</span>
                              } @else { <span class="muted">— (0)</span> }
                            </td>
                          }
                          <td class="muted">
                            @if (row.halves[0].winRatePct !== null && row.halves[1].winRatePct !== null) {
                              @if (row.halves[1].winRatePct! > row.halves[0].winRatePct!) { <span class="pos">↗ steigend</span> }
                              @else if (row.halves[1].winRatePct! < row.halves[0].winRatePct!) { <span class="neg">↘ fallend</span> }
                              @else { <span>→ stabil</span> }
                            } @else { — }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <p class="muted insights-hint">
                  Für eine Zeitvergleichs-Auswertung („werden wir besser?“) braucht es mindestens
                  {{ verdictTrendMinTrades }} verknüpfte, abgeschlossene Trades — bisher
                  {{ closedTrades().length }}. Auch diese Karte füllt sich von selbst.
                </p>
              }
              <p class="muted insights-hint">
                Faustregel: Aussagen erst ab ~20–30 Trades pro Gruppe ernst nehmen — bei
                weniger ist „die Heuristik funktioniert“ kaum von „wir hatten Glück/Pech“ zu
                unterscheiden.
              </p>
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
            <div class="tx-toolbar">
              <input
                type="text"
                class="table-filter"
                placeholder="Filtern nach Ticker, Aktion oder Begründung…"
                [value]="txFilter()"
                (input)="txFilter.set($any($event.target).value)"
              />
              <button class="csv-export-btn" (click)="exportTransactionsCsv()" title="Lädt die aktuell gefilterte Liste als CSV-Datei herunter (Excel-kompatibel, UTF-8 mit BOM).">
                CSV exportieren
              </button>
            </div>
            <div class="tx-summary muted">
              @if (filteredTransactions().length !== transactions().length) {
                {{ filteredTransactions().length }} von {{ transactions().length }} Transaktionen (gefiltert) ·
              } @else {
                {{ transactions().length }} Transaktionen ·
              }
              {{ buyCount() }} Käufe · {{ sellCount() }} Verkäufe ·
              Gesamtgebühren {{ totalFeesInLog() | number: '1.2-2' }} CHF
            </div>
            @if (filteredTransactions().length === 0) {
              <p class="muted">Keine Transaktionen entsprechen dem Filter „{{ txFilter() }}”.</p>
            }
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
                    <th>Kurs (USD)</th>
                    <th>Gebühr (CHF)</th>
                    <th>Brutto</th>
                    <th>PnL (CHF)</th>
                    <th>Begründung</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of filteredTransactions(); track t.id) {
                    <tr [class.tx-buy]="t.action === 'buy'" [class.tx-sell]="t.action === 'sell'">
                      <td class="nowrap">{{ t.created_at | date: 'dd.MM.yy HH:mm' }}</td>
                      <td>
                        <span class="badge" [class.badge-organic]="t.action === 'buy'" [class.badge-blocked]="t.action === 'sell'">
                          {{ t.action === 'buy' ? 'KAUF' : 'VERKAUF' }}
                        </span>
                      </td>
                      <td class="ticker">{{ t.ticker }}</td>
                      <td class="nowrap">{{ t.shares | number: '1.4-4' }}</td>
                      <td class="nowrap">{{ t.price | number: '1.2-2' }}</td>
                      <td class="nowrap" [title]="'Brokerage ' + (t.fee | number: '1.2-2') + ' + FX-Marge ' + (t.fx_fee | number: '1.2-2') + ' CHF'">
                        {{ (t.fee + t.fx_fee) | number: '1.2-2' }}
                        @if (t.fx_fee > 0) { <span class="muted fee-fx-hint">(inkl. FX)</span> }
                      </td>
                      <td class="nowrap">{{ t.gross_amount | number: '1.2-2' }}</td>
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
        position: relative;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100vw - 2rem);
        max-width: 1180px;
        box-sizing: border-box;
      }
      @media (max-width: 1180px) {
        .tx-wide { position: static; left: auto; transform: none; width: auto; max-width: none; }
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
      .scan-freshness { margin-left: auto; align-self: center; font-size: 0.72rem; white-space: nowrap; }
      .scan-stale { color: #d9534f; font-weight: 600; }
      .fx-note { margin: -0.5rem 0 1rem; line-height: 1.4; }
      .chart-note { margin: 0.5rem 0 0; line-height: 1.4; font-size: 0.72rem; }
      .grid-top-metrics { grid-template-columns: repeat(4, 1fr); }
      .stat-sub-inline { font-size: 0.78rem; color: #888; }
      .fee-fx-hint { font-size: 0.65rem; color: #aaa; }
      /*
        Small "info" badge placed next to headings/column labels for complex
        metrics (hype score, z-score, drawdown, ...). Uses the native HTML
        title attribute for the hover tooltip — no extra JS/overlay machinery
        needed, and it works with keyboard focus (tabindex) and screen
        readers for free.
      */
      .info-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 15px; height: 15px; margin-left: 3px; border-radius: 50%;
        background: #eef1f6; color: #7a8699; font-size: 0.62rem; font-style: normal;
        font-weight: 700; cursor: help; vertical-align: middle; line-height: 1;
      }
      .info-icon:hover, .info-icon:focus-visible {
        background: #dbe4f3; color: #4f8ef7; outline: none;
      }
      .insights-block { margin-bottom: 1rem; }
      .insights-block h4 { font-size: 0.85rem; margin: 0 0 0.5rem; }
      .insights-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
      .insights-table th, .insights-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; }
      .insights-table th { color: #888; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.02em; }
      .insights-hint { margin: 0.5rem 0 0; }
      @media (max-width: 900px) {
        .grid-top-metrics { grid-template-columns: 1fr 1fr; }
      }
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

      /* ── Chart mode toggle (CHF ↔ %) ──────────────────────────────────── */
      .grid-mid .card h3 { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
      .chart-mode-toggle {
        margin-left: auto;
        background: #fff; border: 1px solid #ddd; border-radius: 20px; cursor: pointer;
        padding: 4px 12px; font-size: 0.7rem; font-weight: 600; color: #666;
        white-space: nowrap; transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .chart-mode-toggle:hover { background: #fff1ea; color: #ff4500; border-color: #ffd0b8; }

      /* ── Generic table-filter text input (watchlist + transactions) ──────── */
      .table-filter {
        display: block; width: 100%; box-sizing: border-box; margin-bottom: 0.6rem;
        padding: 6px 10px; font-size: 0.78rem; border: 1px solid #ddd; border-radius: 6px;
        background: #fff; color: #333;
      }
      .table-filter:focus { outline: none; border-color: #ff4500; box-shadow: 0 0 0 2px #ffe3d6; }
      .table-filter::placeholder { color: #aaa; }

      /* ── Sortable column headers (Watchlist & Signale) ───────────────────── */
      th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
      th.sortable:hover { color: #ff4500; }
      th.sortable.sorted { color: #ff4500; }
      .sort-indicator { display: inline-block; width: 0.9em; font-size: 0.7em; margin-left: 2px; }

      /* ── Second grid-mid row: allocation bars + cash-vs-invested chart ───── */
      .grid-mid-reverse { grid-template-columns: 1fr 1fr; }
      .chart-wrap-small { height: 180px; }
      .alloc-row { margin-bottom: 0.65rem; }
      .alloc-row:last-child { margin-bottom: 0; }
      .alloc-row-head {
        display: flex; align-items: baseline; justify-content: space-between;
        font-size: 0.8rem; margin-bottom: 4px;
      }
      .alloc-row-head .ticker { font-size: 0.85rem; }
      .alloc-bar-bg { background: #eee; border-radius: 4px; height: 8px; overflow: hidden; }
      .alloc-bar-fill { height: 8px; border-radius: 4px; background: linear-gradient(90deg, #ff8a50, #ff4500); }
      .alloc-hint { margin-top: 0.6rem; }

      /* ── Ticker leaderboard table ─────────────────────────────────────────── */
      .leaderboard-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
      .leaderboard-table th, .leaderboard-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; }
      .leaderboard-table th { color: #888; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.02em; }
      .leaderboard-table tr:last-child td { border-bottom: none; }

      /* ── Transaction-history toolbar: filter input + CSV export ──────────── */
      .tx-toolbar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; }
      .tx-toolbar .table-filter { flex: 1; margin-bottom: 0; }
      .csv-export-btn {
        flex-shrink: 0; background: #fff; border: 1px solid #ddd; border-radius: 6px; cursor: pointer;
        padding: 6px 14px; font-size: 0.76rem; font-weight: 600; color: #666; white-space: nowrap;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .csv-export-btn:hover { background: #fff1ea; color: #ff4500; border-color: #ffd0b8; }
      @media (max-width: 600px) {
        .tx-toolbar { flex-direction: column; align-items: stretch; }
      }
    `,
  ],
})
export class TradingDashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  protected readonly trading = inject(TradingService);

  // Mirrors the constants in supabase/functions/market-scan/index.ts — shown
  // in the UI so it's clear at which thresholds a position would be closed.
  protected readonly activeTab = signal<'overview' | 'transactions'>('overview');

  // Mirrors the constants in both Edge Functions — see market-scan's
  // strategy-constants comment for the full reasoning. Short version: with
  // Swissquote's ~6.3% round-trip cost (brokerage + FX margin, EACH WAY,
  // hitting every exit regardless of win/lose), single-digit-percent
  // thresholds make the strategy structurally unprofitable (an ±8%/±3.5%
  // pair nets roughly +1.7% on wins vs. -9.8% on losses — an ~85% hit rate
  // just to break even). The strategy is now SWING-shaped — larger targets
  // over days-to-weeks holds — so that ~6.3% tax stays a small fraction of
  // the targeted move: net win ≈ +13.7%, net loss ≈ -12.3%, breakeven hit
  // rate ≈ 47%, a realistic bar for a heuristic with a genuine edge.
  protected readonly takeProfit = 0.2;
  protected readonly stopLoss = -0.06;
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
  protected readonly lastScanAt = signal<string | null>(null);
  protected readonly verdictPerformance = signal<VerdictPerformanceRow[]>([]);
  protected readonly zScorePerformance = signal<ZScoreBucketPerformanceRow[]>([]);

  protected readonly totalValue = signal(0);

  // ── Watchlist & Signale: sortable + filterable ──────────────────────────
  // Default sort = Hype-Score absteigend: die Tabelle visualisiert "Hype"
  // bereits prominent über den Farbbalken, also ist "was macht gerade am
  // meisten Lärm" der naheliegendste Einstieg — und als Zahl ist die
  // Sortierung sofort verständlich (anders als z.B. "nach Verdict", was beim
  // Spaltenklick eher verwirren würde, da Verdict kein numerischer Wert ist).
  protected readonly signalSortColumn = signal<SignalSortColumn>('hype_score');
  protected readonly signalSortDirection = signal<SortDirection>('desc');
  protected readonly signalFilter = signal('');

  protected readonly filteredSignals = computed(() => {
    const term = this.signalFilter().trim().toUpperCase();
    const rows = this.signals();
    return term ? rows.filter((s) => s.ticker.toUpperCase().includes(term)) : rows;
  });

  protected readonly sortedSignals = computed(() => {
    const column = this.signalSortColumn();
    const dir = this.signalSortDirection() === 'asc' ? 1 : -1;
    return [...this.filteredSignals()].sort((a, b) => {
      let cmp = 0;
      switch (column) {
        case 'ticker':
          cmp = a.ticker.localeCompare(b.ticker);
          break;
        case 'price':
          cmp = a.price - b.price;
          break;
        case 'mention_count':
          cmp = a.mention_count - b.mention_count;
          break;
        case 'hype_score':
          cmp = a.hype_score - b.hype_score;
          break;
        case 'verdict':
          cmp = this.verdictRank(a) - this.verdictRank(b);
          break;
      }
      return cmp * dir;
    });
  });

  /** "Organic" first, then "spike", then "blocked" — i.e. the order of decreasing tradeability. */
  private verdictRank(s: SignalRow): number {
    if (s.blocked) return 2;
    if (s.verdict === 'spike') return 1;
    return 0;
  }

  /**
   * Click handling for sortable column headers: clicking the active column
   * flips its direction; clicking a new column picks a sensible starting
   * direction per data type — numbers start descending ("biggest/most
   * interesting first"), text starts ascending ("alphabetical", the
   * conventional default for names/labels).
   */
  protected toggleSignalSort(column: SignalSortColumn): void {
    if (this.signalSortColumn() === column) {
      this.signalSortDirection.update((d) => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    this.signalSortColumn.set(column);
    this.signalSortDirection.set(column === 'ticker' || column === 'verdict' ? 'asc' : 'desc');
  }

  protected signalSortIndicator(column: SignalSortColumn): string {
    if (this.signalSortColumn() !== column) return '';
    return this.signalSortDirection() === 'asc' ? '▲' : '▼';
  }

  // ── Hauptchart: CHF- vs. %-Ansicht umschaltbar ──────────────────────────
  // CHF zeigt die absoluten Beträge (vertraut, direkt mit Cash/Portfoliowert
  // vergleichbar); % seit Start macht den Strategie-vs-SPY-Vergleich direkt
  // ablesbar, ohne im Kopf umrechnen zu müssen (beide Linien starten bei 0%).
  protected readonly chartMode = signal<'value' | 'percent'>('value');

  protected toggleChartMode(): void {
    this.chartMode.update((m) => (m === 'value' ? 'percent' : 'value'));
    this.renderChart();
  }

  @ViewChild('allocationCanvas') private allocationCanvas?: ElementRef<HTMLCanvasElement>;
  private allocationChart: Chart | null = null;

  // ── Transaktions-Filter & -Export ────────────────────────────────────────
  protected readonly txFilter = signal('');

  protected readonly filteredTransactions = computed(() => {
    const term = this.txFilter().trim().toUpperCase();
    const rows = this.transactions();
    if (!term) return rows;
    return rows.filter(
      (t) =>
        t.ticker.toUpperCase().includes(term) ||
        (t.action === 'buy' ? 'KAUF' : 'VERKAUF').includes(term) ||
        t.reason.toUpperCase().includes(term),
    );
  });

  // How long after the expected 6-hourly cadence we start flagging the last
  // scan as possibly stuck — generous enough to not false-positive on a
  // slightly-delayed run, tight enough to actually catch a dead cron job.
  private static readonly SCAN_STALE_AFTER_MS = 9 * 60 * 60 * 1000;

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
    this.renderAllocationChart();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.allocationChart?.destroy();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [
        portfolio,
        positions,
        transactions,
        balanceHistory,
        signals,
        lastScanAt,
        verdictPerformance,
        zScorePerformance,
      ] = await Promise.all([
        this.trading.getPortfolio(),
        this.trading.getPositions(),
        this.trading.getTransactionLog(),
        this.trading.getBalanceHistory(),
        this.trading.getWatchlistSignals(),
        this.trading.getLastScanTime(),
        this.trading.getVerdictPerformance(),
        this.trading.getZScoreBucketPerformance(),
      ]);
      this.portfolio.set(portfolio);
      this.positions.set(positions);
      this.transactions.set(transactions);
      this.balanceHistory.set(balanceHistory);
      this.signals.set(signals);
      this.lastScanAt.set(lastScanAt);
      this.verdictPerformance.set(verdictPerformance);
      this.zScorePerformance.set(zScorePerformance);

      const latestSnapshot = balanceHistory[balanceHistory.length - 1];
      this.totalValue.set(latestSnapshot ? latestSnapshot.total_value : portfolio.cash);

      this.renderChart();
      this.renderAllocationChart();
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
    return this.transactions().reduce((sum, t) => sum + t.fee + t.fx_fee, 0);
  }

  // ── Data freshness ───────────────────────────────────────────────────────
  // `market-scan` runs every ~6h; if `lastScanAt` falls noticeably further
  // behind than that, the cron job has likely stopped firing — and without
  // this indicator the dashboard would look identical to a healthy one (just
  // a flat chart), making a silent outage easy to miss.
  protected scanAgeMs(): number | null {
    const t = this.lastScanAt();
    return t ? Date.now() - new Date(t).getTime() : null;
  }

  protected scanIsStale(): boolean {
    const age = this.scanAgeMs();
    return age !== null && age > TradingDashboardComponent.SCAN_STALE_AFTER_MS;
  }

  protected scanAgeLabel(): string {
    const age = this.scanAgeMs();
    if (age === null) return '';
    const hours = age / 36e5;
    if (hours < 1) return `vor ${Math.max(1, Math.round(age / 60000))} Min.`;
    if (hours < 48) return `vor ${hours.toFixed(1)} Std.`;
    return `vor ${(hours / 24).toFixed(1)} Tagen`;
  }

  // ── Strategy performance metrics ─────────────────────────────────────────
  // These are what actually answer "is the strategy working", which the
  // headline P&L number alone can't: a high win rate with tiny wins and rare
  // huge losses (or the reverse) produces an identical-looking total.
  protected closedTrades(): TransactionRow[] {
    return this.transactions().filter((t) => t.action === 'sell' && t.realized_pnl !== null);
  }

  protected winCount(): number {
    return this.closedTrades().filter((t) => (t.realized_pnl ?? 0) > 0).length;
  }

  protected lossCount(): number {
    return this.closedTrades().filter((t) => (t.realized_pnl ?? 0) < 0).length;
  }

  protected winRate(): number | null {
    const closed = this.closedTrades();
    return closed.length ? (this.winCount() / closed.length) * 100 : null;
  }

  protected avgWin(): number | null {
    const wins = this.closedTrades().filter((t) => (t.realized_pnl ?? 0) > 0);
    return wins.length ? wins.reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0) / wins.length : null;
  }

  protected avgLoss(): number | null {
    const losses = this.closedTrades().filter((t) => (t.realized_pnl ?? 0) < 0);
    return losses.length ? losses.reduce((sum, t) => sum + (t.realized_pnl ?? 0), 0) / losses.length : null;
  }

  /**
   * Average holding duration across BUY→SELL pairs that are explicitly linked
   * via `opening_transaction_id` (only trades made after the v2 migration —
   * older rows have no link and are silently excluded rather than guessed at).
   */
  protected avgHoldingHours(): number | null {
    const buysById = new Map(this.transactions().filter((t) => t.action === 'buy').map((t) => [t.id, t]));
    const durations: number[] = [];
    for (const sell of this.closedTrades()) {
      if (sell.opening_transaction_id === null) continue;
      const buy = buysById.get(sell.opening_transaction_id);
      if (!buy) continue;
      durations.push((new Date(sell.created_at).getTime() - new Date(buy.created_at).getTime()) / 36e5);
    }
    return durations.length ? durations.reduce((sum, h) => sum + h, 0) / durations.length : null;
  }

  protected formatHoldingDuration(hours: number): string {
    if (hours < 48) return `${hours.toFixed(1)} Std.`;
    return `${(hours / 24).toFixed(1)} Tage`;
  }

  /**
   * Largest peak-to-trough decline of the portfolio's total value over the
   * recorded history — a standard risk metric that "realized P&L" alone
   * doesn't capture (a strategy can be net-positive while having survived a
   * terrifying 40% dip along the way).
   */
  protected maxDrawdownPct(): number | null {
    const values = this.balanceHistory().map((h) => h.total_value);
    if (values.length < 2) return null;
    let peak = values[0];
    let maxDrawdown = 0;
    for (const value of values) {
      if (value > peak) peak = value;
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
    }
    return maxDrawdown * 100;
  }

  /**
   * Volatility of the portfolio's value, expressed as the standard deviation
   * of period-over-period % changes between consecutive `balance_history`
   * snapshots — the standard "how bumpy is the ride" risk measure that
   * complements `maxDrawdownPct` (the latter shows the WORST single dip; this
   * shows how much the value typically swings, dip or no dip). Returns `null`
   * with fewer than 3 snapshots (need ≥2 returns for a meaningful stddev).
   */
  protected volatilityPct(): number | null {
    const values = this.balanceHistory().map((h) => h.total_value);
    if (values.length < 3) return null;
    const returns: number[] = [];
    for (let i = 1; i < values.length; i += 1) {
      if (values[i - 1] !== 0) returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance) * 100;
  }

  /**
   * Per-ticker leaderboard: aggregates every CLOSED, realized trade by ticker
   * — "which symbols actually made/cost us money overall, not just on their
   * single best or worst trade?". Sorted by total contribution to realized
   * P&L (descending), so the biggest winners surface first and the biggest
   * drags are easy to spot at the bottom. Pure client-side aggregation of
   * data already loaded for the transaction log — no extra round trip.
   */
  protected readonly tickerLeaderboard = computed(() => {
    const byTicker = new Map<string, { ticker: string; trades: number; wins: number; totalPnl: number }>();
    for (const t of this.closedTrades()) {
      const entry = byTicker.get(t.ticker) ?? { ticker: t.ticker, trades: 0, wins: 0, totalPnl: 0 };
      entry.trades += 1;
      if ((t.realized_pnl ?? 0) > 0) entry.wins += 1;
      entry.totalPnl += t.realized_pnl ?? 0;
      byTicker.set(t.ticker, entry);
    }
    return [...byTicker.values()].sort((a, b) => b.totalPnl - a.totalPnl);
  });

  /**
   * Each open position's mark-to-market value as a % of the total invested
   * capital (sum of all open positions, NOT the whole portfolio incl. cash —
   * "how concentrated is what's actually at risk right now" is the relevant
   * question for spotting clumping risk, cash sitting idle is a separate
   * concern already covered by the cash-vs-invested chart).
   */
  protected positionSizeShare(p: PositionRow): number {
    const total = this.positionsValue();
    if (total <= 0) return 0;
    return ((this.currentPrice(p.ticker) ?? p.entry_price) * p.shares / total) * 100;
  }

  /**
   * "Is the heuristic getting better or worse over time?" — splits closed,
   * LINKED trades (those with a `signal_snapshot`, i.e. logged after the v2
   * migration) chronologically into an earlier and a later half and compares
   * win rate per verdict between them. A crude two-bucket comparison rather
   * than a proper rolling chart, deliberately: with the trade volumes this
   * strategy realistically produces (a handful of swing trades a week), a
   * smooth trend line would mostly be noise dressed up as signal — two
   * buckets is an honest representation of "do we have enough to even ask
   * this question yet, and if so, which direction does it lean".
   */
  protected readonly verdictTrend = computed(() => {
    const buysById = new Map(
      this.transactions()
        .filter((t) => t.action === 'buy' && t.signal_snapshot)
        .map((t) => [t.id, t]),
    );
    const linked = this.closedTrades()
      .map((sell) => {
        if (sell.opening_transaction_id === null) return null;
        const buy = buysById.get(sell.opening_transaction_id);
        if (!buy?.signal_snapshot) return null;
        return { sell, verdict: buy.signal_snapshot.verdict };
      })
      .filter((x): x is { sell: TransactionRow; verdict: string } => x !== null)
      // chronological — oldest first — so "earlier half" / "later half" means what it says
      .sort((a, b) => new Date(a.sell.created_at).getTime() - new Date(b.sell.created_at).getTime());

    const mid = Math.floor(linked.length / 2);
    const halves = [
      { label: 'Früher', rows: linked.slice(0, mid) },
      { label: 'Später', rows: linked.slice(mid) },
    ];

    const verdicts = ['organic', 'spike', 'pure-hype'];
    return verdicts
      .map((verdict) => ({
        verdict,
        halves: halves.map(({ label, rows }) => {
          const matching = rows.filter((r) => r.verdict === verdict);
          const wins = matching.filter((r) => (r.sell.realized_pnl ?? 0) > 0).length;
          return {
            label,
            trades: matching.length,
            winRatePct: matching.length ? (wins / matching.length) * 100 : null,
          };
        }),
      }))
      .filter((row) => row.halves.some((h) => h.trades > 0));
  });

  /** Minimum linked, closed trades before the early/late comparison is shown — fewer and the "trend" is just noise. */
  protected readonly verdictTrendMinTrades = 12;

  protected readonly verdictTrendHasEnoughData = computed(
    () => this.closedTrades().filter((t) => t.opening_transaction_id !== null).length >= this.verdictTrendMinTrades,
  );

  /**
   * Builds and triggers the download of a CSV snapshot of the (currently
   * filtered) transaction log — lets the user take the data into a
   * spreadsheet for analysis the dashboard doesn't (yet) offer, without
   * needing direct database access. Client-side only: a Blob + a throwaway
   * `<a download>` link, no server round trip or extra dependency.
   */
  protected exportTransactionsCsv(): void {
    const rows = this.filteredTransactions();
    if (rows.length === 0) return;
    const header = ['Datum', 'Aktion', 'Ticker', 'Menge', 'Kurs (USD)', 'Gebühr (CHF)', 'FX-Marge (CHF)', 'Brutto', 'PnL (CHF)', 'Begründung'];
    const escapeCsv = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const lines = [
      header.join(','),
      ...rows.map((t) =>
        [
          t.created_at,
          t.action === 'buy' ? 'Kauf' : 'Verkauf',
          t.ticker,
          t.shares,
          t.price,
          t.fee,
          t.fx_fee,
          t.gross_amount,
          t.realized_pnl ?? '',
          escapeCsv(t.reason),
        ].join(','),
      ),
    ];
    // Leading BOM so Excel (still the most common destination for "export as
    // CSV") detects UTF-8 correctly instead of mangling German umlauts.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transaktionen_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ── Benchmark comparison ─────────────────────────────────────────────────
  // "Would the same starting capital simply parked in an index ETF have done
  // better?" is the one question that tells you whether a strategy adds real
  // value or just rides a rising market — so we track SPY alongside every
  // balance snapshot and normalize it to the same starting capital here.
  protected hasBenchmarkData(): boolean {
    return this.balanceHistory().some((h) => h.spy_price !== null && h.spy_price !== undefined);
  }

  protected benchmarkSeries(): (number | null)[] {
    const history = this.balanceHistory();
    const initialValue = history.length ? history[0].total_value : 10000;
    const reference = history.find((h) => h.spy_price !== null && h.spy_price !== undefined)?.spy_price ?? null;
    if (reference === null) {
      return history.map(() => null);
    }
    return history.map((h) =>
      h.spy_price !== null && h.spy_price !== undefined ? initialValue * (h.spy_price / reference) : null,
    );
  }

  /**
   * Maps a position's current change-since-entry (e.g. -0.06 .. +0.20) onto a
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

  /**
   * Same labeling as `verdictLabel`/`verdictClass`, but for the raw
   * `verdict` string stored in a BUY's `signal_snapshot` (as read back via
   * the `trade_outcomes_by_verdict` view) rather than a live `SignalRow` —
   * there's no separate `blocked` flag here since blocked tickers are never
   * bought in the first place.
   */
  protected verdictLabelFor(verdict: string): string {
    if (verdict === 'spike') return 'Spike';
    if (verdict === 'pure-hype') return 'Pure-Hype';
    if (verdict === 'organic') return 'Organisch';
    return 'Unbekannt';
  }

  protected verdictClassFor(verdict: string): string {
    if (verdict === 'spike') return 'badge badge-spike';
    if (verdict === 'pure-hype') return 'badge badge-blocked';
    if (verdict === 'organic') return 'badge badge-organic';
    return 'badge';
  }

  // Fixed dataset indices for the main chart — named so `renderChart` and its
  // tooltip callback (which needs to tell "hovering the trade-marker overlay"
  // apart from "hovering the portfolio/benchmark/drawdown lines") agree on
  // what's where without magic numbers scattered through both.
  private static readonly CHART_DS_PORTFOLIO = 0;
  private static readonly CHART_DS_BENCHMARK = 1;
  private static readonly CHART_DS_DRAWDOWN = 2;
  private static readonly CHART_DS_MARKERS = 3;

  private renderChart(): void {
    const canvas = this.chartCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const history = this.balanceHistory();
    const labels = history.map((h) =>
      new Date(h.recorded_at).toLocaleString('de-CH', { month: 'short', day: 'numeric', hour: '2-digit' }),
    );
    const initialValue = history.length ? history[0].total_value : 10000;
    const mode = this.chartMode();
    const isPercent = mode === 'percent';

    // Both the portfolio line and the (already CHF-normalized) benchmark line
    // get the SAME percent transform — "% change since the same starting
    // capital" — so the two stay directly, fairly comparable in either mode.
    const toDisplay = (v: number | null): number | null =>
      v === null ? null : isPercent && initialValue !== 0 ? ((v - initialValue) / initialValue) * 100 : v;

    const portfolioRaw = history.map((h) => h.total_value);
    const benchmarkRaw = this.benchmarkSeries();
    const portfolioSeries = portfolioRaw.map(toDisplay);
    const benchmarkSeries = benchmarkRaw.map(toDisplay);

    // Running peak of the DISPLAYED portfolio series — i.e. computed AFTER the
    // %-transform, so "drawdown" always means "below own prior best", which
    // looks identical in CHF and % terms (a constant transform doesn't change
    // WHERE the peaks are, only their printed values).
    const drawdownPeak: (number | null)[] = [];
    let runningPeak = -Infinity;
    for (const v of portfolioSeries) {
      if (v !== null && v > runningPeak) runningPeak = v;
      drawdownPeak.push(v === null ? null : runningPeak);
    }

    // ── Buy/Sell trade markers ─────────────────────────────────────────────
    // `transactions` and `balance_history` are independent tables on
    // different schedules (trade-driven vs. every-~30-min) — there's no
    // shared key to join on. Snapping each transaction to the temporally
    // NEAREST snapshot is the simplest honest placement: "the portfolio was
    // worth roughly this much around when this trade happened" is exactly
    // what the line already shows at that point, so the marker sits ON it.
    const markerData: (number | null)[] = labels.map(() => null);
    const markerColors: string[] = labels.map(() => 'transparent');
    const markerRotations: number[] = labels.map(() => 0);
    const markerRadii: number[] = labels.map(() => 0);
    const markerMeta: (TradeMarkerMeta | null)[] = labels.map(() => null);
    if (history.length > 0) {
      const snapshotTimes = history.map((h) => new Date(h.recorded_at).getTime());
      for (const t of this.transactions()) {
        const txTime = new Date(t.created_at).getTime();
        let nearest = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < snapshotTimes.length; i += 1) {
          const diff = Math.abs(snapshotTimes[i] - txTime);
          if (diff < bestDiff) {
            bestDiff = diff;
            nearest = i;
          }
        }
        markerData[nearest] = portfolioSeries[nearest];
        markerRadii[nearest] = 6;
        // ▲ pointing up = entering a position, ▼ pointing down = exiting —
        // the rotation alone conveys "in vs. out" even before reading the
        // tooltip. Color carries the OUTCOME: blue for a neutral entry, green
        // for a profitable exit, red for a loss — so a glance at the marker
        // colors along the timeline already hints at the win/loss rhythm.
        if (t.action === 'buy') {
          markerRotations[nearest] = 0;
          markerColors[nearest] = '#4f8ef7';
        } else {
          markerRotations[nearest] = 180;
          markerColors[nearest] = (t.realized_pnl ?? 0) >= 0 ? '#1a8a3c' : '#c0392b';
        }
        markerMeta[nearest] = {
          ticker: t.ticker,
          action: t.action,
          realizedPnl: t.realized_pnl,
          reason: t.reason,
        };
      }
    }

    const unitSuffix = isPercent ? '%' : ' CHF';
    const fmtValue = (v: number): string => `${v.toFixed(isPercent ? 1 : 2)}${unitSuffix}`;

    const datasets = [
      {
        label: isPercent ? 'Portfolio (% seit Start)' : 'Portfoliowert (CHF)',
        data: portfolioSeries,
        borderColor: '#4f8ef7',
        backgroundColor: 'rgba(79, 142, 247, 0.12)',
        fill: true,
        tension: 0.25,
        pointRadius: 0,
      },
      {
        label: isPercent ? 'SPY (% seit Start)' : 'SPY (normiert auf Startkapital)',
        data: benchmarkSeries,
        borderColor: '#9aa3b2',
        backgroundColor: 'transparent',
        borderDash: [6, 4],
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        spanGaps: true,
      },
      {
        // Invisible line whose only job is to FILL the gap down to the
        // portfolio line (`fill: CHART_DS_PORTFOLIO`) — the visible result is
        // a soft red wash exactly covering "how far below its own prior peak
        // is the portfolio right now", Chart.js's native way to draw a
        // between-two-lines band without a plugin.
        label: 'Abstand vom bisherigen Hoch (Drawdown)',
        data: drawdownPeak,
        borderColor: 'transparent',
        backgroundColor: 'rgba(192, 57, 43, 0.12)',
        fill: TradingDashboardComponent.CHART_DS_PORTFOLIO,
        tension: 0.25,
        pointRadius: 0,
      },
      {
        // Point-only overlay (no connecting line) — see the marker-building
        // block above for why colors/rotations/meta are pre-computed arrays
        // indexed exactly like `labels`/`portfolioSeries`.
        label: 'Käufe / Verkäufe',
        data: markerData,
        showLine: false,
        backgroundColor: markerColors,
        borderColor: markerColors,
        pointStyle: 'triangle',
        rotation: markerRotations,
        pointRadius: markerRadii,
        pointHoverRadius: markerRadii.map((r) => (r > 0 ? r + 2 : 0)),
      },
    ];

    const tooltipLabel = (context: { datasetIndex: number; dataIndex: number; parsed: { y: number | null } }): string | string[] => {
      const idx = context.dataIndex;
      switch (context.datasetIndex) {
        case TradingDashboardComponent.CHART_DS_MARKERS: {
          const meta = markerMeta[idx];
          if (!meta) return '';
          const actionLabel = meta.action === 'buy' ? 'Kauf' : 'Verkauf';
          const pnlPart =
            meta.realizedPnl !== null && meta.realizedPnl !== undefined
              ? ` · PnL ${meta.realizedPnl >= 0 ? '+' : ''}${meta.realizedPnl.toFixed(2)} CHF`
              : '';
          return [`${actionLabel}: ${meta.ticker}${pnlPart}`, meta.reason];
        }
        case TradingDashboardComponent.CHART_DS_PORTFOLIO: {
          const snapshot = history[idx];
          const value = context.parsed.y;
          if (value === null || value === undefined) return '';
          const base = `Portfolio: ${fmtValue(value)}`;
          // Richer breakdown straight from the snapshot — "how much of this is
          // cash vs. mark-to-market position value RIGHT NOW" is exactly the
          // question the separate cash-vs-invested chart answers over time;
          // showing it inline here too means you don't have to cross-reference
          // two charts to understand a single point in time.
          if (snapshot) {
            return [base, `davon Cash ${snapshot.cash.toFixed(2)} CHF · Positionen ${snapshot.positions_value.toFixed(2)} CHF`];
          }
          return base;
        }
        case TradingDashboardComponent.CHART_DS_BENCHMARK: {
          const value = context.parsed.y;
          return value === null || value === undefined ? '' : `SPY: ${fmtValue(value)}`;
        }
        default:
          // Drawdown band: showing it as its own tooltip line would just
          // restate "portfolio minus its own peak" in different words — the
          // shaded area already communicates that visually. Suppress it.
          return '';
      }
    };

    if (this.chart) {
      // Update the existing chart in place rather than destroying/recreating
      // it — cheaper, avoids a flicker, and sidesteps any ViewChild timing
      // issues since the canvas (and thus the Chart instance) now persists
      // across data reloads. Replacing the whole `datasets`/`labels` arrays
      // (rather than mutating `.data` piecemeal) keeps this in sync even when
      // the dataset SHAPE changes (e.g. switching CHF ⟷ % changes labels,
      // colors and the y-axis formatter, not just the numbers).
      this.chart.data.labels = labels;
      // deno-lint-ignore no-explicit-any
      this.chart.data.datasets = datasets as any;
      if (this.chart.options.scales?.['y']) {
        (this.chart.options.scales['y'] as { ticks: { callback: (v: number) => string } }).ticks.callback = (v: number) =>
          isPercent ? `${v.toFixed(0)}%` : `${v} CHF`;
      }
      if (this.chart.options.plugins?.tooltip) {
        // deno-lint-ignore no-explicit-any
        (this.chart.options.plugins.tooltip.callbacks as any).label = tooltipLabel;
      }
      this.chart.update();
      return;
    }

    this.chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              boxWidth: 16,
              // The drawdown band is a visual aid, not something you'd ever
              // want to toggle off via the legend — hiding it from the legend
              // keeps the legend focused on the three things worth comparing
              // (portfolio / SPY / trades) without losing the shading itself.
              filter: (item) => item.datasetIndex !== TradingDashboardComponent.CHART_DS_DRAWDOWN,
            },
          },
          tooltip: { callbacks: { label: tooltipLabel } },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: { ticks: { callback: (v) => (isPercent ? `${v}%` : `${v} CHF`) } },
        },
      },
    });
  }

  /**
   * Second, small chart: stacked area of cash vs. mark-to-market position
   * value over time — "how much of the portfolio is actually deployed right
   * now, vs. sitting on the sidelines waiting for the next setup?". Answers a
   * different question than the main chart (which only shows the COMBINED
   * total): a flat total can hide a portfolio that swung from "all cash" to
   * "fully invested" and back, which this makes visible at a glance.
   */
  private renderAllocationChart(): void {
    const canvas = this.allocationCanvas?.nativeElement;
    if (!canvas) return;

    const history = this.balanceHistory();
    const labels = history.map((h) =>
      new Date(h.recorded_at).toLocaleString('de-CH', { month: 'short', day: 'numeric', hour: '2-digit' }),
    );
    const cashSeries = history.map((h) => h.cash);
    const investedSeries = history.map((h) => h.positions_value);

    if (this.allocationChart) {
      this.allocationChart.data.labels = labels;
      this.allocationChart.data.datasets[0].data = cashSeries;
      this.allocationChart.data.datasets[1].data = investedSeries;
      this.allocationChart.update();
      return;
    }

    this.allocationChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Cash (CHF)',
            data: cashSeries,
            borderColor: '#9aa3b2',
            backgroundColor: 'rgba(154, 163, 178, 0.45)',
            fill: true,
            stack: 'allocation',
            tension: 0.2,
            pointRadius: 0,
          },
          {
            label: 'Investiert · Marktwert offener Positionen (CHF)',
            data: investedSeries,
            borderColor: '#4f8ef7',
            backgroundColor: 'rgba(79, 142, 247, 0.45)',
            fill: true,
            stack: 'allocation',
            tension: 0.2,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 16 } } },
        scales: {
          x: { ticks: { maxTicksLimit: 6 }, stacked: true },
          y: { stacked: true, ticks: { callback: (v) => `${v} CHF` } },
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
