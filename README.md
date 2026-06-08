# reddit-stocks

Angular SPA + Supabase (PostgreSQL), gehostet auf GitHub Pages.

Die App zeigt eine Liste von Aktien-Tickern und wie oft sie erwähnt wurden, und
erlaubt das Hinzufügen neuer Einträge über ein einfaches Formular.

## Lokale Entwicklung

```bash
npm install
cp public/config.example.js public/config.js
```

Trage in `public/config.js` deine Supabase-Projektdaten (`SUPABASE_URL` und den
öffentlichen `SUPABASE_ANON_KEY`) ein. Die Datei ist git-ignoriert und wird nie
committet.

```bash
npm start
```

Die App ist dann unter `http://localhost:4200` erreichbar.

## Build

```bash
npm run build
```

## Deployment

Das Deployment auf GitHub Pages läuft über GitHub Actions. Die Supabase-Zugangsdaten
werden dabei aus den Repository-Secrets `SUPABASE_URL` und `SUPABASE_ANON_KEY`
generiert — es muss keine `config.js` im Repo liegen.

## Datenbank

Das Datenbankschema befindet sich in [`supabase/schema.sql`](supabase/schema.sql).

## Trading-Simulation (Pump &amp; Dip)

Die App enthält zusätzlich ein Dashboard für eine automatisierte
Handelssimulation: Startkapital 10 000 CHF, Swissquote-Gebühren, ein Scan
alle 6 Stunden auf Basis echter Reddit-Erwähnungen und Kursdaten, sowie ein
Log aller Käufe/Verkäufe und ein Chart der Portfolioentwicklung über die
Zeit. Die Auswertung läuft serverseitig als Supabase Edge Function
(`supabase/functions/market-scan`) und wird per `pg_cron` getriggert —
unabhängig davon, ob die App im Browser offen ist.

Die Watchlist ist **dynamisch**: es gibt keine feste Ticker-Liste. Jeder
Scan ermittelt die aktuell meistdiskutierten, echten Ticker, validiert sie
gegen echte Kursdaten und übernimmt sie in die aktive Watchlist — bisherige
Einträge, die nicht mehr zu den Top-Trends gehören (und keine offene
Position haben), werden wieder deaktiviert. So zeigt die App immer, was
*gerade* relevant ist, statt eine starre Auswahl zu wiederholen.

**Mehrere Quellen statt einer einzigen, fragilen** — Supabase Edge Functions
laufen auf AWS-Infrastruktur, und Reddit blockiert (über Cloudflare) Anfragen
aus Cloud-/Rechenzentrums-IP-Bereichen pauschal mit `403`, sowohl an die
öffentlichen `*.json`-Endpunkte als auch an die OAuth-API — unabhängig vom
`User-Agent`. Selbstständige OAuth-Zugangsdaten vergibt Reddit ausserdem seit
Ende 2025 nicht mehr an neue Entwickler. Statt uns auf einen einzigen,
blockierten Pfad zu verlassen, holt der Scan daher mehrere unabhängige,
cloud-freundliche Quellen ein und korreliert sie:

- **[ApeWisdom](https://apewisdom.io/api/)** — ein kostenloser, schlüsselloser
  Aggregator, der die wichtigsten Aktien-Subreddits bereits selbst scannt und
  Erwähnungs-Rankings bereitstellt. Das ist unser primäres
  Reddit-Signal — er übernimmt das Reddit-Scraping von Infrastruktur aus,
  die Reddit nicht blockiert.
- **`old.reddit.com`** — ein direkter, aber bewusst nur ergänzender Versuch:
  schlägt er fehl (vermutlich IP-Block), wird das geloggt und ignoriert; das
  Ergebnis trägt einfach mit Gewicht 0 bei. Sollte Reddit die Sperre für
  Cloud-IPs jemals lockern, liefert dieser Pfad ohne Codeänderung wieder Daten.
- **[StockTwits](https://api.stocktwits.com/)** — eine kostenlose,
  schlüssellose Stimmungsquelle (bullish/bearish-Tags der Trading-Community),
  die als Korrelations-Check dient: bestätigt die breite Masse den Hype, oder
  wirkt er einseitig fabriziert?
- **[Yahoo Finance](https://query1.finance.yahoo.com/)** — echte Kurshistorie
  über die öffentliche, schlüssellose Chart-JSON-API als fundamentale
  „hat sich der Kurs wirklich bewegt"-Bestätigung. (Ursprünglich nutzten wir
  Stooq, dessen CSV-Endpunkt inzwischen aber eine JS-Bot-Verifizierungsseite
  statt Daten liefert — auch ausserhalb von Cloud-IPs.)

Erst wenn Erwähnungs-Spitzen, Stimmung **und** Kursverlauf übereinstimmend
„organisch" aussehen, gilt ein Ticker als handelbar — eine einzelne, laute
Quelle kann die Simulation nicht in einen Trade treiben.

**Portfolio-Wert bleibt aktuell**: Eine zweite, bewusst sehr schlanke Function
(`supabase/functions/price-refresh`) läuft per eigenem `pg_cron`-Job alle 30
Minuten, bepreist offene Positionen neu, löst Take-Profit/Stop-Loss-Exits ggf.
schon zwischen den vollen 6h-Scans aus und schreibt einen frischen
`balance_history`-Snapshot. So zeigt das Dashboard durchgehend den aktuellen
Wert, ohne dass dafür der teure Discovery-Scan (mehrere externe APIs,
Klassifikation, ggf. neue Käufe) öfter laufen müsste.

Einmaliges Setup:

1. **Tabellen anlegen**: [`supabase/trading_schema.sql`](supabase/trading_schema.sql)
   im Supabase SQL-Editor ausführen (legt Tabellen, Policies und eine
   Beispiel-Watchlist an).
2. **Functions deployen**:
   ```bash
   supabase functions deploy market-scan
   supabase functions deploy price-refresh
   ```
   Eine Reddit-App-Registrierung ist **nicht nötig**: Reddit hat die
   selbstständige Erstellung von OAuth-Zugangsdaten Ende 2025 eingestellt
   (manuelle Prüfung, mehrwöchige Wartezeit, persönliche Projekte werden
   kaum bewilligt — Stichwort „Responsible Builder Policy“). Die Function
   nutzt stattdessen Reddits öffentliche, unauthentifizierte JSON-Endpunkte
   (`https://www.reddit.com/r/<sub>/hot.json`, `.../search.json`), die mit
   einem aussagekräftigen `User-Agent`-Header frei lesbar bleiben — völlig
   ausreichend für einen 6-stündlichen Scan dreier Subreddits.
3. **Cron aktivieren**: die Schritte am Ende von `supabase/trading_schema.sql`
   ausführen (Extensions `pg_cron`/`pg_net` aktivieren, Function-URLs und
   Service-Role-Key im Vault hinterlegen, je einen Job für `market-scan`
   [alle 6h, Discovery & Trading] und `price-refresh` [alle 30 Minuten,
   Neubewertung offener Positionen] mit `cron.schedule(...)` anlegen).

Das Frontend liest die Ergebnisse nur lesend (`anon`-Key, RLS erlaubt keine
Schreibzugriffe von dort) — gehandelt wird ausschliesslich serverseitig.

### Prozess-Verbesserungen v2 (FX-Kosten, Z-Score, Benchmark, Trade-Verknüpfung)

Nach einer kritischen Durchsicht der Strategie wurden folgende Verbesserungen
ergänzt (Migration: [`supabase/trading_schema_v2_migration.sql`](supabase/trading_schema_v2_migration.sql),
rein additiv und idempotent — **einmalig im Supabase SQL-Editor ausführen**,
nachdem `trading_schema.sql` bereits angewendet wurde):

- **Realistische FX-Kosten**: Trades in US-Tickern von einem CHF-Konto aus
  verursachen bei Swissquote zusätzlich zur Courtage eine
  Devisen-Umtauschmarge (≈0,95&nbsp;%). Das wurde bisher ignoriert; jetzt
  berechnet `fxFee()` in beiden Edge Functions diese Marge auf jeder
  Transaktion und schreibt sie separat in die neuen Spalten
  `transactions.currency` / `transactions.fx_fee` (zusätzlich zu `fee`,
  der reinen Brokerage-Courtage). Das Dashboard summiert beide für
  „Gesamtgebühren“ und zeigt sie in der Transaktionstabelle mit
  „(inkl. FX)“-Hinweis kombiniert an.
- **Z-Score statt Ad-hoc-Formel für den Hype-Score**: Die Klassifikation
  vergleicht die aktuelle Erwähnungszahl jetzt über einen echten
  Stichproben-Z-Score (`(x − μ) / σ` über die historischen Scans desselben
  Tickers) mit dem Mittelwert, statt mit einer simplen Schwellen-Heuristik —
  statistisch robuster bei unterschiedlich volatilen Tickern. Der Z-Score
  fliesst auch in die geloggte `reason`-Begründung ein (`z=...`).
- **Intraday-Kursdaten für Exit-Entscheidungen**: Zusätzlich zur täglichen
  Historie holt `market-scan` jetzt 30-Minuten-Kerzen der letzten 5 Tage
  (`fetchIntradayPrices`) und bevorzugt sie für den aktuellen Kurs und das
  „Hoch der letzten Tage“ — Dip-/Exit-Erkennung reagiert dadurch deutlich
  zeitnäher als auf Basis von Tagesschlusskursen, ohne dass deswegen öfter
  der teure volle Scan laufen müsste (das übernimmt weiterhin
  `price-refresh` alle 30 Minuten).
- **SPY-Benchmark-Vergleich**: Jeder `balance_history`-Snapshot speichert
  jetzt zusätzlich den aktuellen SPY-Kurs (`spy_price`). Das Dashboard
  normiert ihn auf das Startkapital und zeichnet ihn als gestrichelte
  Vergleichslinie neben der Portfoliokurve — die einzige Möglichkeit,
  ehrlich zu beurteilen, ob die Strategie überhaupt einen Mehrwert
  gegenüber „Geld einfach in einen Indexfonds stecken“ bietet.
- **Strukturierte Trade-Verknüpfung & Snapshots fürs Lernen**: Jede
  Kauf-Transaktion speichert jetzt einen JSON-„Signal-Snapshot“
  (`signal_snapshot`: Hype-Score, Z-Score, Erwähnungen, Sentiment-Verhältnis,
  Kurstrend, Abstand vom Hoch, Verdict, Anzahl Intraday-Datenpunkte) — der
  komplette Merkmalsvektor zum Entscheidungszeitpunkt. Verkäufe verweisen
  per `opening_transaction_id` zurück auf den eröffnenden Kauf und tragen
  einen `exit_reason` (`take-profit` / `stop-loss` / `interim-take-profit` /
  `interim-stop-loss`). Damit lassen sich künftig Fragen wie „wie performen
  Trades mit hohem Z-Score im Schnitt?“ oder „wie lange werden Gewinner im
  Schnitt gehalten?“ direkt per SQL beantworten, statt Freitext-Begründungen
  manuell zu rekonstruieren.
- **Neue Strategie-Kennzahlen im Dashboard**: Trefferquote, Ø Gewinn/Verlust,
  maximaler Drawdown und Ø Haltedauer (aus verknüpften Buy→Sell-Paaren) — sie
  beantworten „funktioniert die Strategie wirklich“, was die blosse
  Gesamt-PnL-Zahl allein nicht zeigen kann (eine hohe Trefferquote mit
  winzigen Gewinnen und seltenen riesigen Verlusten sieht in der Summe
  identisch aus wie das Gegenteil).
- **Scan-Frische-Anzeige**: Das Dashboard zeigt jetzt Zeitpunkt und Alter des
  letzten `market-scan`-Laufs an und markiert ihn visuell, sobald er
  deutlich älter als der reguläre 6-Stunden-Rhythmus ist — so fällt ein
  lautlos hängengebliebener Cron-Job sofort auf, statt nur als unauffällig
  flacher Chart zu erscheinen.
- **Korrigierte Währungsbeschriftungen**: Aktienkurse, Einstiegspreise und
  Watchlist-Preise sind tatsächlich in USD (nicht CHF, wie zuvor teils
  beschriftet) — ein erläuternder Hinweis im Dashboard macht zudem
  transparent, dass die Simulation 1 USD ≈ 1 CHF rechnet (kein
  Wechselkursmodell), aber die reale FX-Marge als Gebühr abbildet.

Bestehende Datensätze von vor der Migration behalten einfach ihre
Default-/`null`-Werte (`currency='USD'`, `fx_fee=0`, `signal_snapshot=null`,
`opening_transaction_id=null`, `exit_reason=null`, `spy_price=null`) — das
spiegelt akkurat wider, dass diese Daten vor der ausführlicheren Protokollierung
entstanden sind, statt Werte zu erfinden, die nie erhoben wurden.

Nach der Migration müssen beide Edge Functions neu deployt werden, damit sie
die neuen Spalten befüllen:

```bash
supabase functions deploy market-scan
supabase functions deploy price-refresh
```
