import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from './auth.service';

/**
 * Mandatory "choose your own password" screen, shown by `AppComponent`
 * instead of the dashboard whenever `AuthService.mustChangePassword` is true
 * — i.e. right after the very first login with the seeded initial password
 * ("1234", set by `setup-auth-user`). This is the other half of "Initial soll
 * es auf 1234 definiert werden und beim ersten Login durch mich ersetzbar
 * sein": the account starts with a known, shared default, and the very next
 * thing the real user does is replace it with something only they know.
 *
 * Deliberately NOT skippable — there is no "later" link. A known default
 * credential that can be postponed indefinitely tends to stay the de-facto
 * password forever (the single biggest reason "change the default password"
 * prompts exist as a forced gate in the first place, from routers to CMSes).
 */
@Component({
  selector: 'app-change-password',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="login-card">
      <h2>Passwort ändern</h2>
      <p class="muted">
        Du bist mit dem Start-Passwort angemeldet. Bitte lege jetzt dein eigenes Passwort
        fest, bevor es weitergeht — das Start-Passwort sollte nicht dauerhaft in Gebrauch
        bleiben.
      </p>
      <form (ngSubmit)="submit()">
        <label>
          Neues Passwort
          <input
            type="password"
            name="newPassword"
            autocomplete="new-password"
            [(ngModel)]="newPassword"
            [disabled]="busy()"
            required
          />
        </label>
        <label>
          Neues Passwort bestätigen
          <input
            type="password"
            name="confirmPassword"
            autocomplete="new-password"
            [(ngModel)]="confirmPassword"
            [disabled]="busy()"
            required
          />
        </label>
        @if (error(); as err) {
          <p class="error" role="alert">{{ err }}</p>
        }
        <button type="submit" [disabled]="busy()">
          {{ busy() ? 'Wird gespeichert…' : 'Passwort speichern' }}
        </button>
        <button type="button" class="secondary" (click)="logout()" [disabled]="busy()">
          Abmelden
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
      button.secondary {
        background: transparent;
        color: #888;
        font-weight: 500;
        border: 1px solid #ddd;
      }
      button.secondary:disabled {
        color: #ccc;
        border-color: #eee;
      }
      .error {
        margin: 0;
        color: #c0392b;
        font-size: 0.85rem;
      }
    `,
  ],
})
export class ChangePasswordComponent {
  private readonly auth = inject(AuthService);

  protected newPassword = '';
  protected confirmPassword = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);

    if (this.newPassword !== this.confirmPassword) {
      this.error.set('Die beiden Passwörter stimmen nicht überein.');
      return;
    }
    if (this.newPassword === '1234') {
      this.error.set('Bitte wähle ein anderes Passwort als das Start-Passwort.');
      return;
    }

    this.busy.set(true);
    try {
      const err = await this.auth.changePassword(this.newPassword);
      if (err) {
        this.error.set(err);
        return;
      }
      // On success, `AuthService.session`'s `user_metadata.must_change_
      // password` flips to `false` (the update sets it server-side AND
      // refreshes the local session) and `AppComponent` swaps this screen
      // out for the dashboard reactively — nothing else to do here.
    } finally {
      this.newPassword = '';
      this.confirmPassword = '';
      this.busy.set(false);
    }
  }

  protected async logout(): Promise<void> {
    if (this.busy()) return;
    await this.auth.logout();
  }
}
