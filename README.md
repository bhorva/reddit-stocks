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
Scan durchsucht die meistdiskutierten Reddit-Posts nach Cashtags
(`$NVDA`) und ticker-ähnlichen Kürzeln, validiert die Kandidaten gegen
echte Kursdaten und übernimmt die aktuell meistdiskutierten, echten Ticker
in die aktive Watchlist — bisherige Einträge, die nicht mehr zu den
Top-Trends gehören (und keine offene Position haben), werden wieder
deaktiviert. So zeigt die App immer, was *gerade* auf Reddit relevant ist,
statt eine starre Auswahl zu wiederholen.

Einmaliges Setup:

1. **Tabellen anlegen**: [`supabase/trading_schema.sql`](supabase/trading_schema.sql)
   im Supabase SQL-Editor ausführen (legt Tabellen, Policies und eine
   Beispiel-Watchlist an).
2. **Reddit-App erstellen**: auf https://www.reddit.com/prefs/apps eine App vom
   Typ „script“ anlegen, um `client_id` und `client_secret` zu erhalten.
3. **Function deployen und Secrets setzen**:
   ```bash
   supabase functions deploy market-scan
   supabase secrets set REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=...
   ```
4. **Cron aktivieren**: die Schritte am Ende von `supabase/trading_schema.sql`
   ausführen (Extensions `pg_cron`/`pg_net` aktivieren, Function-URL und
   Service-Role-Key im Vault hinterlegen, Job mit `cron.schedule(...)` anlegen).

Das Frontend liest die Ergebnisse nur lesend (`anon`-Key, RLS erlaubt keine
Schreibzugriffe von dort) — gehandelt wird ausschliesslich serverseitig.
