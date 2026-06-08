import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from './auth.service';

/**
 * Login screen shown by `AppComponent` whenever there's no active session —
 * see `trading_schema_v8_auth_gate.sql` for why the dashboard now requires
 * one at all. Single-user app (just "bhorvath"), so this is intentionally a
 * plain username + password form, not a "create account" / "forgot password"
 * flow — there is exactly one account, created once by `setup-auth-user`.
 *
 * Kept as its own component (rather than inline in `AppComponent`'s template)
 * for the same reason `TradingDashboardComponent` is its own component: it
 * has real local state (form fields, in-flight/error state) that has no
 * business living in the root component.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="login-card">
      <h2>Anmeldung erforderlich</h2>
      <p class="muted">
        Dieses Dashboard zeigt eine laufende Handels-Simulation mit Echtdaten und ist
        seit Kurzem durch einen Login geschützt.
      </p>
      <form (ngSubmit)="submit()">
        <label>
          Benutzername
          <input
            type="text"
            name="username"
            autocomplete="username"
            [(ngModel)]="username"
            [disabled]="busy()"
            required
          />
        </label>
        <label>
          Passwort
          <input
            type="password"
            name="password"
            autocomplete="current-password"
            [(ngModel)]="password"
            [disabled]="busy()"
            required
          />
        </label>
        @if (error(); as err) {
          <p class="error" role="alert">{{ err }}</p>
        }
        <button type="submit" [disabled]="busy()">
          {{ busy() ? 'Anmeldung läuft…' : 'Anmelden' }}
        </button>
      </form>
    </div>
  `,
  styles: [
    `
      .login-card {
        max-width: 360px;
        margin: 3rem auto;
        padding: 1.75rem;
        border: 1px solid #e0e0e0;
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
      }
      h2 {
        margin: 0 0 0.5rem;
      }
      .muted {
        color: #888;
        font-size: 0.85rem;
        line-height: 1.4;
        margin: 0 0 1.25rem;
      }
      form {
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.85rem;
        font-weight: 600;
        color: #444;
      }
      input {
        font: inherit;
        padding: 0.5rem 0.6rem;
        border: 1px solid #ccc;
        border-radius: 6px;
      }
      input:focus {
        outline: 2px solid #4a90d9;
        outline-offset: 1px;
      }
      button {
        font: inherit;
        font-weight: 600;
        padding: 0.6rem 1rem;
        border: none;
        border-radius: 6px;
        background: #1a73e8;
        color: #fff;
        cursor: pointer;
      }
      button:disabled {
        background: #9bbbe8;
        cursor: default;
      }
      .error {
        margin: 0;
        color: #c0392b;
        font-size: 0.85rem;
      }
    `,
  ],
})
export class LoginComponent {
  private readonly auth = inject(AuthService);

  protected username = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    try {
      const err = await this.auth.login(this.username, this.password);
      if (err) {
        this.error.set(err);
        return;
      }
      // On success, `AuthService.session` updates via `onAuthStateChange` and
      // `AppComponent` swaps this screen out reactively — nothing else to do
      // here. Clear the password field regardless of outcome: leaving a
      // typed password sitting in a form after a failed attempt (e.g. if the
      // user goes to look something up and comes back) is needless exposure.
    } finally {
      this.password = '';
      this.busy.set(false);
    }
  }
}
