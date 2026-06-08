import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from './auth.service';
import { ChangePasswordComponent } from './change-password.component';
import { LoginComponent } from './login.component';
import { SupabaseService } from './supabase.service';
import { TradingDashboardComponent } from './trading-dashboard.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ChangePasswordComponent, LoginComponent, TradingDashboardComponent],
  template: `
    <main class="container">
      <div class="title-row">
        <h1>Reddit Stocks</h1>
        @if (auth.session(); as session) {
          <div class="session-info">
            <span class="muted">Angemeldet als <strong>bhorvath</strong></span>
            <button type="button" class="logout-btn" (click)="auth.logout()">Abmelden</button>
          </div>
        }
      </div>

      @if (!supabase.configured) {
        <div class="notice">
          <strong>Supabase ist noch nicht konfiguriert.</strong>
          <p>
            Trage <code>SUPABASE_URL</code> und <code>SUPABASE_ANON_KEY</code> als
            GitHub-Actions-Secrets ein (oder lokal in <code>public/config.js</code>),
            dann wird beim Deploy automatisch die Verbindung hergestellt.
          </p>
        </div>
      } @else if (auth.restoring) {
        <!--
          Brief "is there already a session in localStorage?" window right
          after boot — rendering NOTHING here (rather than the login screen)
          avoids a jarring login-flash-then-dashboard sequence on every normal
          page reload while an existing session is being restored. Genuinely
          short-lived (one localStorage read + an optional token refresh), so
          a bare loading line is enough; no skeleton/spinner machinery needed.
        -->
        <p class="muted loading-line">Sitzung wird geprüft…</p>
      } @else if (!auth.session()) {
        <app-login />
      } @else if (auth.mustChangePassword) {
        <app-change-password />
      } @else {
        <app-trading-dashboard />
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 1440px;
        margin: 0 auto;
        padding: 2rem 1.5rem;
        font-family: system-ui, -apple-system, sans-serif;
      }
      .title-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      h1 {
        margin-bottom: 0.25rem;
      }
      .session-info {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        font-size: 0.85rem;
      }
      .muted {
        color: #888;
      }
      .loading-line {
        margin-top: 2rem;
        text-align: center;
      }
      .logout-btn {
        font: inherit;
        font-size: 0.8rem;
        padding: 0.3rem 0.7rem;
        border: 1px solid #ddd;
        border-radius: 6px;
        background: #fff;
        color: #555;
        cursor: pointer;
      }
      .logout-btn:hover {
        background: #f5f5f5;
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
  protected readonly auth = inject(AuthService);
}
