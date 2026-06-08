import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService, StockRow } from './supabase.service';
import { TradingDashboardComponent } from './trading-dashboard.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, TradingDashboardComponent],
  template: `
    <main class="container">
      <h1>Reddit Stocks</h1>
      <p class="subtitle">Angular SPA + Supabase (PostgreSQL), gehostet auf GitHub Pages</p>

      @if (!supabase.configured) {
        <div class="notice">
          <strong>Supabase ist noch nicht konfiguriert.</strong>
          <p>
            Trage <code>SUPABASE_URL</code> und <code>SUPABASE_ANON_KEY</code> als
            GitHub-Actions-Secrets ein (oder lokal in <code>public/config.js</code>),
            dann wird beim Deploy automatisch die Verbindung hergestellt.
          </p>
        </div>
      } @else {
        <form class="row" (ngSubmit)="add()">
          <input
            name="ticker"
            [(ngModel)]="ticker"
            placeholder="Ticker, z. B. GME"
            maxlength="10"
            required
          />
          <input
            name="mentions"
            type="number"
            [(ngModel)]="mentions"
            placeholder="Erwähnungen"
            min="0"
          />
          <button type="submit" [disabled]="busy()">Hinzufügen</button>
          <button type="button" (click)="reload()" [disabled]="busy()">
            Neu laden
          </button>
        </form>

        @if (error()) {
          <div class="error">{{ error() }}</div>
        }

        @if (busy()) {
          <p>Lade …</p>
        } @else if (stocks().length === 0) {
          <p>Noch keine Einträge.</p>
        } @else {
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Erwähnungen</th>
                <th>Erstellt</th>
              </tr>
            </thead>
            <tbody>
              @for (s of stocks(); track s.id) {
                <tr>
                  <td>{{ s.ticker }}</td>
                  <td>{{ s.mentions }}</td>
                  <td>{{ s.created_at | date: 'short' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      }

      <app-trading-dashboard />
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 720px;
        margin: 0 auto;
        padding: 2rem 1rem;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h1 {
        margin-bottom: 0.25rem;
      }
      .subtitle {
        color: #666;
        margin-top: 0;
      }
      .row {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin: 1.5rem 0;
      }
      input {
        padding: 0.5rem 0.75rem;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 1rem;
      }
      button {
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 6px;
        background: #ff4500;
        color: #fff;
        font-size: 1rem;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      button[type='button'] {
        background: #555;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        padding: 0.5rem;
        border-bottom: 1px solid #eee;
      }
      .notice {
        background: #fff8e1;
        border: 1px solid #ffe082;
        border-radius: 8px;
        padding: 1rem;
      }
      .error {
        background: #fdecea;
        border: 1px solid #f5c6cb;
        color: #a12622;
        border-radius: 8px;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
      }
      code {
        background: #eee;
        padding: 0.1rem 0.3rem;
        border-radius: 4px;
      }
    `,
  ],
})
export class AppComponent implements OnInit {
  protected readonly supabase = inject(SupabaseService);

  protected ticker = '';
  protected mentions: number | null = null;

  protected readonly stocks = signal<StockRow[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    if (this.supabase.configured) {
      void this.reload();
    }
  }

  async reload(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.stocks.set(await this.supabase.listStocks());
    } catch (e) {
      this.error.set(this.toMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async add(): Promise<void> {
    const ticker = this.ticker.trim().toUpperCase();
    if (!ticker) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.supabase.addStock(ticker, this.mentions ?? 0);
      this.ticker = '';
      this.mentions = null;
      await this.reload();
    } catch (e) {
      this.error.set(this.toMessage(e));
      this.busy.set(false);
    }
  }

  private toMessage(e: unknown): string {
    if (e instanceof Error) {
      return e.message;
    }
    return String(e);
  }
}
