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
