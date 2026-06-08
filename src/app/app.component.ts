import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SupabaseService } from './supabase.service';
import { TradingDashboardComponent } from './trading-dashboard.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, TradingDashboardComponent],
  template: `
    <main class="container">
      <h1>Reddit Stocks</h1>

      @if (!supabase.configured) {
        <div class="notice">
          <strong>Supabase ist noch nicht konfiguriert.</strong>
          <p>
            Trage <code>SUPABASE_URL</code> und <code>SUPABASE_ANON_KEY</code> als
            GitHub-Actions-Secrets ein (oder lokal in <code>public/config.js</code>),
            dann wird beim Deploy automatisch die Verbindung hergestellt.
          </p>
        </div>
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
      .notice {
        background: #fff8e1;
        border: 1px solid #ffe082;
        border-radius: 8px;
        padding: 1rem;
      }
      code {
        background: #eee;
        padding: 0.1rem 0.3rem;
        border-radius: 4px;
      }
    `,
  ],
})
export class AppComponent {
  protected readonly supabase = inject(SupabaseService);
}
