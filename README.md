# reddit-stocks

Angular SPA + Supabase (PostgreSQL), gehostet auf GitHub Pages.

Zwei Bereiche:
- **Ticker-Liste** — manuelle Übersicht von Aktien-Tickern mit Erwähnungszählungen
- **Trading-Simulation** — automatisiertes Pump-&-Dip-Dashboard mit 10 000 CHF Startkapital, Swissquote-Gebühren und echten Marktdaten

## Lokale Entwicklung

```bash
npm install
cp public/config.example.js public/config.js
# public/config.js mit SUPABASE_URL und SUPABASE_ANON_KEY füllen (git-ignoriert)
npm start           # → http://localhost:4200
```

## Build & Deployment

```bash
npm run build
```

Deployment auf GitHub Pages via GitHub Actions. Supabase-Zugangsdaten kommen aus den Repository-Secrets `SUPABASE_URL` und `SUPABASE_ANON_KEY`.

---

## Trading-Simulation — Setup

### 1. Datenbank

```
supabase/trading_schema.sql              ← Basis: Tabellen, RLS, Seed-Watchlist
supabase/trading_schema_v*.sql           ← Migrationen (v2–v13), in Reihenfolge anwenden
```

Alle Dateien im Supabase SQL-Editor ausführen. RLS erlaubt nur Lesen via `anon`-Key — geschrieben wird ausschliesslich durch die Edge Functions (Service-Role-Key, umgeht RLS).

### 2. Edge Functions deployen

```bash
supabase functions deploy market-scan    # Discovery, Klassifikation, Trades
supabase functions deploy price-refresh  # Exit-Checks alle 30 Min. zwischen Scans
supabase functions deploy setup-auth-user
```

Kein Reddit-Account oder OAuth-Key nötig — Reddit blockiert Cloud-IPs pauschal, daher nutzt der Scan ausschliesslich cloud-freundliche Quellen (siehe unten).

### 3. Cron-Jobs

In der SQL-Konsole einmalig ausführen (Vorlage am Ende von `trading_schema.sql`):

| Job | Schedule | Zweck |
|-----|----------|-------|
| `market-scan-at-open` | `30 14 * * 1-5` | NYSE-Eröffnung (14:30 UTC = 10:30 EDT / 09:30 EST) |
| `market-scan-during-trading-hours` | `0 15,17,19 * * 1-5` | 3× intraday |
| `price-refresh-every-30min` | `*/30 * * * *` | Positionen neu bepreisen |

Voraussetzung: Extensions `pg_cron` und `pg_net` aktivieren, Service-Role-Key als `service_role_key` im Vault hinterlegen.

### 4. Login einrichten (Migration v8)

```bash
curl -X POST .../functions/v1/setup-auth-user \
     -H "Authorization: Bearer <ANON_ODER_SERVICE_ROLE_KEY>"
```

Legt Benutzer **bhorvath** mit Passwort `1234` an (`must_change_password = true`). Der erste Login erzwingt eine Passwortänderung. Idempotent — erneuter Aufruf überschreibt kein geändertes Passwort.

Migration v8 (`trading_schema_v8_auth_gate.sql`) stellt alle RLS-Policies von "public read" auf "nur mit gültiger Auth-Session lesbar" um — der UI-Login ist also nur die sichtbare Seite; der Schutz greift auch direkt auf der API.

---

## Wie die Simulation funktioniert

### Datenquellen (kein Reddit-OAuth nötig)

Reddit blockiert Anfragen aus Cloud-IPs (AWS/Supabase) per Cloudflare-Sperre — unabhängig vom User-Agent, sowohl auf den öffentlichen `.json`-Endpunkten als auch auf der OAuth-API. Ausserdem gibt Reddit seit Ende 2025 keine neuen Entwickler-Zugangsdaten mehr heraus. Stattdessen werden mehrere unabhängige, cloud-freundliche Quellen kombiniert:

- **ApeWisdom** — schlüsselloser Aggregator für Reddit-Aktiens-Subreddits (primäres Reddit-Signal)
- **old.reddit.com** — ergänzender Direktversuch; scheitert er, wird er ignoriert (Gewicht 0)
- **StockTwits** — bullish/bearish-Stimmung der Trading-Community als Korrelations-Check
- **Yahoo Finance** — echte Kurshistorie (Tageskerzen + 30-Min.-Intraday) für Dip-/Exit-Erkennung
- **CNN Fear & Greed Index** — Markt-Stimmung; Score < 40 = Kauf-Stop (bestehende Positionen unverändert)
- **YF Trending** — ob ein Ticker aktuell auf Yahoo Finance trending ist (informativ, kein Gate)
- **FinViz News** — ob Mainstream-Medien den Ticker bereits erwähnen (informativ; News hinkt Reddit oft 1–3 Tage nach)

Ein Ticker gilt erst als handelbar, wenn Erwähnungs-Spike, Sentiment **und** Kursverlauf übereinstimmend „organisch" aussehen.

### Strategie

| Parameter | Wert |
|-----------|------|
| Startkapital | 10 000 CHF |
| Positionsgrösse | 12 % des Portfolios |
| Max. offene Positionen | 5 |
| Kauf-Trigger | Kurs ≥ 2,5 % unter lokalem Hoch, Verdict = `organic` |
| Take-Profit | +4 % |
| Stop-Loss | −3,5 % |
| Gebühren | Swissquote-Courtage-Staffel + FX-Marge ≈ 0,95 % |

Käufe sind nur während NYSE/NASDAQ-Handelszeiten möglich (09:30–16:00 ET, Mo–Fr). Ausserhalb dieser Zeiten loggt der Scan zwar Signale, kauft aber nicht.

### Watchlist

Vollständig dynamisch — jeder Scan ermittelt die aktuell meistdiskutierten, validierten Ticker und aktualisiert die Watchlist. Ticker, die nicht mehr unter den Top-Trends sind und keine offene Position haben, werden deaktiviert.

### price-refresh

Die schlanke `price-refresh`-Function läuft alle 30 Minuten, bepreist offene Positionen neu und löst Take-Profit/Stop-Loss-Exits aus, ohne den teuren Discovery-Scan zu wiederholen. So bleibt der Dashboard-Portfoliowert durchgehend aktuell.

### Was aufgezeichnet wird

Jede Kauf-Transaktion speichert einen vollständigen Signal-Snapshot (Hype-Score, Z-Score, Erwähnungen, Sentiment, Kurstrend, Fear & Greed, YF Trending, FinViz News). Verkäufe verweisen per `opening_transaction_id` auf den eröffnenden Kauf und tragen einen `exit_reason` (`take-profit` / `stop-loss` / `interim-*`). Das ermöglicht spätere SQL-Analysen: Welche Signalkombinationen performen am besten? Verbessert der Fear & Greed Gate die Rendite?

Das Dashboard zeigt zusätzlich Trefferquote, Ø Gewinn/Verlust, max. Drawdown, Ø Haltedauer sowie einen SPY-Benchmark-Vergleich (normiert auf das Startkapital).
