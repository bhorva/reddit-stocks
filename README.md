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
- **[Stooq](https://stooq.com/)** — echte Kurshistorie als fundamentale
  „hat sich der Kurs wirklich bewegt"-Bestätigung.

Erst wenn Erwähnungs-Spitzen, Stimmung **und** Kursverlauf übereinstimmend
„organisch" aussehen, gilt ein Ticker als handelbar — eine einzelne, laute
Quelle kann die Simulation nicht in einen Trade treiben.

Einmaliges Setup:

1. **Tabellen anlegen**: [`supabase/trading_schema.sql`](supabase/trading_schema.sql)
   im Supabase SQL-Editor ausführen (legt Tabellen, Policies und eine
   Beispiel-Watchlist an).
2. **Function deployen**:
   ```bash
   supabase functions deploy market-scan
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
   ausführen (Extensions `pg_cron`/`pg_net` aktivieren, Function-URL und
   Service-Role-Key im Vault hinterlegen, Job mit `cron.schedule(...)` anlegen).

Das Frontend liest die Ergebnisse nur lesend (`anon`-Key, RLS erlaubt keine
Schreibzugriffe von dort) — gehandelt wird ausschliesslich serverseitig.
