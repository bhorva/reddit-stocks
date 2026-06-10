import { CommonModule } from '@angular/common';
import { InfoTipDirective } from './info-tip.directive';
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
  PushNotificationRow,
  SignalRow,
  TradingService,
  TransactionRow,
  VerdictPerformanceRow,
  WatchlistRow,
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

/**
 * A "Verpasste Chance" (`SignalRow` with `skipped_for_capacity = true`)
 * paired with whatever the dashboard can tell about what happened to that
 * ticker SINCE — derived purely by joining against `getWatchlistSignals()`
 * (the latest signal per actively-watched ticker), which the dashboard loads
 * anyway. No new fetching, no simulated counterfactual P&L — see
 * `missedOpportunityViews` for why that's a deliberate choice, not a
 * shortcut: a true "would it have hit take-profit or stop-loss first?"
 * simulation needs day-by-day path-walking (a second trading engine, with
 * all the same fidelity traps as the real one) for a payoff that's dwarfed
 * by the noise at today's data volumes. This stays purely descriptive —
 * "here's what the price actually did since" — and leaves the judgment to
 * the human reading the table, exactly the "lightweight" shape that was
 * chosen over a full shadow-simulation engine.
 */
interface MissedOpportunityView {
  signal: SignalRow;
  /** Latest known signal for this ticker — `null` if it fell off the watchlist since. */
  latest: SignalRow | null;
  /** True iff `signal` IS the latest known signal for its ticker — i.e. too little time has passed to say anything yet. */
  isLatest: boolean;
  /** `(latest.price - signal.price) / signal.price`, or `null` when there's nothing meaningful to compare against (`latest` missing or `isLatest`). */
  changePct: number | null;
}

@Component({
  selector: 'app-trading-dashboard',
  standalone: true,
  imports: [CommonModule, InfoTipDirective],
  template: `
    @if (!trading.configured) {
      <div class="notice">
        <strong>Supabase ist noch nicht konfiguriert.</strong>
        <p>Die Trading-Simulation benötigt dieselbe Supabase-Verbindung wie oben beschrieben.</p>
      </div>
    } @else {
      <!-- ── Fixed notification bell — floats top-right, outside tab flow ── -->
      <button
        type="button"
        class="notif-bell"
        (click)="openNotifPanel()"
        title="Benachrichtigungen — alle gesendeten Push-Notifications der Trading-Engine"
        aria-label="Benachrichtigungen öffnen"
      >
        <!-- Outline bell SVG — no emoji, scales cleanly at any DPI -->
        <svg class="notif-bell-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 2.5a5.5 5.5 0 0 1 5.5 5.5c0 3.5 1 4.5 1.5 5H3c.5-.5 1.5-1.5 1.5-5A5.5 5.5 0 0 1 10 2.5Z"/>
          <path d="M8.5 15.5a1.5 1.5 0 0 0 3 0"/>
        </svg>
        @if (unreadCount() > 0) {
          <span class="notif-badge">{{ unreadCount() > 9 ? '9+' : unreadCount() }}</span>
        }
      </button>

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
        <button
          type="button"
          class="tab"
          [class.active]="activeTab() === 'analysis'"
          (click)="activeTab.set('analysis')"
          title="Vordefinierte SQL-Analysen über alle abgeschlossenen Trades — Trefferquote, Trailing Stop, Ticker-Leaderboard, Fear &amp; Greed Einfluss und mehr. Jede Analyse mit automatischer Einschätzung auf Basis der Zahlen."
        >
          Analysen
        </button>
        <button
          type="button"
          class="tab"
          [class.active]="activeTab() === 'missed'"
          (click)="activeTab.set('missed')"
          title="Fälle, in denen die Heuristik kaufen wollte (organischer Hype, Kurs ausreichend unter dem Mehrwochenhoch, Markt offen, keine bestehende Position) — aber alle 3 Positions-Plätze bereits belegt waren. Zeigt rein deskriptiv, was der Kurs seither gemacht hat; keine simulierte Performance-Bewertung (siehe Tab-Inhalt für die ausführliche Begründung, warum bewusst so und nicht als automatisierte Gegen-P&L-Simulation)."
        >
          Verpasste Chancen
          @if (missedOpportunities().length > 0) {
            <span class="tab-count">{{ missedOpportunities().length }}</span>
          }
        </button>
        <div class="tab-actions">
          <!-- Scan freshness -->
          <span
            class="scan-freshness muted"
            [class.scan-stale]="scanIsStale()"
            [title]="'Der Markt-Scan läuft 4× täglich an NYSE/NASDAQ-Handelstagen (Mo–Fr): 14:30, 15:00, 17:00 und 19:00 UTC (≈ 10:30, 11:00, 13:00 und 15:00 ET). Der 14:30-Scan startet direkt bei NYSE-Eröffnung (oder kurz danach) und erfasst Overnight-Gaps und frühe Momentum-Signale. Ausserhalb der Börsenzeiten und am Wochenende läuft er bewusst nicht — ein Kauf wäre beim echten Broker ohnehin nicht ausführbar. (Markt zu) im Label ist daher normal. Eine separate Funktion prüft offene Positionen alle ~30 Min. unabhängig davon.'"
          >
            @if (lastScanAt(); as t) {
              Letzter Scan: {{ t | date: 'dd.MM. HH:mm' }} ({{ scanAgeLabel() }})
              @if (scanIsStale()) { · läuft nicht — hängengeblieben? }
            } @else {
              Noch kein Scan gelaufen.
            }
          </span>
        </div>
      </div>

      <p class="muted fx-note">
        Hinweis: Aktienkurse stammen von US-Börsen und sind in USD notiert.
        Die Simulation rechnet sie mit einem echten Wechselkursmodell in CHF
        um — pro Lauf wird der aktuelle USD/CHF-Kassakurs live abgerufen
        @if (latestUsdChfRate(); as rate) {
          (zuletzt <strong>1 USD ≈ {{ rate | number: '1.4-4' }} CHF</strong>)
        }
        und auf jede Transaktion sowie jeden Portfolio-Snapshot angewendet —
        zusätzlich zur realen Devisen-Umtauschmarge von Swissquote (≈0,95&nbsp;%
        pro Transaktion, separat als Gebühr ausgewiesen). Das bildet nicht nur
        die Kosten, sondern auch das echte Währungsrisiko ab: Verschiebt sich
        der Kurs zwischen Kauf und Verkauf einer Position, wirkt sich das
        zusätzlich zur reinen Kursbewegung der Aktie auf den realisierten
        Gewinn/Verlust aus — genau wie bei einem echten Swissquote-Konto in CHF.
        Portfoliowert, Gebühren &amp; realisierte Gewinne werden in CHF
        ausgewiesen, Aktienpreise bleiben in USD (so wie sie tatsächlich
        gehandelt werden).
      </p>

      @if (buyGateActive()) {
        <div class="buy-gate-banner">
          🛑 <strong>Kauf-Stop aktiv</strong> — CNN Fear &amp; Greed Index: <strong>{{ latestFearGreedScore() }}</strong> (unter 40 = Angst-Zone).
          Die Engine öffnet in diesem Zustand keine neuen Positionen.
          Bestehende Stop-Loss- und Take-Profit-Schwellen laufen weiter.
        </div>
      }

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
      <!--
        All "info box" stat cards — headline portfolio numbers AND the
        closed-trade performance metrics — live in ONE shared grid now
        (the .grid-stats CSS class) so they read as a single cohesive stats wall instead
        of two visually-disconnected rows that wrapped awkwardly at medium
        widths. The HTML comment further down still documents WHY the
        performance-metric cards are conceptually distinct (derived from
        closed trades, not just current portfolio state) — that grouping is
        now communicated through ordering/spacing rather than a separate grid.
      -->
      <div class="grid-stats">
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
            <h3>Hype-Blocks <span class="info-icon" infoTip="Anzahl Aktien, bei denen die Engine einen Erwähnungs-Anstieg als reinen, unbegründeten Hype eingestuft und deshalb BEWUSST NICHT gehandelt hat ('Pure-Hype'-Verdict). Das verhinderte Kapital, das damit nicht riskiert wurde, steht darunter — eine Wette, die nicht eingegangen wurde, ist hier ein Erfolg, kein verpasster Gewinn (zumindest, wenn die Klassifikation stimmt — siehe 'Lern-Insights' weiter unten).">ⓘ</span></h3>
            <div class="stat-value neu">{{ portfolio()?.blocked_count ?? 0 }}</div>
            <div class="stat-sub">{{ portfolio()?.blocked_capital | number: '1.2-2' }} CHF nicht riskiert</div>
          </div>
          <div class="card" [class.card-buy-gate]="buyGateActive()">
            <h3>
              Markt-Stimmung
              <span class="info-icon" infoTip="CNN Fear & Greed Index (0–100): misst die allgemeine Marktstimmung anhand von 7 Faktoren wie Volatilität, Momentum und Optionsvolumen. 0 = Extreme Angst, 100 = Extreme Gier. Werte unter 40 ('Angst') aktivieren automatisch einen Kauf-Stop: die Engine öffnet dann keine neuen Positionen, weil das systemische Risiko zu hoch ist. Bestehende Positionen (Stop-Loss / Take-Profit) laufen unverändert weiter. Quelle: CNN Business / production.dataviz.cnn.io — gratis, kein API-Key nötig.">ⓘ</span>
            </h3>
            @if (latestFearGreedScore(); as score) {
              <div class="stat-value" [class]="fearGreedClass(score)">{{ score }}</div>
              <div class="stat-sub">{{ fearGreedLabel(score) }}</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch kein Wert erfasst (ab nächstem Scan).</div>
            }
          </div>
        <!--
          Performance metrics derived from closed trades — these are what
          actually answer "is the strategy any good", which raw P&L alone
          doesn't: a high win rate with tiny wins and rare huge losses (or
          vice versa) looks identical in the headline number above. Kept in
          the SAME .grid-stats grid as the headline cards above (just later
          in reading order) so the whole "info box" section groups together
          as one wall of stats rather than fragmenting into separate grids.
        -->
          <div class="card">
            <h3>Trefferquote <span class="info-icon" infoTip="Anteil der bereits abgeschlossenen (verkauften) Trades, die mit Gewinn endeten. Sagt für sich allein noch nichts über die Höhe von Gewinnen/Verlusten aus — siehe daneben.">ⓘ</span></h3>
            @if (winRate(); as wr) {
              <div class="stat-value" [class.pos]="wr >= 50" [class.neg]="wr < 50">{{ wr | number: '1.0-0' }}%</div>
              <div class="stat-sub">{{ winCount() }} Gewinner · {{ lossCount() }} Verlierer von {{ closedTrades().length }} geschlossenen Trades</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch keine geschlossenen Trades.</div>
            }
          </div>
          <div class="card">
            <h3>Ø Gewinn / Ø Verlust <span class="info-icon" infoTip="Wie viel im Schnitt bei einem gewonnenen bzw. verlorenen Trade heraus­kommt. Wichtig im Zusammenspiel mit der Trefferquote: Eine hohe Trefferquote mit vielen kleinen Gewinnen und seltenen, riesigen Verlusten kann unterm Strich trotzdem ein Verlustgeschäft sein (und umgekehrt).">ⓘ</span></h3>
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
            <h3>Max. Drawdown <span class="info-icon" infoTip="Der grösste Rückgang vom bisherigen Höchststand des Portfoliowerts bis zum darauffolgenden Tiefpunkt — zeigt, wie schmerzhaft die schlimmste bisherige Durststrecke war, selbst wenn die Gesamtbilanz am Ende positiv ausfällt. Ein Standard-Risikomass aus der Finanzwelt.">ⓘ</span></h3>
            @if (maxDrawdownPct(); as dd) {
              <div class="stat-value neg">−{{ dd | number: '1.1-1' }}%</div>
              <div class="stat-sub">grösster Rückgang vom bisherigen Höchststand des Portfoliowerts</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch zu wenige Datenpunkte.</div>
            }
          </div>
          <div class="card">
            <h3>Volatilität <span class="info-icon" infoTip="Standardabweichung der Schwankungen des Portfoliowerts zwischen aufeinanderfolgenden Snapshots — ein Standard-Risikomass: hohe Werte bedeuten ein 'ruppigeres' Auf und Ab auf dem Weg zum Endergebnis, niedrige Werte einen ruhigeren Verlauf. Ergänzt den Max. Drawdown (der zeigt nur den schlimmsten EINZELNEN Einbruch, nicht wie unruhig der gesamte Verlauf war).">ⓘ</span></h3>
            @if (volatilityPct(); as vol) {
              <div class="stat-value">±{{ vol | number: '1.1-1' }}%</div>
              <div class="stat-sub">Standardabweichung der Wertänderungen zwischen Snapshots</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Noch zu wenige Datenpunkte.</div>
            }
          </div>
          <div class="card">
            <h3>Ø Haltedauer <span class="info-icon" infoTip="Wie lange eine Position im Schnitt gehalten wird, bevor sie verkauft wird — egal ob durch Take-Profit, Stop-Loss oder einen Zwischen-Check. Kurze Haltedauern bei volatilen Aktien können auf 'Lärm' statt echte Trends hindeuten.">ⓘ</span></h3>
            @if (avgHoldingHours(); as h) {
              <div class="stat-value">{{ formatHoldingDuration(h) }}</div>
              <div class="stat-sub">über alle verknüpften Buy→Sell-Paare hinweg</div>
            } @else {
              <div class="stat-value muted">—</div>
              <div class="stat-sub">Erfordert verknüpfte Trades (ab dieser Version geloggt).</div>
            }
          </div>
        </div>

        <!--
          Deliberately NOT in a .grid-mid (2fr/1fr) row alongside the chart
          anymore — "Watchlist & Signale" grew to 7 columns (Ticker, Typ,
          Preis, Erwähnungen, Hype, Stimmung, Verdict) and a 1fr-wide slot
          squeezed it into an unreadably cramped table. Both cards now get
          the FULL container width as their own rows: the chart actually
          benefits too (a wide line chart reads better than a squeezed one),
          and the table finally has room to breathe without horizontal
          scrolling or truncation.
        -->
        <div class="card">
            <h3>
              Portfolioentwicklung vs. SPY
              <span class="info-icon" infoTip="Die blaue Linie ist der Wert unseres simulierten Portfolios über die Zeit, die gestrichelte graue Linie das gleiche Startkapital einfach im Aktienindex-Fonds SPY (S&P 500) angelegt — beide auf denselben Startwert normiert, damit der Vergleich fair ist. Die rötliche Fläche zeigt den 'Drawdown' (Abstand vom bisherigen Höchststand); Dreiecke markieren Käufe (▲) und Verkäufe (▼), grün/rot je nach Ergebnis. Liegt die blaue Linie unter der grauen, hätte ein simpler Indexfonds besser abgeschnitten als die aktive Strategie.">ⓘ</span>
              <button type="button" class="chart-mode-toggle" (click)="toggleChartMode()" title="Zwischen absoluten CHF-Beträgen und prozentualer Veränderung seit Start umschalten — letzteres macht 'schlägt die Strategie den Index?' direkt ablesbar, ohne im Kopf umzurechnen.">
                {{ chartMode() === 'value' ? 'In % seit Start anzeigen' : 'In CHF anzeigen' }}
              </button>
            </h3>
            <!-- Time-range selector -->
            <div class="chart-range-bar">
              @for (r of chartRanges; track r.value) {
                <button
                  type="button"
                  class="chart-range-btn"
                  [class.active]="chartRange() === r.value"
                  (click)="setChartRange(r.value)"
                  [title]="r.title"
                >{{ r.label }}</button>
              }
            </div>
            <div class="chart-wrap">
              <canvas #chartCanvas></canvas>
              @if (balanceHistory().length === 0) {
                <p class="muted chart-empty">Noch keine Auswertung gelaufen.</p>
              }
              @if (balanceHistory().length > 0 && chartFilteredHistory().length === 0) {
                <p class="muted chart-empty">Keine Daten im gewählten Zeitraum.</p>
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
                <h4 class="subsection-title">
                  Aktien
                  <span class="info-icon" infoTip="Einzelaktien — die einzigen Titel, die diese Engine kauft. 'Typ: ?' bedeutet: die Klassifikation (direkt von Yahoo Finance, nicht geraten) steht für diesen Ticker noch aus und folgt automatisch beim nächsten Scan, an dem er beteiligt ist.">ⓘ</span>
                </h4>
                @if (sortedStockSignals().length === 0) {
                  <p class="muted">Keine Aktien passen zum Filter „{{ signalFilter() }}“.</p>
                } @else {
                  <ng-container [ngTemplateOutlet]="signalTable" [ngTemplateOutletContext]="{ rows: sortedStockSignals() }"></ng-container>
                }
                <h4 class="subsection-title">
                  ETFs
                  <span class="info-icon" infoTip="ETFs werden hier separat ausgewiesen, aber NICHT gehandelt: die Engine verweigert den Kauf jedes Tickers, den Yahoo Finance selbst als ETF klassifiziert (instrumentType = 'ETF') — unabhängig davon, ob er zufällig die 'Organisch'-Heuristik erfüllen würde. Sie tauchen trotzdem in der Watchlist auf, weil ein paar breite Index-ETFs (SPY, QQQ, VOO) hier entdeckt wurden, BEVOR der Discovery-Filter dafür existierte; sie fallen mit der Zeit von selbst aus der aktiven Liste. Auch inhaltlich macht eine ETF-Bewertung über dieselbe Heuristik wenig Sinn — ihre Erwähnungs-Spitzen spiegeln eher die allgemeine Marktstimmung als ticker-spezifischen Hype, und SPY dient diesem Dashboard zugleich als Vergleichs-Benchmark.">ⓘ</span>
                </h4>
                @if (sortedEtfSignals().length === 0) {
                  <p class="muted">Aktuell keine ETFs in der Watchlist.</p>
                } @else {
                  <ng-container [ngTemplateOutlet]="signalTable" [ngTemplateOutletContext]="{ rows: sortedEtfSignals() }"></ng-container>
                }
              }
            }
        </div>

        <ng-template #signalTable let-rows="rows">
          <table class="mobile-card-table">
            <thead>
              <tr>
                <th class="sortable" [class.sorted]="signalSortColumn() === 'ticker'" (click)="toggleSignalSort('ticker')">
                  Ticker <span class="sort-indicator">{{ signalSortIndicator('ticker') }}</span>
                </th>
                <th>
                  Typ
                  <span class="info-icon" infoTip="Aktie/ETF, direkt von Yahoo Finance übernommen (meta.instrumentType) — keine Schätzung. '?' = für diesen Ticker noch nicht erfasst, wird beim nächsten Scan nachgetragen.">ⓘ</span>
                </th>
                <th class="sortable" [class.sorted]="signalSortColumn() === 'price'" (click)="toggleSignalSort('price')">
                  Preis (USD) <span class="sort-indicator">{{ signalSortIndicator('price') }}</span>
                </th>
                <th class="sortable" [class.sorted]="signalSortColumn() === 'mention_count'" (click)="toggleSignalSort('mention_count')">
                  Erwähnungen <span class="sort-indicator">{{ signalSortIndicator('mention_count') }}</span>
                </th>
                <th class="sortable" [class.sorted]="signalSortColumn() === 'hype_score'" (click)="toggleSignalSort('hype_score')">
                  Hype <span class="sort-indicator">{{ signalSortIndicator('hype_score') }}</span>
                  <span class="info-icon" infoTip="Misst, wie ungewöhnlich oft eine Aktie GERADE JETZT in Reddit/StockTwits erwähnt wird, verglichen mit ihrem üblichen Niveau (statistischer Z-Score, auf 0–100 skaliert). Hoch = aktuell viel Gerede — sagt für sich allein noch nichts darüber aus, ob das Gerede berechtigt ist (das entscheidet erst das 'Verdict'). Standard-Sortierung dieser Tabelle: absteigend nach Hype, weil das den 'lautesten' Tickern zuerst Aufmerksamkeit gibt.">ⓘ</span>
                </th>
                <th>
                  Stimmung
                  <span class="info-icon" infoTip="Wie die breite Trading-Crowd auf StockTwits diesen Ticker GERADE JETZT einschätzt — Anteil bullish vs. bearish getaggter Nachrichten (mind. 5 nötig, sonst '–'). Dient als Korrelations-Check zum Reddit-Hype: bestätigt die breitere Masse einen Anstieg, oder wirkt er einseitig fabriziert? Der Balken ist bei 50% zentriert: wächst er nach RECHTS (grün), überwiegt Bullish-Stimmung — nach LINKS (rot), überwiegt Bearish-Stimmung. Fliesst direkt in das 'Verdict' ein (siehe dort): u. a. kann ein lauter, aber mehrheitlich bearish kommentierter Anstieg als 'Pure-Hype' geblockt werden, selbst wenn der Kurs kurzzeitig mitzieht.">ⓘ</span>
                </th>
                <th class="sortable" [class.sorted]="signalSortColumn() === 'verdict'" (click)="toggleSignalSort('verdict')">
                  Verdict <span class="sort-indicator">{{ signalSortIndicator('verdict') }}</span>
                  <span class="info-icon" infoTip="Versucht zu unterscheiden, ob ein Erwähnungs-Anstieg von echter Kursbewegung & Stimmung begleitet wird ('Organisch' = handelbar) oder nur heisse Luft ist ('Spike' = verdächtig, wird beobachtet aber nicht gehandelt; 'Geblockt' = als reiner Hype eingestuft, kein Trade). Sortierung ordnet nach Handelbarkeit: Organisch → Spike → Geblockt.">ⓘ</span>
                </th>
              </tr>
            </thead>
            <tbody>
              @for (s of rows; track s.id) {
                <tr [title]="s.reason">
                  <td class="ticker" data-label="Ticker">
                    {{ s.ticker }}
                    @if (s.yf_trending) {
                      <span class="badge badge-yf" title="Aktuell auch auf Yahoo Finance (US) als Trending gelistet — unabhängige Bestätigung, dass der Ticker gerade breit beachtet wird.">🔥 YF</span>
                    }
                    @if (s.finviz_news) {
                      <span class="badge badge-finviz" title="Ticker aktuell in FinViz-Mainstream-Nachrichten erwähnt. Hinweis: News hinkt Reddit-Hype bei Meme-Stocks typischerweise 1–3 Tage hinterher — Abwesenheit dieses Badges ist kein Warnsignal. Präsenz erhöht aber die Gesamtüberzeugung, besonders bei catalyst-getriebenen Moves.">📰 News</span>
                    }
                  </td>
                  <td data-label="Typ"><span class="badge" [class]="signalTypeClass(s)">{{ signalTypeLabel(s) }}</span></td>
                  <td data-label="Preis (USD)">{{ s.price | number: '1.2-2' }}</td>
                  <td data-label="Erwähnungen">{{ s.mention_count }}</td>
                  <td data-label="Hype">
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
                  <td data-label="Stimmung" [title]="sentimentTooltip(s)">
                    @if (s.sentiment_ratio === null) {
                      <span class="sent-na">– (zu wenig Daten)</span>
                    } @else {
                      <div class="sent-wrap">
                        <div class="sent-track">
                          <span class="sent-center-tick"></span>
                          <span
                            class="sent-fill"
                            [class.bull]="s.sentiment_ratio >= 0.5"
                            [class.bear]="s.sentiment_ratio < 0.5"
                            [style.width.%]="sentimentFillPct(s.sentiment_ratio)"
                          ></span>
                        </div>
                        <span class="sent-label" [class.bull-text]="s.sentiment_ratio >= 0.5" [class.bear-text]="s.sentiment_ratio < 0.5">
                          <span class="icon">{{ s.sentiment_ratio >= 0.5 ? '▲' : '▼' }}</span>{{ s.sentiment_ratio | percent: '1.0-0' }}
                        </span>
                      </div>
                    }
                  </td>
                  <td data-label="Verdict"><span class="badge" [class]="verdictClass(s)">{{ verdictLabel(s) }}</span></td>
                </tr>
              }
            </tbody>
          </table>
        </ng-template>

        <div class="grid-mid grid-mid-reverse">
          <div class="card">
            <h3>
              Kapitalverteilung auf offene Positionen
              <span class="info-icon" infoTip="Zeigt, wie das aktuell INVESTIERTE Kapital (nicht das gesamte Portfolio inkl. Cash) auf die offenen Positionen verteilt ist — eine grosse Schieflage hier bedeutet 'Klumpenrisiko': fällt genau dieser eine Titel, trifft es das Depot überproportional hart.">ⓘ</span>
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
              <span class="info-icon" infoTip="Wie viel des Portfolios ist gerade als Cash 'in Wartestellung', wie viel steckt in offenen Positionen? Ein durchgehend hoher Cash-Anteil kann heissen, dass die Heuristik selten ein 'organic'-Signal findet — was bei der jetzt strengeren 5-Signale-Klassifikation durchaus erwartbar ist (siehe Lern-Insights).">ⓘ</span>
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
                  <div class="pos-detail pos-trailing-info">
                    @if (positionView(p).trailingStopPctFromEntry > 0) {
                      <span class="pos-trailing-locked" title="Der Trailing Stop ist hochgewandert und liegt jetzt über dem Einstiegspreis — ein Exit wäre jetzt profitabel.">
                        🔒 Stop gesichert bei {{ positionView(p).trailingStopPrice | number: '1.2-2' }} USD
                        (+{{ positionView(p).trailingStopPctFromEntry * 100 | number: '1.1-1' }}% über Einstieg)
                      </span>
                    } @else {
                      <span class="muted">
                        Trailing Stop bei {{ positionView(p).trailingStopPrice | number: '1.2-2' }} USD
                        ({{ positionView(p).trailingStopPctFromEntry * 100 | number: '1.1-1' }}% ab Einstieg)
                        @if (positionView(p).highSinceEntry > p.entry_price) {
                          · Hoch {{ positionView(p).highSinceEntry | number: '1.2-2' }} USD
                        }
                      </span>
                    }
                    @if (positionView(p).distanceToStop !== null) {
                      <span class="muted"> · Abstand zum Stop: {{ positionView(p).distanceToStop! * 100 | number: '1.1-1' }}%</span>
                    }
                  </div>
                  @if (positionView(p).changePct !== null) {
                    <div class="exit-bar-wrap"
                         [title]="'Take-Profit +' + (takeProfit * 100) + '% ab Einstieg · Hard-Stop ' + (hardStop * 100) + '% ab Einstieg (unbedingter Kapitalboden). Trailing Stop bei ' + (positionView(p).trailingStopPrice | number: '1.2-2') + ' USD (' + (positionView(p).trailingStopPctFromEntry * 100 | number: '1.1-1') + '% ab Einstieg) — greift nur, wenn die Position nicht mehr kaufwürdig ist (organic + im Dip), sonst wird gehalten statt verkauft.'">
                      <div class="exit-bar-bg">
                        <!-- Zero line: dynamically positioned via exitBarPosition so it
                             tracks the "break-even" point correctly as the trailing stop
                             moves up. The hardcoded CSS fallback no longer applies. -->
                        <div class="exit-bar-zero"
                             [style.left.%]="exitBarPosition(0, positionView(p).trailingStopPctFromEntry)"></div>
                        <div
                          class="exit-bar-marker"
                          [style.left.%]="exitBarPosition(positionView(p).changePct!, positionView(p).trailingStopPctFromEntry)"
                          [style.background]="positionView(p).changePct! >= 0 ? '#1a8a3c' : '#c0392b'"
                        ></div>
                      </div>
                      <div class="exit-bar-labels">
                        <span [class.pos]="positionView(p).trailingStopPctFromEntry > 0">
                          Stop {{ positionView(p).trailingStopPctFromEntry * 100 | number: '1.1-1' }}%
                        </span>
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
              <span class="info-icon" infoTip="Aggregiert alle ABGESCHLOSSENEN Trades pro Ticker — 'welche Aktien haben unterm Strich Geld gebracht oder gekostet, nicht nur bei ihrem besten/schlechtesten Einzeltrade?'. Sortiert nach Gesamtbeitrag zum realisierten Ergebnis: die grössten Gewinner oben, die grössten Bremsen unten.">ⓘ</span>
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
              <span class="info-icon" infoTip="Diese Tabellen vergleichen, was die Engine beim Kauf über eine Aktie 'dachte' (Verdict, Hype-/Z-Score) mit dem tatsächlichen Ergebnis des Trades. So lässt sich nachvollziehen, ob die Klassifikations-Schwellenwerte sinnvoll sind oder angepasst werden sollten — datenbasiert statt aus dem Bauch heraus.">ⓘ</span>
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
                    <span class="info-icon" infoTip="Die Engine stuft jede Aktie beim Scan als 'organisch' (handelbar), 'spike' (verdächtig, wird nur beobachtet) oder 'pure-hype' (blockiert) ein. Hier siehst du, ob diese Einschätzung beim jeweiligen Trade auch tatsächlich gestimmt hat.">ⓘ</span>
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
                    <span class="info-icon" infoTip="Der Z-Score misst, wie ungewöhnlich die Erwähnungszahl einer Aktie gerade verglichen mit ihrem üblichen Niveau ist (z.B. z=3 bedeutet 'dreimal so weit vom Durchschnitt entfernt wie normal'). Hier zeigt sich, ob besonders starke Spikes eher gute oder eher schlechte Trades waren — also ob 'viral' eher früh-Signal oder später Hype-Gipfel ist.">ⓘ</span>
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
                    <span class="info-icon" infoTip="Vergleicht die Trefferquote pro Verdict zwischen der chronologisch ersten und zweiten Hälfte aller verknüpften, abgeschlossenen Trades. Bewusst nur zwei grobe Zeit-Buckets statt einer geglätteten Trendlinie — bei den realistisch niedrigen Trade-Volumina dieser Strategie wäre eine glatte Kurve grösstenteils Rauschen, das wie ein Signal aussieht.">ⓘ</span>
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
                    <th>Brutto (CHF)</th>
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
                      <td
                        class="nowrap"
                        [title]="
                          t.usd_chf_rate !== null
                            ? ((t.shares * t.price | number: '1.2-2') + ' USD, umgerechnet zu Kurs 1 USD ≈ ' + (t.usd_chf_rate | number: '1.4-4') + ' CHF')
                            : 'Wechselkurs für diese (ältere) Transaktion nicht erfasst (vor Einführung des FX-Modells, 1 USD ≈ 1 CHF angenommen).'
                        "
                      >
                        {{ t.gross_amount | number: '1.2-2' }}
                        @if (t.usd_chf_rate !== null) { <span class="muted fee-fx-hint">CHF</span> }
                      </td>
                      <td class="nowrap">
                        @if (t.realized_pnl !== null) {
                          <span [class.pos]="t.realized_pnl >= 0" [class.neg]="t.realized_pnl < 0">
                            {{ t.realized_pnl >= 0 ? '+' : '' }}{{ t.realized_pnl | number: '1.2-2' }} CHF
                          </span>
                          @if (buyForSell(t); as buy) {
                            <div
                              class="muted pnl-buy-hint"
                              [title]="'Position eröffnet am ' + (buy.created_at | date: 'dd.MM.yy HH:mm') + ' zu ' + (buy.price | number: '1.2-2') + ' USD/Stk.'"
                            >
                              eingekauft für {{ buy.gross_amount | number: '1.2-2' }} CHF
                            </div>
                          }
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

      <!--
        "Verpasste Chancen": Antwort auf die Frage "übersieht unsere Heuristik
        gute Trades, weil das Portfolio voll war?". Bewusst NICHT als
        automatisierte Gegen-P&L-Simulation umgesetzt (siehe ausführliche
        Begründung im info-icon-Tooltip unten und in MissedOpportunityView) —
        eine pfadgetreue "hätte Take-Profit oder Stop-Loss zuerst gegriffen?"-
        Simulation wäre faktisch eine zweite Handels-Engine nur für die
        Analyse, mit allen Stolpersteinen der echten (Gebühren, FX-Kurse,
        Handelszeiten) und einem Rauschen-zu-Signal-Verhältnis, das bei der
        aktuellen Datenmenge schlechter wäre als bei den ohnehin schon mit
        Vorsicht zu geniessenden v3/v5-Performance-Views. Stattdessen rein
        deskriptiv: "hier ist, was der Kurs seither tatsächlich gemacht hat" —
        durch reines Verknüpfen mit den ohnehin geladenen aktuellen
        Watchlist-Signalen, ohne zusätzliche API-Aufrufe oder Cron-Jobs.
      -->
      <!-- ── Analysen-Tab ───────────────────────────────────────────────── -->
      <div [hidden]="activeTab() !== 'analysis'" class="tx-wide">
        <div class="card">
          <h3>Analysen</h3>

          <!-- Query selector + action buttons -->
          <div class="analysis-controls">
            <select
              class="analysis-select"
              [value]="selectedAnalysisId()"
              (change)="onAnalysisQueryChange($any($event.target).value)"
            >
              @for (q of ANALYSIS_QUERIES; track q.id) {
                <option [value]="q.id">{{ q.label }}</option>
              }
            </select>
            <button
              type="button"
              class="btn-run"
              [class.btn-run-loading]="analysisExecuting()"
              [disabled]="analysisExecuting()"
              (click)="executeSelectedAnalysis()"
              title="Führt die Analyse gegen den kompletten Transaktions-Log in der Datenbank aus — nicht nur die letzten 50 gecachten Einträge."
            >
              @if (analysisExecuting()) {
                <span class="btn-run-spinner"></span> Wird ausgeführt…
              } @else {
                ▶ Ausführen
              }
            </button>
            <button type="button" class="btn-sql" (click)="openSqlDialog()" title="Zeigt den SQL-Code, der dieser Analyse entspricht">
              SQL
            </button>
          </div>

          <p class="analysis-desc muted">{{ selectedQuery().description }}</p>

          <!-- Data source indicator -->
          <div class="analysis-source" [class.analysis-source-live]="analysisAllTxs() !== null">
            @if (analysisAllTxs() !== null) {
              ✓ Live-Daten · {{ analysisSourceLabel() }}
            } @else {
              ⏳ {{ analysisSourceLabel() }} · <em>„Ausführen"</em> für vollständige Ergebnisse
            }
          </div>

          <!-- Interpretation -->
          @if (analysisRows().length > 0) {
            <div class="analysis-insight" [class.insight-pos]="analysisInterpretation().color === 'pos'" [class.insight-neg]="analysisInterpretation().color === 'neg'" [class.insight-neutral]="analysisInterpretation().color === 'neutral'">
              <span class="insight-icon">
                @if (analysisInterpretation().color === 'pos') { ✅ }
                @else if (analysisInterpretation().color === 'neg') { ⚠️ }
                @else { 💡 }
              </span>
              {{ analysisInterpretation().text }}
            </div>
          }

          <!-- Results table -->
          @if (analysisRows().length === 0) {
            <p class="muted" style="margin-top: 1rem;">Noch keine Daten für diese Analyse.</p>
          } @else {
            <div class="tx-table-wrap" style="margin-top: 0.75rem;">
              <table class="tx-table analysis-table">
                <thead>
                  <tr>
                    @for (col of selectedQuery().columns; track col.key) {
                      <th [class.num-col]="col.format !== 'text'">{{ col.label }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of analysisRows(); track $index) {
                    <tr>
                      @for (col of selectedQuery().columns; track col.key) {
                        <td
                          [class.num-col]="col.format !== 'text'"
                          [class.pos]="col.format === 'currency_chf' && +row[col.key]! > 0"
                          [class.neg]="col.format === 'currency_chf' && +row[col.key]! < 0"
                        >
                          {{ formatAnalysisCell(row[col.key], col.format) }}
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      </div>

      <!-- ── Notification Center ─────────────────────────────────────────── -->
      @if (notifPanelOpen()) {
        <!-- Backdrop: click-to-close, blurs background -->
        <div class="notif-backdrop" (click)="closeNotifPanel()" aria-hidden="true"></div>

        <!-- Slide-over panel -->
        <aside class="notif-panel" role="dialog" aria-label="Benachrichtigungen" aria-modal="true">

          <!-- Header -->
          <div class="notif-panel-head">
            <div class="notif-panel-title">
              <span>Benachrichtigungen</span>
              @if (unreadCount() > 0) {
                <span class="notif-unread-count">{{ unreadCount() }} neu</span>
              }
            </div>
            <div class="notif-head-actions">
              @if (unreadCount() > 0) {
                <button
                  type="button"
                  class="notif-markall"
                  (click)="markAllNotifRead()"
                >Alle gelesen</button>
              }
              <button
                type="button"
                class="notif-panel-close"
                (click)="closeNotifPanel()"
                aria-label="Panel schliessen"
              >✕</button>
            </div>
          </div>

          <!-- Empty state -->
          @if (pushNotifications().length === 0) {
            <div class="notif-empty">
              <span class="notif-empty-icon">📭</span>
              <span class="notif-empty-title">Keine Benachrichtigungen</span>
              <span class="notif-empty-hint muted">
                Kauf-, Take-Profit- und Trailing-Stop-Meldungen erscheinen hier sobald die
                Engine das nächste Mal handelt.
              </span>
            </div>
          } @else {
            <!-- Scrollable feed -->
            <div class="notif-scroll">
              @for (group of notifGroups(); track group.label) {
                <div class="notif-day-label">{{ group.label }}</div>
                @for (n of group.items; track n.id) {
                  <div
                    class="notif-item"
                    [class]="notifItemClass(n)"
                    (click)="markNotifRead(n)"
                    (keydown.enter)="markNotifRead(n)"
                    role="button"
                    tabindex="0"
                    [attr.aria-label]="(isNotifUnread(n) ? 'Ungelesen: ' : '') + n.title"
                  >
                    <div class="notif-item-icon-wrap">
                      <span class="notif-item-icon">{{ notifEmoji(n) }}</span>
                    </div>
                    <div class="notif-item-body">
                      <div class="notif-item-header">
                        <span class="notif-item-title">{{ n.title }}</span>
                        <span class="notif-item-time muted">{{ relativeTime(n.created_at) }}</span>
                      </div>
                      <div class="notif-item-msg">{{ n.message }}</div>
                    </div>
                    @if (isNotifUnread(n)) {
                      <span class="notif-unread-dot" aria-hidden="true"></span>
                    }
                  </div>
                }
              }
            </div>
          }
        </aside>
      }

      <!-- SQL dialog -->
      <dialog #sqlDialog class="sql-dialog">
        <div class="sql-dialog-head">
          <strong>SQL — {{ selectedQuery().label }}</strong>
          <button type="button" class="sql-dialog-close" (click)="openSqlDialogClose()">✕</button>
        </div>
        <p class="sql-dialog-note muted">Diese Abfrage entspricht dem, was die TypeScript-Compute-Funktion im Browser berechnet. In der Supabase SQL-Konsole direkt ausführbar.</p>
        <pre class="sql-code">{{ selectedQuery().sql }}</pre>
      </dialog>

      <div [hidden]="activeTab() !== 'missed'" class="tx-wide">
        <div class="card">
          <h3>
            Verpasste Chancen
            <span class="info-icon" infoTip="Hier landen Ticker, bei denen die Heuristik kaufen wollte — organischer Hype, Kurs ausreichend unter dem Mehrwochenhoch gefallen, Markt offen, noch keine eigene Position — aber alle 3 Positions-Plätze (MAX_POSITIONS) bereits belegt waren. Das ist die EINZIGE 'nicht gekauft'-Situation, die wirklich 'das System wollte handeln, konnte aber nicht' bedeutet (im Unterschied zu 'die Heuristik selbst sagte nein', was eine ganz andere Frage testet). Die Spalte 'Veränderung seither' vergleicht den Kurs von damals rein informativ mit dem aktuellsten bekannten Kurs aus der Watchlist — KEINE simulierte Performance-Bewertung mit Gebühren/FX/Take-Profit-Logik: eine pfadgetreue Simulation bräuchte praktisch eine zweite Handels-Engine, deren Ergebnisse bei der aktuellen Datenmenge ohnehin mit Vorsicht zu geniessen wären. Diese Tabelle überlässt die Interpretation bewusst dem menschlichen Auge.">ⓘ</span>
          </h3>
          @if (missedOpportunities().length === 0) {
            <p class="muted">
              Noch keine verpassten Chancen erfasst — entweder lief das Portfolio noch nie voll
              (aktuell {{ positions().length }}/{{ maxPositions }} Positionen offen), oder es gab seit Einführung
              dieser Auswertung schlicht noch keinen Fall, in dem die Heuristik bei voller Bank
              kaufen wollte.
            </p>
          } @else {
            <input
              type="text"
              class="table-filter"
              placeholder="Nach Ticker filtern…"
              [value]="missedFilter()"
              (input)="missedFilter.set($any($event.target).value)"
            />
            @if (filteredMissedOpportunityViews().length === 0) {
              <p class="muted">Kein Ticker passt zum Filter „{{ missedFilter() }}”.</p>
            } @else {
              <div class="tx-table-wrap">
                <table class="tx-table">
                  <colgroup>
                    <col class="col-date" />
                    <col class="col-ticker" />
                    <col class="col-price" />
                    <col class="col-shares" />
                    <col class="col-shares" />
                    <col class="col-pnl" />
                    <col class="col-reason" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Ticker</th>
                      <th>Kurs damals (USD)</th>
                      <th>
                        Dip
                        <span class="info-icon" infoTip="Wie weit der Kurs zu diesem Zeitpunkt unter seinem Mehrwochenhoch lag — die Schwelle, ab der ein Swing-Einstieg überhaupt in Frage kommt (DIP_THRESH).">ⓘ</span>
                      </th>
                      <th>Hype</th>
                      <th>
                        Veränderung seither
                        <span class="info-icon" infoTip="Rein informativer Vergleich mit dem aktuellsten bekannten Kurs aus der Watchlist — KEINE simulierte Trade-Performance (keine Gebühren, kein FX, keine Take-Profit/Stop-Loss-Logik). 'noch zu früh' = dieser Eintrag ist selbst der aktuellste bekannte Kurs für diesen Ticker. 'nicht mehr beobachtet' = der Ticker steht nicht mehr auf der aktiven Watchlist.">ⓘ</span>
                      </th>
                      <th>Begründung</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of filteredMissedOpportunityViews(); track m.signal.id) {
                      <tr [title]="m.signal.reason">
                        <td class="nowrap">{{ m.signal.scanned_at | date: 'dd.MM.yy HH:mm' }}</td>
                        <td class="ticker">{{ m.signal.ticker }}</td>
                        <td class="nowrap">{{ m.signal.price | number: '1.2-2' }}</td>
                        <td class="nowrap">
                          @if (m.signal.drop_from_high_pct !== null) {
                            {{ m.signal.drop_from_high_pct | number: '1.1-1' }}%
                          } @else {
                            <span class="muted">—</span>
                          }
                        </td>
                        <td>
                          <div class="hype-bar-wrap">
                            <div class="hype-bar-bg">
                              <div
                                class="hype-bar-fill"
                                [style.width.%]="m.signal.hype_score"
                                [style.background]="hypeColor(m.signal.hype_score)"
                              ></div>
                            </div>
                            <span>{{ m.signal.hype_score | number: '1.0-0' }}</span>
                          </div>
                        </td>
                        <td class="nowrap">
                          @if (m.changePct !== null) {
                            <span [class.pos]="m.changePct >= 0" [class.neg]="m.changePct < 0">
                              {{ m.changePct >= 0 ? '+' : '' }}{{ m.changePct * 100 | number: '1.1-1' }}%
                            </span>
                            <span class="muted fee-fx-hint">({{ m.latest!.price | number: '1.2-2' }} USD)</span>
                          } @else if (m.isLatest) {
                            <span class="muted">noch zu früh</span>
                          } @else {
                            <span class="muted">nicht mehr beobachtet</span>
                          }
                        </td>
                        <td class="tx-reason">{{ m.signal.reason }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      .section-title { margin-top: 2rem; margin-bottom: 0.25rem; }
      /*
        One unified grid for ALL 8 "info box" stat cards (headline portfolio
        numbers + closed-trade performance metrics) — they group into a
        single, cohesive wall of stats: a clean 4-column x 2-row block on
        wide screens (was previously two visually-disconnected grids, one
        3-wide and one 4-wide-with-an-orphan-5th-card that wrapped
        awkwardly). Fixed 4 columns rather than auto-fit/minmax on purpose —
        with exactly 8 cards, 4 columns divides evenly into two tidy rows;
        auto-fit would instead produce an irregular last row (e.g. 7 + 1) on
        the now much wider dashboard. Falls back to 2, then 1 column at
        narrower widths (see the @media rules below).
      */
      .grid-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
        margin-bottom: 1rem;
      }
      @media (max-width: 1100px) {
        .grid-stats { grid-template-columns: repeat(2, 1fr); }
      }
      .grid-mid { display: grid; grid-template-columns: 2fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .grid-bot { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .grid-bot-single { grid-template-columns: 1fr; }
      /* .tx-wide: Transactions and Verpasste Chancen tabs — same width as the
         rest of the dashboard (no viewport breakout). The table scrolls
         horizontally inside its wrapper when the content is wider than the
         available space (see .tx-table-wrap below). */
      .tx-wide { /* intentionally no override — normal block flow */ }
      @media (max-width: 900px) {
        .grid-stats, .grid-mid, .grid-bot { grid-template-columns: 1fr; }
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
      /*
        Taller than before (220px → 280px): the dashboard now spans a much
        wider container, so the chart card itself is noticeably wider — a
        flat 220px height started looking stretched/thin at that width.
      */
      .chart-wrap { position: relative; height: 280px; }
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
      .badge-stock { background: #e8eef9; color: #2a5db0; }
      .badge-etf { background: #f1e8fb; color: #7c3aed; }
      .badge-unknown { background: #f0f0f0; color: #888; }
      .badge-yf { background: #fff4e0; color: #c87800; margin-left: 5px; font-size: 0.62rem; padding: 1px 5px; }
      .badge-finviz { background: #e8f4fd; color: #1a6b9a; margin-left: 5px; font-size: 0.62rem; padding: 1px 5px; }
      /* Fear & Greed buy-gate banner */
      .buy-gate-banner {
        background: #fff3cd;
        border: 1px solid #ffc107;
        border-left: 4px solid #e67e00;
        border-radius: 8px;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
        font-size: 0.88rem;
        color: #5a3e00;
        line-height: 1.5;
      }
      /* Highlight the F&G stat card when the gate is active */
      .card.card-buy-gate { border-left: 3px solid #e67e00; }
      .subsection-title { margin: 18px 0 8px; font-size: 0.92rem; color: #555; font-weight: 600; }
      .hype-bar-wrap { display: flex; align-items: center; gap: 6px; }
      .hype-bar-bg { flex: 1; background: #eee; border-radius: 4px; height: 6px; min-width: 50px; }
      .hype-bar-fill { height: 6px; border-radius: 4px; }
      /* ── "Stimmung" column: diverging bar centred on 50% ──────────────────
         Deliberately mirrors the hype-bar's visual vocabulary (thin track +
         coloured fill + number) rather than inventing a new one, but grows
         from the CENTER outward instead of from the left edge — that's what
         lets it show DIRECTION (bullish-leaning right/green vs. bearish-
         leaning left/red) and STRENGTH (how far it strays from 50/50) in a
         single glance, which a left-anchored bar couldn't represent (a 51%
         and a 95% reading would look almost identical). */
      .sent-wrap { display: flex; align-items: center; gap: 7px; min-width: 110px; }
      .sent-track { position: relative; flex: 1; background: #eee; border-radius: 4px; height: 6px; min-width: 50px; }
      .sent-center-tick { position: absolute; left: 50%; top: -2px; width: 1px; height: 10px; background: #ccc; }
      .sent-fill { position: absolute; top: 0; height: 6px; border-radius: 4px; }
      .sent-fill.bull { left: 50%; background: #2bab5e; }
      .sent-fill.bear { right: 50%; background: #d6594a; }
      .sent-label { display: inline-flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .sent-label .icon { font-size: 0.78rem; line-height: 1; }
      .sent-label.bull-text { color: #1a8a3c; }
      .sent-label.bear-text { color: #c0392b; }
      .sent-na { color: #999; font-size: 0.75rem; }
      .pos-row { padding: 10px 0; border-bottom: 1px solid #eee; }
      .pos-row:last-child { border-bottom: none; }
      .pos-row-rich { display: flex; flex-direction: column; gap: 3px; }
      .pos-head { display: flex; align-items: center; gap: 8px; }
      .pos-name { font-weight: 600; }
      .pos-detail { font-size: 0.75rem; color: #888; margin-top: 2px; }
      .pos-trailing-info { margin-top: 3px; }
      .pos-trailing-locked { font-size: 0.75rem; color: #1a8a3c; font-weight: 500; }
      .pos-summary { margin-top: 6px; font-size: 0.75rem; }
      .exit-bar-wrap { margin-top: 4px; }
      .exit-bar-bg { position: relative; background: #eee; border-radius: 4px; height: 6px; }
      .exit-bar-zero {
        position: absolute; top: -2px; bottom: -2px;
        /* left is set via [style.left.%] — dynamic per trailing-stop level */
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
      .tab-actions { margin-left: auto; display: flex; align-items: center; }
      /* Extra right-padding so the scan-freshness text doesn't collide with
         the fixed bell button (36px wide + 16px right offset + 8px gap = 60px) */
      .tab-actions { padding-right: 52px; }
      .scan-freshness { align-self: center; font-size: 0.72rem; white-space: nowrap; }
      .scan-stale { color: #d9534f; font-weight: 600; }
      .fx-note { margin: -0.5rem 0 1rem; line-height: 1.4; }
      .chart-note { margin: 0.5rem 0 0; line-height: 1.4; font-size: 0.72rem; }
      .stat-sub-inline { font-size: 0.78rem; color: #888; }
      .fee-fx-hint { font-size: 0.65rem; color: #aaa; }
      /* Secondary line under a SELL's realized P&L showing what the closed
         position originally cost — same visual weight/role as .fee-fx-hint
         above (a quiet supporting detail, not competing with the colour-coded
         headline number it sits beneath). */
      .pnl-buy-hint { font-size: 0.65rem; color: #aaa; white-space: nowrap; margin-top: 2px; }
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
      .tx-summary { margin-bottom: 0.75rem; }
      /* overflow-x: auto so the table scrolls horizontally instead of expanding
         the card when the viewport is narrower than the table's min-width. */
      .tx-table-wrap { max-height: 560px; overflow-y: auto; overflow-x: auto; }
      .tx-table { width: 100%; min-width: 680px; table-layout: fixed; border-collapse: collapse; font-size: 0.78rem; }
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

      /* ── Chart time-range selector ────────────────────────────────────────── */
      .chart-range-bar {
        display: flex;
        gap: 4px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .chart-range-btn {
        flex: 1 1 auto;
        min-width: 44px;          /* touch target */
        padding: 5px 14px;
        font-size: 0.72rem; font-weight: 600;
        border: 1px solid #e0e0e0;
        border-radius: 20px;
        background: #fafafa;
        color: #666;
        cursor: pointer;
        transition: background 0.13s, color 0.13s, border-color 0.13s;
        white-space: nowrap;
        text-align: center;
      }
      .chart-range-btn:hover { background: #f0f0f0; color: #333; border-color: #ccc; }
      .chart-range-btn.active {
        background: #ff4500;
        color: #fff;
        border-color: #ff4500;
      }

      /* ── Generic table-filter text input (watchlist + transactions) ──────── */
      .table-filter {
        display: block; width: 100%; box-sizing: border-box; margin-bottom: 0.6rem;
        padding: 6px 10px; font-size: 0.78rem; border: 1px solid #ddd; border-radius: 6px;
        background: #fff; color: #333;
      }
      .table-filter:focus { outline: none; border-color: #ff4500; box-shadow: 0 0 0 2px #ffe3d6; }
      .table-filter::placeholder { color: #aaa; }

      /* ── Watchlist / signal table: desktop layout ───────────────────────────
         .mobile-card-table switches to a card-per-row layout on narrow
         screens (see @media). On desktop it stays a regular table; these
         styles give it the same cell padding and row borders as .tx-table
         so the card's 1 rem padding is visually apparent above the header
         and below the last data row. Without this the browser defaults give
         near-zero cell padding, making the table look flush with the card. */
      .mobile-card-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
      .mobile-card-table thead th {
        text-align: left; font-size: 0.68rem; text-transform: uppercase;
        letter-spacing: .05em; color: #888; padding: 6px 8px;
        border-bottom: 2px solid #e2e2e2; white-space: nowrap;
      }
      .mobile-card-table tbody td { padding: 7px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
      .mobile-card-table tbody tr:last-child td { border-bottom: none; }

      /* ── Sortable column headers (Watchlist & Signale) ───────────────────── */
      th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
      th.sortable:hover { color: #ff4500; }
      th.sortable.sorted { color: #ff4500; }
      .sort-indicator { display: inline-block; width: 0.9em; font-size: 0.7em; margin-left: 2px; }

      /* ── Second grid-mid row: allocation bars + cash-vs-invested chart ───── */
      .grid-mid-reverse { grid-template-columns: 1fr 1fr; }
      .chart-wrap-small { height: 220px; }
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

      /* ═══════════════════════════════════════════════════════════════════
         MOBILE (≤ 640 px) — responsive layout, card tables, smaller chrome
         ═══════════════════════════════════════════════════════════════════ */
      @media (max-width: 640px) {

        /* ── Grids ── */
        .grid-stats, .grid-mid, .grid-bot, .grid-mid-reverse {
          grid-template-columns: 1fr;
        }

        /* ── Charts: shorter on small screens ── */
        .chart-wrap { height: 200px; }
        .chart-wrap-small { height: 160px; }

        /* ── Chart mode toggle: shrink and wrap below title ── */
        .chart-mode-toggle { margin-left: 0; font-size: 0.68rem; padding: 3px 10px; }

        /* ── Tab bar: scrollable, don't wrap ── */
        .tabs { overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
        .tab { flex-shrink: 0; padding: 0.5rem 0.7rem; font-size: 0.78rem; }
        .scan-freshness { display: none; } /* too long for narrow tab bar */

        /* ── Card padding ── */
        .card { padding: 0.75rem; }
        .card h3 { font-size: 0.7rem; }

        /* ── Stat values ── */
        .stat-value { font-size: 1.15rem; }

        /* ── Table card layout for .mobile-card-table ───────────────────────
           Each <tr> becomes a standalone card; <thead> hides; each <td>
           renders as a label: value row using the data-label attribute.
           The Ticker cell (first cell) acts as the card title — full width,
           no label pseudo-element, slightly larger. ── */
        .mobile-card-table thead { display: none; }
        .mobile-card-table tr {
          display: block;
          border: 1px solid #e8e8e8;
          border-radius: 8px;
          margin-bottom: 0.6rem;
          padding: 0.5rem 0.75rem;
          background: #fff;
        }
        .mobile-card-table tr:last-child { margin-bottom: 0; }
        .mobile-card-table td {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          border-bottom: 1px solid #f4f4f4;
          padding: 5px 0;
          font-size: 0.8rem;
        }
        .mobile-card-table td:last-child { border-bottom: none; }
        .mobile-card-table td::before {
          content: attr(data-label);
          font-size: 0.68rem;
          font-weight: 600;
          color: #aaa;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          flex-shrink: 0;
          white-space: nowrap;
        }
        /* Ticker cell: full-width title row, no label, bigger text */
        .mobile-card-table td.ticker {
          display: block;
          font-size: 1rem;
          border-bottom: 1px solid #ebebeb;
          padding: 0 0 6px;
          margin-bottom: 2px;
        }
        .mobile-card-table td.ticker::before { display: none; }
        /* Bars take available width on mobile */
        .mobile-card-table .hype-bar-wrap,
        .mobile-card-table .sent-wrap { width: 100%; justify-content: flex-start; }
        .mobile-card-table .hype-bar-bg,
        .mobile-card-table .sent-track { min-width: 60px; }

        /* ── Transaction table: tighter min-width on small screens ── */
        .tx-table { min-width: 540px; }

        /* ── Section title ── */
        .section-title { font-size: 1.1rem; }
      }

      /* ── Very narrow (≤ 400 px): further tighten ── */
      @media (max-width: 400px) {
        .card { padding: 0.6rem; }
        .stat-value { font-size: 1rem; }
        .tab { padding: 0.45rem 0.55rem; font-size: 0.72rem; }
      }
    `,
    /* ── Analysis tab ───────────────────────────────────────────────────── */
    `
      .analysis-controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
      .analysis-select {
        flex: 1; min-width: 200px; padding: 0.35rem 0.6rem;
        border: 1px solid #d0d0d0; border-radius: 6px;
        font-size: 0.82rem; background: #fff; cursor: pointer;
      }

      /* ── "Ausführen" primary action button ── */
      .btn-run {
        display: inline-flex; align-items: center; gap: 0.4rem;
        padding: 0.38rem 1rem;
        background: #ff4500; color: #fff;
        border: none; border-radius: 6px;
        font-size: 0.8rem; font-weight: 600; cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s, opacity 0.15s, transform 0.1s;
        box-shadow: 0 1px 4px rgba(255,69,0,0.3);
      }
      .btn-run:hover:not(:disabled) { background: #e03d00; transform: translateY(-1px); box-shadow: 0 3px 8px rgba(255,69,0,0.35); }
      .btn-run:active:not(:disabled) { transform: translateY(0); }
      .btn-run:disabled { opacity: 0.65; cursor: not-allowed; }
      .btn-run-spinner {
        display: inline-block; width: 11px; height: 11px;
        border: 2px solid rgba(255,255,255,0.4);
        border-top-color: #fff;
        border-radius: 50%;
        animation: runSpinner 0.7s linear infinite;
      }
      @keyframes runSpinner { to { transform: rotate(360deg); } }

      /* ── "SQL" secondary button (was btn-sql) ── */
      .btn-sql {
        padding: 0.35rem 0.7rem; border: 1px solid #bbb; border-radius: 6px;
        font-size: 0.78rem; background: #f5f5f5; cursor: pointer; white-space: nowrap;
      }
      .btn-sql:hover { background: #e8e8e8; }

      /* ── Data source pill ── */
      .analysis-source {
        margin-top: 0.45rem;
        font-size: 0.72rem; color: #aaa;
      }
      .analysis-source em { font-style: normal; font-weight: 600; }
      .analysis-source.analysis-source-live { color: #1a8a3c; font-weight: 500; }
      .analysis-desc { margin: 0.5rem 0 0; font-size: 0.8rem; }
      .analysis-insight {
        margin-top: 0.75rem; padding: 0.65rem 0.85rem;
        border-radius: 8px; font-size: 0.82rem; line-height: 1.5;
        border-left: 3px solid #ccc; background: #f9f9f9;
      }
      .analysis-insight.insight-pos  { border-left-color: #1a8a3c; background: #f0faf4; }
      .analysis-insight.insight-neg  { border-left-color: #c0392b; background: #fdf5f5; }
      .analysis-insight.insight-neutral { border-left-color: #888; background: #f9f9f9; }
      .insight-icon { margin-right: 0.4rem; }
      .analysis-table th.num-col,
      .analysis-table td.num-col { text-align: right; }

      /* SQL dialog */
      .sql-dialog {
        border: 1px solid #d0d0d0; border-radius: 10px; padding: 0;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18); max-width: 720px; width: 92vw;
      }
      .sql-dialog::backdrop { background: rgba(0,0,0,0.35); }
      .sql-dialog-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0.75rem 1rem; border-bottom: 1px solid #eee; font-size: 0.88rem;
      }
      .sql-dialog-close {
        background: none; border: none; font-size: 1.1rem;
        cursor: pointer; color: #888; padding: 0 0.25rem;
      }
      .sql-dialog-close:hover { color: #333; }
      .sql-dialog-note { padding: 0.5rem 1rem 0; font-size: 0.75rem; margin: 0; }
      .sql-code {
        margin: 0; padding: 0.75rem 1rem 1rem;
        font-size: 0.75rem; line-height: 1.55; white-space: pre-wrap;
        overflow-x: auto; font-family: 'Menlo', 'Consolas', monospace;
        color: #2d3748; background: #f8f8f8;
        border-top: 1px solid #eee; border-radius: 0 0 10px 10px;
      }
    `,
    /* ── Notification Center ─────────────────────────────────────────────── */
    `
      /*
       * Fixed notification bell — top-right corner, always visible regardless
       * of scroll depth. Follows the Linear / Vercel / GitHub convention of a
       * persistent action affordance anchored to the viewport edge rather than
       * buried inside a tab row where it competes for attention with navigation.
       * z-index 990 keeps it below the panel/backdrop (1000/1001) but above
       * all regular page content.
       */
      .notif-bell {
        position: fixed;
        top: 14px; right: 16px;
        z-index: 990;
        display: flex; align-items: center; justify-content: center;
        width: 36px; height: 36px;
        background: #fff;
        border: 1px solid rgba(0,0,0,0.10);
        border-radius: 10px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.08);
        cursor: pointer;
        color: #555;
        transition: background 0.15s, box-shadow 0.15s, color 0.15s;
        padding: 0;
      }
      .notif-bell:hover {
        background: #f7f7f8;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        color: #111;
      }
      .notif-bell:active { transform: scale(0.94); }

      .notif-bell-icon { width: 18px; height: 18px; display: block; }

      /* Unread badge */
      .notif-badge {
        position: absolute; top: -4px; right: -4px;
        min-width: 16px; height: 16px;
        background: #e53935; color: #fff;
        font-size: 0.55rem; font-weight: 800;
        border-radius: 99px; padding: 0 4px;
        display: flex; align-items: center; justify-content: center;
        border: 1.5px solid #fff;
        line-height: 1; pointer-events: none;
      }

      /* ── Backdrop ─────────────────────────────────────────────────────── */
      .notif-backdrop {
        position: fixed; inset: 0; z-index: 1000;
        background: rgba(10, 10, 20, 0.28);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        animation: notifFadeIn 0.22s ease;
      }
      @keyframes notifFadeIn { from { opacity: 0; } to { opacity: 1; } }

      /* ── Panel ────────────────────────────────────────────────────────── */
      .notif-panel {
        position: fixed;
        top: 0; right: 0; bottom: 0;
        width: 380px; max-width: 100vw;
        z-index: 1001;
        background: #fff;
        display: flex; flex-direction: column;
        box-shadow: -1px 0 0 rgba(0,0,0,0.07), -6px 0 36px rgba(0,0,0,0.13);
        animation: notifSlideIn 0.26s cubic-bezier(0.4, 0, 0.2, 1);
      }
      @keyframes notifSlideIn {
        from { transform: translateX(100%); opacity: 0.85; }
        to   { transform: translateX(0);    opacity: 1;    }
      }

      /* Panel header */
      .notif-panel-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 1rem 1rem 0.85rem;
        border-bottom: 1px solid #f0f0f0;
        flex-shrink: 0;
      }
      .notif-panel-title {
        display: flex; align-items: center; gap: 0.5rem;
        font-size: 0.88rem; font-weight: 700; color: #1a1a1a;
      }
      .notif-unread-count {
        background: #2563eb; color: #fff;
        font-size: 0.6rem; font-weight: 700;
        border-radius: 20px; padding: 2px 8px;
      }
      .notif-head-actions { display: flex; align-items: center; gap: 0.35rem; }
      .notif-markall {
        background: none; border: none; cursor: pointer;
        font-size: 0.68rem; font-weight: 600; color: #2563eb;
        padding: 4px 7px; border-radius: 6px; white-space: nowrap;
        transition: background 0.12s;
      }
      .notif-markall:hover { background: #eff6ff; }
      .notif-panel-close {
        background: none; border: none; cursor: pointer;
        font-size: 0.95rem; color: #aaa;
        padding: 5px 7px; border-radius: 7px;
        line-height: 1;
        transition: background 0.12s, color 0.12s;
      }
      .notif-panel-close:hover { background: #f5f5f5; color: #333; }

      /* ── Empty state ──────────────────────────────────────────────────── */
      .notif-empty {
        flex: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 0.4rem; padding: 2.5rem 1.5rem;
        text-align: center;
      }
      .notif-empty-icon { font-size: 2.8rem; line-height: 1; }
      .notif-empty-title { font-size: 0.88rem; font-weight: 600; color: #555; margin-top: 0.25rem; }
      .notif-empty-hint { font-size: 0.76rem; line-height: 1.45; max-width: 260px; }

      /* ── Scroll container ─────────────────────────────────────────────── */
      .notif-scroll {
        flex: 1; overflow-y: auto;
        padding-bottom: 1.5rem;
        /* thin custom scrollbar */
        scrollbar-width: thin;
        scrollbar-color: #e0e0e0 transparent;
      }
      .notif-scroll::-webkit-scrollbar { width: 4px; }
      .notif-scroll::-webkit-scrollbar-track { background: transparent; }
      .notif-scroll::-webkit-scrollbar-thumb { background: #e0e0e0; border-radius: 4px; }

      /* ── Day group label ──────────────────────────────────────────────── */
      .notif-day-label {
        padding: 0.7rem 1rem 0.3rem;
        font-size: 0.62rem; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.09em; color: #bbb;
        position: sticky; top: 0; background: #fff; z-index: 1;
      }

      /* ── Notification item ────────────────────────────────────────────── */
      .notif-item {
        display: flex; align-items: flex-start; gap: 0.7rem;
        padding: 0.75rem 1rem;
        border-left: 3px solid transparent;
        transition: background 0.1s;
        cursor: pointer;
        position: relative;
      }
      .notif-item:hover { background: #fafafa; }
      .notif-item:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }

      /* Read items are de-emphasized; unread get a tint + a dot + stronger title. */
      .notif-unread { background: #f7faff; }
      .notif-unread:hover { background: #eef5ff; }
      .notif-unread-dot {
        align-self: center; flex-shrink: 0;
        width: 8px; height: 8px; border-radius: 50%;
        background: #2563eb;
      }
      /* Separator between adjacent items of same day */
      .notif-day-label + .notif-item { border-top: none; }
      .notif-item ~ .notif-item { border-top: 1px solid #f5f5f5; }

      /* Left-border accent by event type */
      .notif-type-buy            { border-left-color: #16a34a; }
      .notif-type-tp             { border-left-color: #2563eb; }
      .notif-type-interim-tp     { border-left-color: #2563eb; }
      .notif-type-stop           { border-left-color: #d97706; }
      .notif-type-interim-stop   { border-left-color: #d97706; }

      /* Icon circle */
      .notif-item-icon-wrap {
        flex-shrink: 0; width: 34px; height: 34px;
        border-radius: 50%;
        background: #f5f5f5;
        display: flex; align-items: center; justify-content: center;
        font-size: 1.05rem;
      }
      .notif-type-buy          .notif-item-icon-wrap { background: #dcfce7; }
      .notif-type-tp           .notif-item-icon-wrap,
      .notif-type-interim-tp   .notif-item-icon-wrap { background: #dbeafe; }
      .notif-type-stop         .notif-item-icon-wrap,
      .notif-type-interim-stop .notif-item-icon-wrap { background: #fef3c7; }

      /* Item content */
      .notif-item-body { flex: 1; min-width: 0; }
      .notif-item-header {
        display: flex; align-items: baseline;
        justify-content: space-between; gap: 0.5rem;
      }
      .notif-item-title {
        font-size: 0.8rem; font-weight: 600; color: #6b7280; /* read: dimmed */
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        flex: 1; min-width: 0;
      }
      .notif-unread .notif-item-title { color: #111; font-weight: 700; }
      .notif-item-time {
        font-size: 0.62rem; white-space: nowrap; flex-shrink: 0;
      }
      .notif-item-msg {
        font-size: 0.72rem; color: #666; margin-top: 3px;
        white-space: pre-line; line-height: 1.45;
      }

      @media (max-width: 420px) {
        .notif-panel { width: 100vw; }
        .scan-freshness { display: none; }
      }
    `,
  ],
})
export class TradingDashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  protected readonly trading = inject(TradingService);

  // Mirrors the constants in supabase/functions/market-scan/index.ts — shown
  // in the UI so it's clear at which thresholds a position would be closed.
  protected readonly activeTab = signal<'overview' | 'transactions' | 'missed' | 'analysis'>('overview');

  // ── Notification Center ──────────────────────────────────────────────────
  protected readonly pushNotifications = signal<PushNotificationRow[]>([]);
  protected readonly notifPanelOpen = signal(false);

  /**
   * Per-message read model (replaces the old single "last seen" timestamp that
   * marked EVERYTHING read the moment the panel opened):
   *  - `notifReadIds` — ids the user has explicitly clicked, persisted in
   *    localStorage so read state survives reloads.
   *  - `notifBaselineAt` — a fixed cut-off captured ONCE; anything created at or
   *    before it counts as already-read. This keeps existing users (migrating
   *    from the old timestamp) and fresh installs from getting a huge first-load
   *    badge. "Alle gelesen" bumps it to now.
   * A notification is UNREAD iff it is newer than the baseline AND its id is not
   * in the read set. The badge counts only those and hides at zero.
   */
  private static readonly NOTIF_READ_KEY = 'notif_read_ids';
  private static readonly NOTIF_BASELINE_KEY = 'notif_baseline_at';

  protected readonly notifBaselineAt = signal<Date>(TradingDashboardComponent.initNotifBaseline());
  protected readonly notifReadIds = signal<Set<number>>(TradingDashboardComponent.loadNotifReadIds());

  private static initNotifBaseline(): Date {
    try {
      let raw = localStorage.getItem(TradingDashboardComponent.NOTIF_BASELINE_KEY);
      if (!raw) {
        // Migrate from the old single "last seen" timestamp if present; else
        // start at "now" so a fresh user only ever sees FUTURE notifications as
        // unread, never the whole loaded history at once.
        raw = localStorage.getItem('notif_last_seen_at') ?? new Date().toISOString();
        localStorage.setItem(TradingDashboardComponent.NOTIF_BASELINE_KEY, raw);
      }
      const d = new Date(raw);
      return isNaN(d.getTime()) ? new Date(0) : d;
    } catch {
      return new Date(0);
    }
  }

  private static loadNotifReadIds(): Set<number> {
    try {
      const raw = localStorage.getItem(TradingDashboardComponent.NOTIF_READ_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return new Set(Array.isArray(arr) ? (arr as number[]) : []);
    } catch {
      return new Set();
    }
  }

  private persistNotifReadIds(ids: Set<number>): void {
    try {
      localStorage.setItem(TradingDashboardComponent.NOTIF_READ_KEY, JSON.stringify([...ids]));
    } catch {
      /* storage unavailable — read state just won't persist beyond this session */
    }
  }

  /** True when a notification is newer than the baseline AND not yet clicked. */
  protected isNotifUnread(n: PushNotificationRow): boolean {
    return new Date(n.created_at) > this.notifBaselineAt() && !this.notifReadIds().has(n.id);
  }

  protected readonly unreadCount = computed(() => {
    const readIds = this.notifReadIds();
    const baseline = this.notifBaselineAt();
    return this.pushNotifications().filter(
      (n) => new Date(n.created_at) > baseline && !readIds.has(n.id),
    ).length;
  });

  /** Mark a single notification read (on click). No-op if already read. */
  protected markNotifRead(n: PushNotificationRow): void {
    if (!this.isNotifUnread(n)) return;
    const next = new Set(this.notifReadIds());
    next.add(n.id);
    this.notifReadIds.set(next);
    this.persistNotifReadIds(next);
  }

  /** Mark everything currently loaded as read — bump the baseline to now. */
  protected markAllNotifRead(): void {
    const now = new Date();
    this.notifBaselineAt.set(now);
    localStorage.setItem(TradingDashboardComponent.NOTIF_BASELINE_KEY, now.toISOString());
    this.notifReadIds.set(new Set());
    this.persistNotifReadIds(new Set());
  }

  /** Combined CSS class for an item: event-type accent + unread highlight. */
  protected notifItemClass(n: PushNotificationRow): string {
    return this.notifTypeClass(n) + (this.isNotifUnread(n) ? ' notif-unread' : '');
  }

  protected openNotifPanel(): void {
    // Opening no longer marks everything read — that's now per-message (click)
    // or via the explicit "Alle gelesen" action — so the badge keeps reflecting
    // only the notifications the user hasn't actually looked at yet.
    this.notifPanelOpen.set(true);
  }

  protected closeNotifPanel(): void {
    this.notifPanelOpen.set(false);
  }

  /** Groups push notifications by local calendar day for the panel feed. */
  protected readonly notifGroups = computed(() => {
    const items = this.pushNotifications();
    const groups = new Map<string, PushNotificationRow[]>();
    const now = new Date();
    const todayStr = now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = yesterday.toDateString();

    for (const n of items) {
      const d = new Date(n.created_at);
      let label: string;
      if (d.toDateString() === todayStr) {
        label = 'Heute';
      } else if (d.toDateString() === yesterdayStr) {
        label = 'Gestern';
      } else {
        label = d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
      }
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(n);
    }
    return Array.from(groups.entries()).map(([label, notifs]) => ({ label, items: notifs }));
  });

  protected notifTypeClass(n: PushNotificationRow): string {
    switch (n.event_type) {
      case 'buy':                       return 'notif-item notif-type-buy';
      case 'sell-tp':                   return 'notif-item notif-type-tp';
      case 'sell-interim-tp':           return 'notif-item notif-type-interim-tp';
      case 'sell-trailing-stop':        return 'notif-item notif-type-stop';
      case 'sell-interim-trailing-stop':return 'notif-item notif-type-interim-stop';
      case 'sell-hard-stop':            return 'notif-item notif-type-stop';
      case 'sell-interim-hard-stop':    return 'notif-item notif-type-interim-stop';
      default:                          return 'notif-item';
    }
  }

  protected notifEmoji(n: PushNotificationRow): string {
    switch (n.event_type) {
      case 'buy':                        return '📈';
      case 'sell-tp':
      case 'sell-interim-tp':            return '🎯';
      case 'sell-trailing-stop':
      case 'sell-interim-trailing-stop': return '🔒';
      case 'sell-hard-stop':
      case 'sell-interim-hard-stop':     return '🛑';
      default:                           return '🔔';
    }
  }

  /** Human-readable relative time label for a notification timestamp. */
  protected relativeTime(isoString: string): string {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 2)  return 'gerade eben';
    if (mins < 60) return `vor ${mins} Min.`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `vor ${hours} Std.`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'gestern' : `vor ${days} Tagen`;
  }

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
  protected readonly stopLoss = -0.06; // trailing-stop distance below the since-entry peak (STOP_LOSS)
  protected readonly hardStop = -0.08; // unconditional capital floor, % loss from entry (HARD_STOP)
  protected readonly maxPositions = 3; // kept in sync with MAX_POSITIONS in market-scan/index.ts

  @ViewChild('chartCanvas') private chartCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('sqlDialog') private readonly sqlDialogEl?: ElementRef<HTMLDialogElement>;
  private chart: Chart | null = null;

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly portfolio = signal<PortfolioRow | null>(null);
  protected readonly positions = signal<PositionRow[]>([]);
  protected readonly transactions = signal<TransactionRow[]>([]);
  protected readonly balanceHistory = signal<BalanceHistoryRow[]>([]);
  protected readonly signals = signal<SignalRow[]>([]);
  protected readonly watchlist = signal<WatchlistRow[]>([]);
  protected readonly missedOpportunities = signal<SignalRow[]>([]);

  /**
   * Per-ticker "is this an ETF?" lookup — `is_etf` lives on `watchlist` (a
   * per-ticker classification from Yahoo's own `instrumentType`, see
   * trading_schema_v7_etf_flag.sql), not on `signals` (which is a per-scan
   * measurement), so the "Watchlist & Signale" table joins the two by ticker
   * to separate stocks from ETFs. `undefined` = ticker not in `watchlist`
   * (shouldn't normally happen — every signal comes from a watched ticker —
   * but handled defensively); `null` = known ticker, classification not yet
   * backfilled (pre-v7 row the engine hasn't re-evaluated yet).
   */
  private readonly isEtfByTicker = computed(() => {
    return new Map(this.watchlist().map((w) => [w.ticker, w.is_etf] as const));
  });
  protected readonly lastScanAt = signal<string | null>(null);
  protected readonly verdictPerformance = signal<VerdictPerformanceRow[]>([]);
  protected readonly zScorePerformance = signal<ZScoreBucketPerformanceRow[]>([]);

  protected readonly totalValue = signal(0);

  // ── USD/CHF exchange-rate model ──────────────────────────────────────────
  // Surfaces the live rate the Edge Functions most recently fetched & applied
  // (Yahoo Finance `USDCHF=X`, recorded once per run on every transaction AND
  // balance snapshot — see `.fx-note` below for the user-facing explanation
  // and `usd_chf_rate` migration v4 for the schema change). Prefers the
  // freshest TRANSACTION over the freshest snapshot when both exist for the
  // same moment, since a trade is the more concrete "this rate was actually
  // used to move real CHF" anchor; falls through to balance_history (written
  // every run, trades or not) so the note still shows a rate between trades.
  // `null` only when NEITHER source has a recorded rate yet (i.e. every run
  // since the v4 migration predates this dashboard load — effectively never
  // once the next scan completes).
  protected readonly latestUsdChfRate = computed(() => {
    // `transactions` arrives newest-first (see TradingService.getTransactionLog),
    // `balanceHistory` arrives oldest-first/newest-LAST (it's reversed for the
    // chart, see TradingService.getBalanceHistory) — `.find`/`.at(-1)` pick
    // the newest from each accordingly.
    const fromTx = this.transactions().find((t) => t.usd_chf_rate !== null)?.usd_chf_rate;
    if (fromTx != null) return fromTx;
    const history = this.balanceHistory();
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].usd_chf_rate !== null) return history[i].usd_chf_rate;
    }
    return null;
  });

  // ── CNN Fear & Greed Index (v10) ─────────────────────────────────────────
  // Derived from balance_history, which is written on EVERY scan run (trades
  // or not), so this stays current between trade-less scans too. The same
  // "newest non-null" scan pattern as latestUsdChfRate above.
  protected readonly latestFearGreedScore = computed(() => {
    const history = this.balanceHistory();
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const score = history[i].fear_greed_score;
      if (score !== null && score !== undefined) return score as number;
    }
    return null;
  });

  // True when the buy-gate is/was active at the time of the latest scan run.
  protected readonly buyGateActive = computed(() => {
    const score = this.latestFearGreedScore();
    return score !== null && score < 40;
  });

  protected fearGreedLabel(score: number): string {
    if (score <= 25) return 'Extreme Angst (Score ≤ 25)';
    if (score <= 40) return 'Angst — Kauf-Stop aktiv';
    if (score <= 60) return 'Neutral';
    if (score <= 75) return 'Gier';
    return 'Extreme Gier (Score > 75)';
  }

  protected fearGreedClass(score: number | null): string {
    if (score === null) return '';
    if (score <= 25) return 'neg';
    if (score <= 40) return 'neg';
    if (score <= 60) return '';
    if (score <= 75) return 'pos';
    return 'pos';
  }

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

  /**
   * Splits the (already filtered + sorted) watchlist by `is_etf` so stocks
   * and ETFs render as two separate tables — the user explicitly asked for
   * this separation, and it also makes the "we don't actually trade ETFs"
   * fact visible rather than just asserted: ETFs are clearly set apart, not
   * interleaved with the tickers the engine can actually buy.
   *
   * `null`/`undefined` (not yet classified, see `isEtfByTicker`) land in the
   * "Aktien" group, not a third "unknown" one — overwhelmingly the safer
   * default (most watchlist tickers are, and always were, individual stocks;
   * the only ETFs currently present predate the discovery filter that now
   * keeps new ones out, see BROAD_MARKET_ETFS). The "Typ" column's '?' badge
   * keeps that pending-classification state honestly visible regardless.
   */
  protected readonly sortedStockSignals = computed(() =>
    this.sortedSignals().filter((s) => this.isEtfByTicker().get(s.ticker) !== true),
  );
  protected readonly sortedEtfSignals = computed(() =>
    this.sortedSignals().filter((s) => this.isEtfByTicker().get(s.ticker) === true),
  );

  // ── "Verpasste Chancen": Heuristik wollte kaufen, Portfolio war voll ────
  protected readonly missedFilter = signal('');

  /**
   * Joins each "missed opportunity" with the latest known signal for its
   * ticker (already loaded via `getWatchlistSignals` → `signals`) to derive
   * a purely descriptive "what has the price done since?" — see
   * `MissedOpportunityView` for why this stays descriptive rather than a
   * simulated counterfactual P&L.
   */
  protected readonly missedOpportunityViews = computed<MissedOpportunityView[]>(() => {
    const latestByTicker = new Map(this.signals().map((s) => [s.ticker, s] as const));
    return this.missedOpportunities().map((signal) => {
      const latest = latestByTicker.get(signal.ticker) ?? null;
      const isLatest = latest !== null && latest.id === signal.id;
      const changePct = latest !== null && !isLatest ? (latest.price - signal.price) / signal.price : null;
      return { signal, latest, isLatest, changePct };
    });
  });

  protected readonly filteredMissedOpportunityViews = computed(() => {
    const term = this.missedFilter().trim().toUpperCase();
    const rows = this.missedOpportunityViews();
    return term ? rows.filter((r) => r.signal.ticker.toUpperCase().includes(term)) : rows;
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

  // ── Chart time-range selector ─────────────────────────────────────────────
  protected readonly chartRanges = [
    { value: '2d'  as const, label: '2T',    title: 'Letzte 48 Stunden'  },
    { value: '1w'  as const, label: '1W',    title: 'Letzte 7 Tage'      },
    { value: '1m'  as const, label: '1M',    title: 'Letzter Monat (30 Tage)' },
    { value: 'all' as const, label: 'Alles', title: 'Gesamter Zeitraum'  },
  ];

  protected readonly chartRange = signal<'2d' | '1w' | '1m' | 'all'>('2d');

  protected setChartRange(range: '2d' | '1w' | '1m' | 'all'): void {
    this.chartRange.set(range);
    this.renderChart();
  }

  /** Returns the slice of `balanceHistory` that fits the selected time window. */
  protected chartFilteredHistory(): BalanceHistoryRow[] {
    const history = this.balanceHistory();
    const range = this.chartRange();
    if (range === 'all') return history;
    const msMap: Record<string, number> = {
      '2d': 2  * 24 * 60 * 60 * 1000,
      '1w': 7  * 24 * 60 * 60 * 1000,
      '1m': 30 * 24 * 60 * 60 * 1000,
    };
    const cutoff = Date.now() - msMap[range];
    return history.filter((h) => new Date(h.recorded_at).getTime() >= cutoff);
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

  /**
   * Buy-transaction lookup by id — lets the log show "this SELL closed a
   * position that was opened for X CHF" right next to its (already
   * colour-coded green/red) realized P&L, so the two numbers that actually
   * answer "was this a good trade?" sit side by side instead of requiring a
   * manual scroll-and-match through the log. Same `opening_transaction_id`
   * link `avgHoldingHours`/`tickerLeaderboard` already build their own
   * `buysById` maps to follow — only
   * trades made after the v2 migration carry it; older sells simply show no
   * buy-amount hint, the same "honestly absent, not guessed at" convention
   * used throughout this log (see e.g. `usd_chf_rate`'s doc comment).
   */
  private readonly buyByOpeningId = computed(() => {
    const map = new Map<number, TransactionRow>();
    for (const t of this.transactions()) {
      if (t.action === 'buy') map.set(t.id, t);
    }
    return map;
  });

  /** The opening BUY for a given SELL row, or `null` if it's a buy itself, an
   *  unlinked legacy sell, or (edge case) the linked buy fell out of the
   *  loaded page of `transactions` (the log is paginated, see
   *  `TradingService.getTransactionLog`). */
  protected buyForSell(t: TransactionRow): TransactionRow | null {
    if (t.action !== 'sell' || t.opening_transaction_id === null) return null;
    return this.buyByOpeningId().get(t.opening_transaction_id) ?? null;
  }

  // The scan runs 4× per trading day (Mon–Fri) at 14:30, 15:00, 17:00 and 19:00 UTC
  // — all within NYSE/NASDAQ regular hours (09:30–16:00 ET). The 14:30 UTC run
  // fires at market open (EDT: 10:30 ET; EST: 09:30 ET exactly). Outside those
  // windows (evenings, nights, weekends) it is intentionally idle: `isUsMarketOpen`
  // in the Edge Function refuses to buy/sell outside the session anyway, so
  // scanning then would just produce noise-only logs. That means a "stale"
  // warning only makes sense while the market IS open — a 20-hour gap from
  // Friday evening to Monday morning is expected, not a stuck cron.
  //
  // Rule: show the warning only if the US market is currently open AND the
  // last scan is more than 3 hours old (= a full scheduled run was missed
  // during an active session).
  private static isUsMarketOpenNow(): boolean {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = get('weekday');
    const minutesSinceMidnight = Number(get('hour')) * 60 + Number(get('minute'));
    const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
    return isWeekday && minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight < 16 * 60;
  }

  private static readonly SCAN_STALE_DURING_SESSION_MS = 3 * 60 * 60 * 1000; // 3 h

  /** Background auto-refresh — see ngOnInit. */
  private static readonly REFRESH_INTERVAL_MS = 60_000;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onVisibility: (() => void) | null = null;

  ngOnInit(): void {
    if (this.trading.configured) {
      void this.load();

      // Live updates: the data pipeline writes fresh balance_history/portfolio
      // rows server-side (price-refresh every ~15-30min, market-scan every 6h),
      // but this SPA previously only loaded ONCE on mount — so an open dashboard
      // never reflected a new run until a manual reload. Poll quietly while the
      // tab is visible (no spinner, keep-on-error), and refresh immediately when
      // the user switches back to the tab.
      this.refreshTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.load(true);
      }, TradingDashboardComponent.REFRESH_INTERVAL_MS);

      this.onVisibility = () => {
        if (document.visibilityState === 'visible') void this.load(true);
      };
      document.addEventListener('visibilitychange', this.onVisibility);
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
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.chart?.destroy();
    this.allocationChart?.destroy();
  }

  private async load(silent = false): Promise<void> {
    // `silent` = background auto-refresh: don't flash the loading spinner, and
    // on failure keep the data already on screen instead of replacing it with
    // an error banner (a transient poll failure shouldn't wipe a working view).
    if (!silent) this.loading.set(true);
    this.error.set(null);
    try {
      const [
        portfolio,
        positions,
        transactions,
        balanceHistory,
        signals,
        watchlist,
        missedOpportunities,
        lastScanAt,
        verdictPerformance,
        zScorePerformance,
        pushNotifications,
      ] = await Promise.all([
        this.trading.getPortfolio(),
        this.trading.getPositions(),
        this.trading.getTransactionLog(),
        this.trading.getBalanceHistory(),
        this.trading.getWatchlistSignals(),
        this.trading.getWatchlist(),
        this.trading.getMissedOpportunities(),
        this.trading.getLastScanTime(),
        this.trading.getVerdictPerformance(),
        this.trading.getZScoreBucketPerformance(),
        this.trading.getPushNotifications(),
      ]);
      this.portfolio.set(portfolio);
      this.positions.set(positions);
      this.transactions.set(transactions);
      this.balanceHistory.set(balanceHistory);
      this.signals.set(signals);
      this.watchlist.set(watchlist);
      this.missedOpportunities.set(missedOpportunities);
      this.lastScanAt.set(lastScanAt);
      this.verdictPerformance.set(verdictPerformance);
      this.zScorePerformance.set(zScorePerformance);
      this.pushNotifications.set(pushNotifications);

      const latestSnapshot = balanceHistory[balanceHistory.length - 1];
      this.totalValue.set(latestSnapshot ? latestSnapshot.total_value : portfolio.cash);

      this.renderChart();
      this.renderAllocationChart();
    } catch (e) {
      if (!silent) this.error.set(this.toMessage(e));
    } finally {
      if (!silent) this.loading.set(false);
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
    highSinceEntry: number;
    trailingStopPrice: number;
    /** How far the trailing stop sits from the entry price as a fraction — if
     *  positive, the stop has risen above entry and ANY exit now protects some gain. */
    trailingStopPctFromEntry: number;
    /** Distance from current price to trailing stop (positive = above stop, safe). */
    distanceToStop: number | null;
  } {
    const current = this.currentPrice(p.ticker);
    const changePct = current !== null ? (current - p.entry_price) / p.entry_price : null;
    const unrealized = current !== null ? (current - p.entry_price) * p.shares : null;
    const value = (current ?? p.entry_price) * p.shares;
    const highSinceEntry = p.high_since_entry ?? p.entry_price;
    const trailingStopPrice = highSinceEntry * (1 + this.stopLoss); // stopLoss = −0.06
    const trailingStopPctFromEntry = (trailingStopPrice - p.entry_price) / p.entry_price;
    const distanceToStop = current !== null ? (current - trailingStopPrice) / current : null;
    return { current, changePct, unrealized, value, highSinceEntry, trailingStopPrice, trailingStopPctFromEntry, distanceToStop };
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
    if (age === null) return false;
    // Only flag as stuck when the NYSE/NASDAQ session is currently open —
    // a long gap outside trading hours is expected, not a problem.
    if (!TradingDashboardComponent.isUsMarketOpenNow()) return false;
    return age > TradingDashboardComponent.SCAN_STALE_DURING_SESSION_MS;
  }

  protected scanAgeLabel(): string {
    const age = this.scanAgeMs();
    if (age === null) return '';
    const hours = age / 36e5;
    const marketOpen = TradingDashboardComponent.isUsMarketOpenNow();
    const suffix = marketOpen ? '' : ' (Markt zu)';
    if (hours < 1) return `vor ${Math.max(1, Math.round(age / 60000))} Min.${suffix}`;
    if (hours < 48) return `vor ${hours.toFixed(1)} Std.${suffix}`;
    return `vor ${(hours / 24).toFixed(1)} Tagen${suffix}`;
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
    const header = [
      'Datum', 'Aktion', 'Ticker', 'Menge', 'Kurs (USD)', 'Gebühr (CHF)', 'FX-Marge (CHF)',
      'Wechselkurs (USD→CHF)', 'Brutto (CHF)', 'PnL (CHF)', 'Begründung',
    ];
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
          t.usd_chf_rate ?? '',
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
    return this.benchmarkSeriesFor(this.balanceHistory());
  }

  /**
   * Builds the SPY benchmark series for an arbitrary (potentially filtered)
   * slice of balance history. Normalisation always uses the FULL simulation
   * start so the benchmark line stays comparable across time windows.
   */
  private benchmarkSeriesFor(history: BalanceHistoryRow[]): (number | null)[] {
    const allHistory = this.balanceHistory();
    const initialValue = allHistory.length ? allHistory[0].total_value : 10000;
    // Anchor SPY to the first point in the FULL history that has a price — so
    // the normalised line always starts at the same capital, not at whichever
    // snapshot happens to be first in the current window.
    const reference = allHistory.find((h) => h.spy_price !== null && h.spy_price !== undefined)?.spy_price ?? null;
    if (reference === null) return history.map(() => null);
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
  protected exitBarPosition(changePct: number, trailingStopPctFromEntry: number = this.stopLoss): number {
    // The bar always spans from the current trailing stop level (left edge) to
    // take-profit (right edge). As the trailing stop rises, the left boundary
    // shifts right — giving a visual sense of how the "safe zone" has shrunk.
    const span = this.takeProfit - trailingStopPctFromEntry;
    const padded = span * 1.25;
    const center = (this.takeProfit + trailingStopPctFromEntry) / 2;
    const min = center - padded / 2;
    const ratio = (changePct - min) / padded;
    return Math.max(2, Math.min(98, ratio * 100));
  }

  protected hypeColor(score: number): string {
    if (score > 65) return '#c0392b';
    if (score > 40) return '#c98a00';
    return '#1a8a3c';
  }

  /**
   * How far the diverging "Stimmung" bar's fill should grow AWAY FROM the
   * center (in % of the half-track it occupies) for a given bullish ratio.
   * `(ratio - 0.5)` is the raw deviation from neutral (range -0.5..+0.5);
   * doubling it stretches that into the full 0-100% range so a 95%-bullish
   * reading fills its half almost completely instead of being visually
   * cramped into a sliver near the center — see the `.sent-*` styles' doc
   * comment for why a center-anchored bar was chosen over a left-anchored
   * one in the first place (direction AND strength in one glance).
   */
  protected sentimentFillPct(ratio: number): number {
    return Math.abs(ratio - 0.5) * 100;
  }

  /**
   * Cell tooltip for the "Stimmung" column — mirrors the thresholds
   * `classify()` actually uses server-side (`sentimentConfirmsBullish` at
   * >= 0.55, `sentimentContradicts` at <= 0.4, see market-scan/index.ts) so
   * the explanation here can never drift out of sync with what the engine
   * actually does with this number. Deliberately phrased in terms of "Hype",
   * not "Kauf" — sentiment is one of five lenses that feed the Verdict, not
   * a standalone buy/sell signal (see the column's header info-icon).
   */
  protected sentimentTooltip(s: SignalRow): string {
    const ratio = s.sentiment_ratio;
    if (ratio === null) {
      return 'Weniger als 5 getaggte StockTwits-Nachrichten — keine verlässliche Stimmungsmessung möglich (siehe Spalten-Info).';
    }
    const pct = Math.round(ratio * 100);
    if (ratio >= 0.55) {
      return `StockTwits-Stimmung: ${pct}% bullish — bestätigt potenziellen Hype (Schwelle ≥ 55%).`;
    }
    if (ratio <= 0.4) {
      return `StockTwits-Stimmung: ${pct}% bullish — widerspricht potenziellem Hype (Schwelle ≤ 40%), kann allein zur Blockierung führen.`;
    }
    return `StockTwits-Stimmung: ${pct}% bullish — neutral (weder klare Bestätigung noch klarer Widerspruch).`;
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
   * "Aktie" / "ETF" / "?" — driven by `watchlist.is_etf` (Yahoo's own
   * `instrumentType`, see `isEtfByTicker`), NOT a guess. '?' specifically
   * means "not yet (re-)evaluated since the v7 migration", which is why it's
   * shown rather than silently defaulting to "Aktie" — the distinction matters
   * for trusting the Aktien/ETF split above at a glance.
   */
  protected signalTypeLabel(s: SignalRow): string {
    const isEtf = this.isEtfByTicker().get(s.ticker);
    if (isEtf === true) return 'ETF';
    if (isEtf === false) return 'Aktie';
    return '?';
  }

  protected signalTypeClass(s: SignalRow): string {
    const isEtf = this.isEtfByTicker().get(s.ticker);
    if (isEtf === true) return 'badge badge-etf';
    if (isEtf === false) return 'badge badge-stock';
    return 'badge badge-unknown';
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
    // Use the time-range-filtered slice for display; normalise % mode against
    // the FULL simulation start so "% seit Start" means total return since
    // inception regardless of which window is zoomed in.
    const history = this.chartFilteredHistory();
    const allHistory = this.balanceHistory();
    const labels = history.map((h) =>
      new Date(h.recorded_at).toLocaleString('de-CH', { month: 'short', day: 'numeric', hour: '2-digit' }),
    );
    const initialValue = allHistory.length ? allHistory[0].total_value : 10000;
    const mode = this.chartMode();
    const isPercent = mode === 'percent';

    // Both the portfolio line and the (already CHF-normalized) benchmark line
    // get the SAME percent transform — "% change since the same starting
    // capital" — so the two stay directly, fairly comparable in either mode.
    const toDisplay = (v: number | null): number | null =>
      v === null ? null : isPercent && initialValue !== 0 ? ((v - initialValue) / initialValue) * 100 : v;

    const portfolioRaw = history.map((h) => h.total_value);
    const benchmarkRaw = this.benchmarkSeriesFor(history);
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

  // ── SQL-Analyse-Tab ──────────────────────────────────────────────────────
  // All queries are computed from the already-loaded `transactions()` signal —
  // no extra DB round-trip needed. The `sql` string is display-only (shown in
  // the "SQL anzeigen" dialog) so the user can understand what the TypeScript
  // computation is doing behind the scenes.

  protected readonly selectedAnalysisId = signal<string>('verdict');
  // Reset executed results when the user picks a different query so the
  // source-label and rows stay consistent (no stale "DB result from query X
  // displayed under query Y" situation).
  protected onAnalysisQueryChange(id: string): void {
    this.selectedAnalysisId.set(id);
    this.analysisAllTxs.set(null);
  }

  // ── Query definitions ────────────────────────────────────────────────────

  private static buildSellPairs(txs: TransactionRow[]): {
    sell: TransactionRow;
    buy: TransactionRow;
    holdHours: number | null;
  }[] {
    const buyById = new Map(txs.filter((t) => t.action === 'buy').map((t) => [t.id, t]));
    return txs
      .filter((t) => t.action === 'sell' && t.opening_transaction_id != null)
      .map((sell) => {
        const buy = buyById.get(sell.opening_transaction_id!);
        if (!buy) return null;
        const holdHours =
          sell.created_at && buy.created_at
            ? (new Date(sell.created_at).getTime() - new Date(buy.created_at).getTime()) / 3_600_000
            : null;
        return { sell, buy, holdHours };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  private static avg(nums: number[]): number | null {
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  private static round2(n: number | null): number | null {
    return n === null ? null : Math.round(n * 100) / 100;
  }
  private static winRate(wins: number, total: number): number | null {
    return total ? Math.round((1000 * wins) / total) / 10 : null;
  }

  protected readonly ANALYSIS_QUERIES = [
    {
      id: 'verdict',
      label: 'Trefferquote nach Strategie-Verdict',
      description: 'Wie gut performen Trades, die als "organic" klassifiziert wurden? Vergleicht Gewinnrate, Ø PnL und Haltedauer je Verdict-Typ.',
      sql: `-- Trefferquote nach Verdict
SELECT
  coalesce(buy.signal_snapshot->>'verdict', 'unbekannt') AS verdict,
  count(*)                       AS trades,
  count(*) FILTER (WHERE sell.realized_pnl > 0) AS wins,
  round(100.0 * count(*) FILTER (WHERE sell.realized_pnl > 0)
        / nullif(count(*),0), 1) AS win_rate_pct,
  round(avg(sell.realized_pnl), 2) AS avg_pnl_chf,
  round(sum(sell.realized_pnl), 2) AS total_pnl_chf,
  round(avg(extract(epoch from
    (sell.created_at - buy.created_at))/3600.0), 1) AS avg_hold_h
FROM transactions sell
JOIN transactions buy ON sell.opening_transaction_id = buy.id
WHERE sell.action = 'sell'
GROUP BY 1 ORDER BY total_pnl_chf DESC;`,
      columns: [
        { key: 'verdict',       label: 'Verdict',        format: 'text'         },
        { key: 'trades',        label: 'Trades',         format: 'integer'      },
        { key: 'wins',          label: 'Gewinner',       format: 'integer'      },
        { key: 'win_rate_pct',  label: 'Trefferquote',   format: 'percent'      },
        { key: 'avg_pnl_chf',   label: 'Ø PnL',          format: 'currency_chf' },
        { key: 'total_pnl_chf', label: 'Gesamt-PnL',     format: 'currency_chf' },
        { key: 'avg_hold_h',    label: 'Ø Haltedauer',   format: 'hours'        },
      ],
      compute: (txs: TransactionRow[]) => {
        const pairs = TradingDashboardComponent.buildSellPairs(txs);
        const groups = new Map<string, { wins: number; total: number; pnl: number[]; hours: number[] }>();
        for (const { sell, buy, holdHours } of pairs) {
          const v = buy.signal_snapshot?.verdict ?? 'unbekannt';
          if (!groups.has(v)) groups.set(v, { wins: 0, total: 0, pnl: [], hours: [] });
          const g = groups.get(v)!;
          g.total++;
          if ((sell.realized_pnl ?? 0) > 0) g.wins++;
          if (sell.realized_pnl != null) g.pnl.push(sell.realized_pnl);
          if (holdHours != null) g.hours.push(holdHours);
        }
        return Array.from(groups.entries())
          .map(([verdict, g]) => ({
            verdict,
            trades: g.total,
            wins: g.wins,
            win_rate_pct: TradingDashboardComponent.winRate(g.wins, g.total),
            avg_pnl_chf: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.pnl)),
            total_pnl_chf: TradingDashboardComponent.round2(g.pnl.reduce((a, b) => a + b, 0)),
            avg_hold_h: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.hours)),
          }))
          .sort((a, b) => (b.total_pnl_chf ?? 0) - (a.total_pnl_chf ?? 0));
      },
      interpret: (rows: Record<string, unknown>[]) => {
        const total = rows.reduce((s, r) => s + (r['trades'] as number), 0);
        if (total === 0) return { text: 'Noch keine abgeschlossenen Trades — Analyse verfügbar sobald die erste Position verkauft wurde.', color: 'neutral' as const };
        const wins = rows.reduce((s, r) => s + (r['wins'] as number), 0);
        const totalPnl = rows.reduce((s, r) => s + (r['total_pnl_chf'] as number ?? 0), 0);
        const wr = Math.round((1000 * wins) / total) / 10;
        const prefix = total < 10 ? `Frühe Daten (nur ${total} Trades — Zahlen noch wenig belastbar): ` : '';
        const wrText = wr >= 60 ? `Trefferquote ${wr}% ist solide` : wr >= 50 ? `Trefferquote ${wr}% ist knapp über 50%` : `Trefferquote ${wr}% liegt unter 50%`;
        const pnlText = totalPnl > 0 ? `Gesamtbilanz positiv (+${totalPnl.toFixed(2)} CHF).` : `Gesamtbilanz negativ (${totalPnl.toFixed(2)} CHF).`;
        const hint = total < 10 ? ' Mindestens 15–20 abgeschlossene Trades für belastbare Aussagen.' : '';
        const color = (wr >= 55 && totalPnl > 0) ? 'pos' as const : (wr < 45 || totalPnl < 0) ? 'neg' as const : 'neutral' as const;
        return { text: `${prefix}${wrText}. ${pnlText}${hint}`, color };
      },
    },
    {
      id: 'exits',
      label: 'Exit-Arten: Trailing Stop vs. Hard-Stop vs. Take-Profit',
      description: 'Wie oft löste welcher Exit-Mechanismus aus — und was hat er durchschnittlich eingebracht? Take-Profit (+20%), Hard-Stop (−8% Kapitalboden, v15+), verdict-bewusster Trailing Stop (v14+) und fixer Stop-Loss (legacy).',
      sql: `-- Exit-Arten Analyse
SELECT
  CASE
    WHEN exit_reason IN ('take-profit','interim-take-profit')   THEN 'Take-Profit'
    WHEN exit_reason IN ('hard-stop','interim-hard-stop')        THEN 'Hard-Stop (v15+)'
    WHEN exit_reason IN ('trailing-stop','interim-trailing-stop') THEN 'Trailing Stop (v14+)'
    WHEN exit_reason IN ('stop-loss','interim-stop-loss')        THEN 'Stop-Loss (fix, pre-v14)'
    ELSE 'Sonstige'
  END AS exit_art,
  count(*)                         AS exits,
  round(avg(realized_pnl), 2)      AS avg_pnl_chf,
  round(sum(realized_pnl), 2)      AS total_pnl_chf,
  round(avg(
    CASE WHEN exit_reason IN ('trailing-stop','interim-trailing-stop')
         THEN (high_since_entry - price) / nullif(price,0) * 100
    END
  ), 2)                            AS avg_drop_from_high_pct
FROM transactions
WHERE action = 'sell'
GROUP BY 1 ORDER BY exits DESC;`,
      columns: [
        { key: 'exit_art',              label: 'Exit-Art',            format: 'text'         },
        { key: 'exits',                 label: 'Anzahl',              format: 'integer'      },
        { key: 'avg_pnl_chf',           label: 'Ø PnL',              format: 'currency_chf' },
        { key: 'total_pnl_chf',         label: 'Gesamt-PnL',         format: 'currency_chf' },
        { key: 'avg_drop_from_high_pct',label: 'Ø Abfall vom Hoch',  format: 'percent'      },
      ],
      compute: (txs: TransactionRow[]) => {
        const sells = txs.filter((t) => t.action === 'sell');
        const groups = new Map<string, { pnl: number[]; dropsFromHigh: number[] }>();
        const label = (r: string | null): string => {
          if (!r) return 'Sonstige';
          if (r.includes('take-profit')) return 'Take-Profit';
          if (r.includes('hard-stop')) return 'Hard-Stop (v15+)';
          if (r.includes('trailing-stop')) return 'Trailing Stop (v14+)';
          if (r.includes('stop-loss')) return 'Stop-Loss (fix, pre-v14)';
          return 'Sonstige';
        };
        for (const s of sells) {
          const k = label(s.exit_reason);
          if (!groups.has(k)) groups.set(k, { pnl: [], dropsFromHigh: [] });
          const g = groups.get(k)!;
          if (s.realized_pnl != null) g.pnl.push(s.realized_pnl);
          if (s.exit_reason?.includes('trailing-stop') && s.high_since_entry != null && s.price != null) {
            g.dropsFromHigh.push(((s.high_since_entry - s.price) / s.high_since_entry) * 100);
          }
        }
        return ['Take-Profit', 'Hard-Stop (v15+)', 'Trailing Stop (v14+)', 'Stop-Loss (fix, pre-v14)', 'Sonstige']
          .map((k) => {
            const g = groups.get(k);
            if (!g) return null;
            return {
              exit_art: k,
              exits: g.pnl.length,
              avg_pnl_chf: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.pnl)),
              total_pnl_chf: TradingDashboardComponent.round2(g.pnl.reduce((a, b) => a + b, 0)),
              avg_drop_from_high_pct: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.dropsFromHigh)),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null && r.exits > 0);
      },
      interpret: (rows: Record<string, unknown>[]) => {
        const tsRow = rows.find((r) => (r['exit_art'] as string).includes('Trailing'));
        const fixedRow = rows.find((r) => (r['exit_art'] as string).includes('fix'));
        const tpRow = rows.find((r) => (r['exit_art'] as string).includes('Take-Profit'));
        if (!tsRow && !tpRow) return { text: 'Noch keine abgeschlossenen Trades.', color: 'neutral' as const };
        if (!tsRow) {
          return { text: 'Noch kein Trailing-Stop ausgelöst — der Mechanismus ist aktiv, hatte aber noch keinen Auslöser. Das ist kein Problem: er greift nur wenn der Kurs nach einem Hoch wieder fällt.', color: 'neutral' as const };
        }
        const tsAvg = tsRow['avg_pnl_chf'] as number ?? 0;
        const fixAvg = fixedRow ? (fixedRow['avg_pnl_chf'] as number ?? 0) : null;
        const tsCnt = tsRow['exits'] as number;
        const dropPct = tsRow['avg_drop_from_high_pct'] as number | null;
        let text = `Trailing Stop hat ${tsCnt}× ausgelöst, Ø ${tsAvg >= 0 ? '+' : ''}${tsAvg.toFixed(2)} CHF PnL.`;
        if (dropPct != null) text += ` Im Schnitt fiel der Kurs ${dropPct.toFixed(1)}% unter das Hoch, bevor der Stop auslöste.`;
        if (fixAvg !== null) {
          const diff = tsAvg - fixAvg;
          text += diff > 0
            ? ` Gegenüber dem alten Fix-Stop (Ø ${fixAvg.toFixed(2)} CHF) ist das eine Verbesserung von +${diff.toFixed(2)} CHF pro Trade.`
            : ` Vergleich zum alten Fix-Stop (Ø ${fixAvg.toFixed(2)} CHF): minimal schlechter, aber Stop war seltener zu früh aktiv.`;
        }
        const color = tsAvg > 0 ? 'pos' as const : tsAvg > -5 ? 'neutral' as const : 'neg' as const;
        return { text, color };
      },
    },
    {
      id: 'tickers',
      label: 'Ticker-Leaderboard: Bestes & schlechtestes Papier',
      description: 'Welche Aktien haben am meisten zum Gesamtergebnis beigetragen — und welche haben am meisten gekostet?',
      sql: `-- Ticker Leaderboard
SELECT
  sell.ticker,
  count(*)                          AS trades,
  count(*) FILTER (WHERE sell.realized_pnl > 0) AS wins,
  round(100.0 * count(*) FILTER (WHERE sell.realized_pnl > 0)
        / nullif(count(*),0), 1)   AS win_rate_pct,
  round(sum(sell.realized_pnl), 2) AS total_pnl_chf,
  round(avg(sell.realized_pnl), 2) AS avg_pnl_chf
FROM transactions sell
WHERE sell.action = 'sell' AND sell.opening_transaction_id IS NOT NULL
GROUP BY sell.ticker
ORDER BY total_pnl_chf DESC;`,
      columns: [
        { key: 'ticker',        label: 'Ticker',        format: 'text'         },
        { key: 'trades',        label: 'Trades',        format: 'integer'      },
        { key: 'wins',          label: 'Gewinner',      format: 'integer'      },
        { key: 'win_rate_pct',  label: 'Trefferquote',  format: 'percent'      },
        { key: 'total_pnl_chf', label: 'Gesamt-PnL',    format: 'currency_chf' },
        { key: 'avg_pnl_chf',   label: 'Ø PnL',         format: 'currency_chf' },
      ],
      compute: (txs: TransactionRow[]) => {
        const pairs = TradingDashboardComponent.buildSellPairs(txs);
        const groups = new Map<string, { wins: number; total: number; pnl: number[] }>();
        for (const { sell } of pairs) {
          const k = sell.ticker;
          if (!groups.has(k)) groups.set(k, { wins: 0, total: 0, pnl: [] });
          const g = groups.get(k)!;
          g.total++;
          if ((sell.realized_pnl ?? 0) > 0) g.wins++;
          if (sell.realized_pnl != null) g.pnl.push(sell.realized_pnl);
        }
        return Array.from(groups.entries())
          .map(([ticker, g]) => ({
            ticker,
            trades: g.total,
            wins: g.wins,
            win_rate_pct: TradingDashboardComponent.winRate(g.wins, g.total),
            total_pnl_chf: TradingDashboardComponent.round2(g.pnl.reduce((a, b) => a + b, 0)),
            avg_pnl_chf: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.pnl)),
          }))
          .sort((a, b) => (b.total_pnl_chf ?? 0) - (a.total_pnl_chf ?? 0));
      },
      interpret: (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return { text: 'Noch keine abgeschlossenen Trades.', color: 'neutral' as const };
        const best = rows[0];
        const worst = rows[rows.length - 1];
        const totalPnl = rows.reduce((s, r) => s + (r['total_pnl_chf'] as number ?? 0), 0);
        const bestShare = totalPnl !== 0 ? Math.abs((best['total_pnl_chf'] as number ?? 0) / totalPnl * 100) : 0;
        let text = `Bester Titel: ${best['ticker']} (+${(best['total_pnl_chf'] as number ?? 0).toFixed(2)} CHF, ${best['trades']} Trades).`;
        if (rows.length > 1) text += ` Schwächster: ${worst['ticker']} (${(worst['total_pnl_chf'] as number ?? 0).toFixed(2)} CHF).`;
        if (bestShare > 70 && rows.length > 2) text += ` Achtung: ${bestShare.toFixed(0)}% des Gesamtergebnisses hängt an einem einzigen Titel — hohes Klumpenrisiko.`;
        const color = totalPnl > 0 ? 'pos' as const : totalPnl < 0 ? 'neg' as const : 'neutral' as const;
        return { text, color };
      },
    },
    {
      id: 'fear_greed',
      label: 'Fear & Greed: Kaufzeitpunkt vs. Ergebnis',
      description: 'Liefern Käufe in Angst-Phasen (Score < 40) bessere Ergebnisse als in Gier-Phasen (> 60)? Ausgewertet über den CNN Fear & Greed Score zum Kaufzeitpunkt.',
      sql: `-- Fear & Greed Einfluss
SELECT
  CASE
    WHEN (buy.signal_snapshot->>'fear_greed_score')::int <= 25 THEN '≤25 Extreme Angst'
    WHEN (buy.signal_snapshot->>'fear_greed_score')::int <= 40 THEN '26–40 Angst'
    WHEN (buy.signal_snapshot->>'fear_greed_score')::int <= 60 THEN '41–60 Neutral'
    WHEN (buy.signal_snapshot->>'fear_greed_score')::int <= 75 THEN '61–75 Gier'
    WHEN (buy.signal_snapshot->>'fear_greed_score')::int IS NOT NULL
                                                              THEN '76–100 Extreme Gier'
    ELSE 'Unbekannt (vor v10)'
  END                                  AS regime,
  count(*)                             AS trades,
  round(100.0 * count(*) FILTER (WHERE sell.realized_pnl > 0)
        / nullif(count(*),0), 1)       AS win_rate_pct,
  round(avg(sell.realized_pnl), 2)     AS avg_pnl_chf,
  round(sum(sell.realized_pnl), 2)     AS total_pnl_chf
FROM transactions sell
JOIN transactions buy ON sell.opening_transaction_id = buy.id
WHERE sell.action = 'sell'
GROUP BY 1 ORDER BY 1;`,
      columns: [
        { key: 'regime',        label: 'Markt-Regime',  format: 'text'         },
        { key: 'trades',        label: 'Trades',        format: 'integer'      },
        { key: 'win_rate_pct',  label: 'Trefferquote',  format: 'percent'      },
        { key: 'avg_pnl_chf',   label: 'Ø PnL',         format: 'currency_chf' },
        { key: 'total_pnl_chf', label: 'Gesamt-PnL',    format: 'currency_chf' },
      ],
      compute: (txs: TransactionRow[]) => {
        const pairs = TradingDashboardComponent.buildSellPairs(txs);
        const regimeOf = (score: number | null | undefined): string => {
          if (score == null) return 'Unbekannt (vor v10)';
          if (score <= 25) return '≤25 Extreme Angst';
          if (score <= 40) return '26–40 Angst';
          if (score <= 60) return '41–60 Neutral';
          if (score <= 75) return '61–75 Gier';
          return '76–100 Extreme Gier';
        };
        const groups = new Map<string, { wins: number; total: number; pnl: number[] }>();
        for (const { sell, buy } of pairs) {
          const k = regimeOf(buy.signal_snapshot?.fear_greed_score as number | null | undefined);
          if (!groups.has(k)) groups.set(k, { wins: 0, total: 0, pnl: [] });
          const g = groups.get(k)!;
          g.total++;
          if ((sell.realized_pnl ?? 0) > 0) g.wins++;
          if (sell.realized_pnl != null) g.pnl.push(sell.realized_pnl);
        }
        const order = ['≤25 Extreme Angst','26–40 Angst','41–60 Neutral','61–75 Gier','76–100 Extreme Gier','Unbekannt (vor v10)'];
        return order
          .filter((k) => groups.has(k))
          .map((k) => {
            const g = groups.get(k)!;
            return {
              regime: k,
              trades: g.total,
              win_rate_pct: TradingDashboardComponent.winRate(g.wins, g.total),
              avg_pnl_chf: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.pnl)),
              total_pnl_chf: TradingDashboardComponent.round2(g.pnl.reduce((a, b) => a + b, 0)),
            };
          });
      },
      interpret: (rows: Record<string, unknown>[]) => {
        const known = rows.filter((r) => !(r['regime'] as string).includes('Unbekannt'));
        if (known.length === 0) return { text: 'Noch keine Trades mit erfasstem Fear & Greed Score (erscheint ab Trades nach Einführung von v10).', color: 'neutral' as const };
        const fearRows = known.filter((r) => (r['regime'] as string).includes('Angst'));
        const greedRows = known.filter((r) => (r['regime'] as string).includes('Gier'));
        const avgPnlFor = (rs: typeof known) => {
          const pnls = rs.map((r) => r['avg_pnl_chf'] as number ?? 0).filter((v) => v != null);
          return pnls.length ? pnls.reduce((a, b) => a + b) / pnls.length : null;
        };
        const fearAvg = avgPnlFor(fearRows);
        const greedAvg = avgPnlFor(greedRows);
        if (fearAvg === null && greedAvg === null) return { text: 'Noch zu wenig Daten für einen Regime-Vergleich.', color: 'neutral' as const };
        let text = '';
        if (fearAvg !== null && greedAvg !== null) {
          text = fearAvg > greedAvg
            ? `Kontrarisches Muster: Käufe in Angst-Phasen (Ø ${fearAvg.toFixed(2)} CHF) liefen besser als in Gier-Phasen (Ø ${greedAvg.toFixed(2)} CHF) — der Fear & Greed Gate unter 40 blockiert nur Extremfälle, nicht alle Angst-Phasen.`
            : `Momentum-Muster: Käufe in Gier-Phasen (Ø ${greedAvg.toFixed(2)} CHF) liefen besser als in Angst-Phasen (Ø ${fearAvg.toFixed(2)} CHF).`;
        } else if (fearAvg !== null) {
          text = `Bisher nur Käufe in Angst-Phasen abgeschlossen: Ø ${fearAvg.toFixed(2)} CHF.`;
        } else {
          text = `Bisher nur Käufe in Gier-Phasen abgeschlossen: Ø ${greedAvg!.toFixed(2)} CHF.`;
        }
        const totalTrades = known.reduce((s, r) => s + (r['trades'] as number), 0);
        if (totalTrades < 8) text += ' (Datenbasis noch klein — Muster kann sich ändern.)';
        const totalPnl = known.reduce((s, r) => s + (r['total_pnl_chf'] as number ?? 0), 0);
        return { text, color: totalPnl > 0 ? 'pos' as const : totalPnl < 0 ? 'neg' as const : 'neutral' as const };
      },
    },
    {
      id: 'hold',
      label: 'Haltedauer: Gewinner vs. Verlierer',
      description: 'Werden Gewinner-Trades länger gehalten als Verlierer? Ein klarer Unterschied weist auf konsequentes "Gewinne laufen lassen, Verluste schnell schneiden" hin.',
      sql: `-- Haltedauer Gewinner vs. Verlierer
SELECT
  CASE WHEN sell.realized_pnl > 0 THEN 'Gewinner' ELSE 'Verlierer' END AS outcome,
  count(*)                                                   AS trades,
  round(avg(extract(epoch from
    (sell.created_at - buy.created_at))/3600.0), 1)          AS avg_hold_h,
  round(min(extract(epoch from
    (sell.created_at - buy.created_at))/3600.0), 1)          AS min_hold_h,
  round(max(extract(epoch from
    (sell.created_at - buy.created_at))/3600.0), 1)          AS max_hold_h,
  round(avg(sell.realized_pnl), 2)                           AS avg_pnl_chf,
  round(avg((sell.price - buy.price)/nullif(buy.price,0)*100),2) AS avg_price_chg_pct
FROM transactions sell
JOIN transactions buy ON sell.opening_transaction_id = buy.id
WHERE sell.action = 'sell'
GROUP BY 1 ORDER BY 1;`,
      columns: [
        { key: 'outcome',          label: 'Ergebnis',       format: 'text'         },
        { key: 'trades',           label: 'Trades',         format: 'integer'      },
        { key: 'avg_hold_h',       label: 'Ø Stunden',      format: 'hours'        },
        { key: 'min_hold_h',       label: 'Min. Stunden',   format: 'hours'        },
        { key: 'max_hold_h',       label: 'Max. Stunden',   format: 'hours'        },
        { key: 'avg_pnl_chf',      label: 'Ø PnL',          format: 'currency_chf' },
        { key: 'avg_price_chg_pct',label: 'Ø Kursänderung', format: 'percent'      },
      ],
      compute: (txs: TransactionRow[]) => {
        const pairs = TradingDashboardComponent.buildSellPairs(txs);
        const groups: Record<string, { pnl: number[]; hours: number[]; priceChg: number[] }> = {
          Gewinner: { pnl: [], hours: [], priceChg: [] },
          Verlierer: { pnl: [], hours: [], priceChg: [] },
        };
        for (const { sell, buy, holdHours } of pairs) {
          const k = (sell.realized_pnl ?? 0) > 0 ? 'Gewinner' : 'Verlierer';
          if (sell.realized_pnl != null) groups[k].pnl.push(sell.realized_pnl);
          if (holdHours != null) groups[k].hours.push(holdHours);
          if (buy.price && sell.price) groups[k].priceChg.push(((sell.price - buy.price) / buy.price) * 100);
        }
        return Object.entries(groups)
          .filter(([, g]) => g.pnl.length > 0)
          .map(([outcome, g]) => ({
            outcome,
            trades: g.pnl.length,
            avg_hold_h: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.hours)),
            min_hold_h: g.hours.length ? TradingDashboardComponent.round2(Math.min(...g.hours)) : null,
            max_hold_h: g.hours.length ? TradingDashboardComponent.round2(Math.max(...g.hours)) : null,
            avg_pnl_chf: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.pnl)),
            avg_price_chg_pct: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.priceChg)),
          }));
      },
      interpret: (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return { text: 'Noch keine abgeschlossenen Trades.', color: 'neutral' as const };
        const wRow = rows.find((r) => r['outcome'] === 'Gewinner');
        const lRow = rows.find((r) => r['outcome'] === 'Verlierer');
        if (!wRow && !lRow) return { text: 'Noch keine Trades.', color: 'neutral' as const };
        if (!wRow) return { text: `Bisher nur Verlierer-Trades (${lRow!['trades']} Stück). Ø ${(lRow!['avg_hold_h'] as number ?? 0).toFixed(1)} Stunden Haltedauer.`, color: 'neg' as const };
        if (!lRow) return { text: `Bisher nur Gewinner-Trades (${wRow!['trades']} Stück). Ø ${(wRow!['avg_hold_h'] as number ?? 0).toFixed(1)} Stunden Haltedauer.`, color: 'pos' as const };
        const wH = wRow['avg_hold_h'] as number ?? 0;
        const lH = lRow['avg_hold_h'] as number ?? 0;
        const diff = wH - lH;
        let text = '';
        if (diff > 5) {
          text = `Positives Muster: Gewinner werden im Schnitt ${diff.toFixed(1)} Stunden länger gehalten als Verlierer (${wH.toFixed(1)}h vs. ${lH.toFixed(1)}h) — "Gewinne laufen lassen" funktioniert hier.`;
        } else if (diff < -5) {
          text = `Warnsignal: Verlierer werden im Schnitt ${Math.abs(diff).toFixed(1)} Stunden länger gehalten als Gewinner (${lH.toFixed(1)}h vs. ${wH.toFixed(1)}h). Möglicherweise zu langes Festhalten an Verlust-Positionen.`;
        } else {
          text = `Kein klarer Unterschied in der Haltedauer: Gewinner (${wH.toFixed(1)}h) und Verlierer (${lH.toFixed(1)}h) liegen nah beieinander.`;
        }
        return { text, color: diff > 5 ? 'pos' as const : diff < -5 ? 'neg' as const : 'neutral' as const };
      },
    },
    {
      id: 'monthly',
      label: 'Monatliche Performance',
      description: 'Wie entwickelt sich das Ergebnis Monat für Monat? Zeigt Trend, bestes und schlechtestes Monat.',
      sql: `-- Monatliche Performance
SELECT
  to_char(sell.created_at, 'YYYY-MM')   AS month,
  count(*)                               AS trades,
  count(*) FILTER (WHERE realized_pnl > 0) AS wins,
  round(sum(realized_pnl), 2)            AS total_pnl_chf,
  round(avg(realized_pnl), 2)            AS avg_pnl_chf,
  round(sum(fee + fx_fee), 2)            AS total_fees_chf
FROM transactions sell
WHERE action = 'sell' AND opening_transaction_id IS NOT NULL
GROUP BY 1 ORDER BY 1 DESC;`,
      columns: [
        { key: 'month',          label: 'Monat',        format: 'text'         },
        { key: 'trades',         label: 'Trades',       format: 'integer'      },
        { key: 'wins',           label: 'Gewinner',     format: 'integer'      },
        { key: 'total_pnl_chf',  label: 'Gesamt-PnL',   format: 'currency_chf' },
        { key: 'avg_pnl_chf',    label: 'Ø PnL',        format: 'currency_chf' },
        { key: 'total_fees_chf', label: 'Gebühren',     format: 'currency_chf' },
      ],
      compute: (txs: TransactionRow[]) => {
        const sells = txs.filter((t) => t.action === 'sell' && t.opening_transaction_id != null);
        const groups = new Map<string, { wins: number; total: number; pnl: number[]; fees: number[] }>();
        for (const s of sells) {
          const k = s.created_at ? s.created_at.slice(0, 7) : 'Unbekannt';
          if (!groups.has(k)) groups.set(k, { wins: 0, total: 0, pnl: [], fees: [] });
          const g = groups.get(k)!;
          g.total++;
          if ((s.realized_pnl ?? 0) > 0) g.wins++;
          if (s.realized_pnl != null) g.pnl.push(s.realized_pnl);
          g.fees.push(s.fee + s.fx_fee);
        }
        return Array.from(groups.entries())
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([month, g]) => ({
            month,
            trades: g.total,
            wins: g.wins,
            total_pnl_chf: TradingDashboardComponent.round2(g.pnl.reduce((a, b) => a + b, 0)),
            avg_pnl_chf: TradingDashboardComponent.round2(TradingDashboardComponent.avg(g.pnl)),
            total_fees_chf: TradingDashboardComponent.round2(g.fees.reduce((a, b) => a + b, 0)),
          }));
      },
      interpret: (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return { text: 'Noch keine abgeschlossenen Trades.', color: 'neutral' as const };
        const best = [...rows].sort((a, b) => (b['total_pnl_chf'] as number ?? 0) - (a['total_pnl_chf'] as number ?? 0))[0];
        const worst = [...rows].sort((a, b) => (a['total_pnl_chf'] as number ?? 0) - (b['total_pnl_chf'] as number ?? 0))[0];
        const totalPnl = rows.reduce((s, r) => s + (r['total_pnl_chf'] as number ?? 0), 0);
        let text = rows.length === 1
          ? `Erst ein Monat mit Daten. PnL: ${(rows[0]['total_pnl_chf'] as number ?? 0).toFixed(2)} CHF.`
          : `${rows.length} Monate mit Trades. Bestes Monat: ${best['month']} (+${(best['total_pnl_chf'] as number ?? 0).toFixed(2)} CHF). Schlechtestes: ${worst['month']} (${(worst['total_pnl_chf'] as number ?? 0).toFixed(2)} CHF).`;
        if (rows.length >= 3) {
          const recent2 = rows.slice(0, 2).reduce((s, r) => s + (r['total_pnl_chf'] as number ?? 0), 0);
          const older = rows.slice(2).reduce((s, r) => s + (r['total_pnl_chf'] as number ?? 0), 0) / Math.max(1, rows.length - 2);
          const recent2Avg = recent2 / 2;
          if (recent2Avg > older * 1.2) text += ' Positive Tendenz: die letzten 2 Monate liegen über dem Schnitt.';
          else if (recent2Avg < older * 0.8) text += ' Negative Tendenz: die letzten 2 Monate liegen unter dem Schnitt.';
        }
        return { text, color: totalPnl > 0 ? 'pos' as const : totalPnl < 0 ? 'neg' as const : 'neutral' as const };
      },
    },
  ] as const;

  protected readonly selectedQuery = computed(() =>
    this.ANALYSIS_QUERIES.find((q) => q.id === this.selectedAnalysisId()) ?? this.ANALYSIS_QUERIES[0],
  );

  // ── "Ausführen" — full-dataset analysis ─────────────────────────────────
  // When null: results come from the already-loaded (cached, ≤50) transactions.
  // When set: results come from the full transaction log fetched on-demand.
  protected readonly analysisAllTxs = signal<TransactionRow[] | null>(null);
  protected readonly analysisExecuting = signal(false);

  /** Number of transactions the current result set is based on. */
  protected readonly analysisSourceLabel = computed(() => {
    const full = this.analysisAllTxs();
    if (full !== null) return `${full.length} Transaktionen aus der Datenbank`;
    return `${this.transactions().length} gecachte Transaktionen`;
  });

  protected readonly analysisRows = computed((): Record<string, unknown>[] => {
    const query = this.selectedQuery();
    // Prefer the full DB set when "Ausführen" was clicked; fall back to cache.
    const txs = this.analysisAllTxs() ?? this.transactions();
    return query ? query.compute(txs as TransactionRow[]) : [];
  });

  protected readonly analysisInterpretation = computed(() => {
    const query = this.selectedQuery();
    return query ? query.interpret(this.analysisRows()) : { text: '', color: 'neutral' as const };
  });

  /** Fetches ALL transactions from the DB and re-runs the selected analysis. */
  protected async executeSelectedAnalysis(): Promise<void> {
    if (this.analysisExecuting()) return;
    this.analysisExecuting.set(true);
    try {
      // Load every transaction — no artificial limit — so aggregations match
      // what the raw SQL would return against the full table.
      const all = await this.trading.getTransactionLog(10_000);
      this.analysisAllTxs.set(all);
    } catch (e) {
      this.error.set(this.toMessage(e));
    } finally {
      this.analysisExecuting.set(false);
    }
  }

  protected openSqlDialog(): void {
    this.sqlDialogEl?.nativeElement.showModal();
  }

  protected openSqlDialogClose(): void {
    this.sqlDialogEl?.nativeElement.close();
  }

  protected formatAnalysisCell(value: unknown, format: string): string {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    switch (format) {
      case 'percent':    return isNaN(n) ? String(value) : `${n.toFixed(1)}%`;
      case 'currency_chf': return isNaN(n) ? String(value) : `${n >= 0 ? '+' : ''}${n.toFixed(2)} CHF`;
      case 'hours':      return isNaN(n) ? String(value) : n >= 24 ? `${(n / 24).toFixed(1)} Tage` : `${n.toFixed(1)}h`;
      case 'integer':    return isNaN(n) ? String(value) : String(Math.round(n));
      default:           return String(value);
    }
  }

  // ── End SQL-Analyse-Tab ───────────────────────────────────────────────────

  private toMessage(e: unknown): string {
    if (e instanceof Error) {
      return e.message;
    }
    return String(e);
  }
}
