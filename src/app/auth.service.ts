import { Injectable, inject, signal } from '@angular/core';
import { Session } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';

/**
 * The dashboard now sits behind a login — see `trading_schema_v8_auth_gate.sql`
 * for why a UI lock alone wouldn't be meaningful on a public SPA with a public
 * `anon` key (the data itself now requires a valid session via RLS; this
 * service is what *establishes* that session from the browser side).
 *
 * Single-user app: there is exactly one account, "bhorvath" (created by the
 * one-time `setup-auth-user` Edge Function — see its header comment for the
 * full reasoning, including why a synthetic email is used under the hood for
 * what the UI presents as a plain "Benutzername").
 *
 * Deliberately thin: Supabase Auth already handles session persistence
 * (localStorage), refresh-token rotation, and `onAuthStateChange` — this just
 * wraps the three calls the UI needs (`login`, `logout`, `changePassword`)
 * and exposes the current session as a signal so the rest of the app can
 * reactively gate on it, the same pattern `TradingDashboardComponent` already
 * uses for its data signals.
 */
const USERNAME_TO_EMAIL_SUFFIX = '@reddit-stocks.local';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly supabase = inject(SupabaseService);

  /** Current session, or `null` when logged out. `undefined` means "still
   *  restoring from localStorage" — distinguishing that from "definitely
   *  logged out" matters so `AppComponent` doesn't flash the login screen on
   *  every page reload before Supabase has had a chance to restore an
   *  existing session (see `restoring`). */
  readonly session = signal<Session | null | undefined>(undefined);

  get configured(): boolean {
    return this.supabase.configured;
  }

  /** `true` until the initial session restore (from localStorage / refresh
   *  token) has completed — see `session`'s doc comment for why this exists. */
  get restoring(): boolean {
    return this.session() === undefined;
  }

  constructor() {
    // Initialize eagerly (rather than lazily on first `login()` call) so the
    // session-restore from localStorage — and therefore `restoring` flipping
    // to `false` — happens as soon as the app boots, not only after the user
    // has already seen (and dismissed) a login screen they didn't need to.
    if (this.configured) {
      // Seed the signal with whatever session Supabase can restore from
      // localStorage, then keep it in sync with every subsequent change
      // (login, logout, token refresh, ...) — one subscription covers all of
      // it, no separate "check on load" + "listen for changes" bookkeeping.
      this.supabase.getClient().auth.onAuthStateChange((_event, session) => {
        this.session.set(session);
      });
    } else {
      // No Supabase configured at all (e.g. local dev without `config.js`) —
      // there will never be a session to restore, so don't leave the rest of
      // the app waiting on `restoring` forever.
      this.session.set(null);
    }
  }

  /** Whether the logged-in user must change their password before doing
   *  anything else — the `must_change_password` flag set at account creation
   *  (see `setup-auth-user`) and cleared by `changePassword` below. `false`
   *  while logged out (nothing to gate yet). */
  get mustChangePassword(): boolean {
    return this.session()?.user?.user_metadata?.['must_change_password'] === true;
  }

  /** Maps the plain "Benutzername" the login form collects onto the fixed
   *  synthetic email Supabase Auth actually authenticates against — see
   *  `setup-auth-user`'s header comment for why that indirection exists at
   *  all. Case-insensitive and trimmed, so "Bhorvath " behaves like
   *  "bhorvath" — small UX kindness, zero security relevance (there is
   *  exactly one account; there is nothing to collide with). */
  private toEmail(username: string): string {
    return `${username.trim().toLowerCase()}${USERNAME_TO_EMAIL_SUFFIX}`;
  }

  /** Returns `null` on success, or a user-facing German error message. Never
   *  throws — login failure is an expected, common case the UI needs to show
   *  inline, not an exceptional one. */
  async login(username: string, password: string): Promise<string | null> {
    if (!username.trim() || !password) {
      return 'Bitte Benutzername und Passwort eingeben.';
    }
    const { error } = await this.supabase.getClient().auth.signInWithPassword({
      email: this.toEmail(username),
      password,
    });
    if (error) {
      // GoTrue returns the same generic "Invalid login credentials" for both
      // "no such user" and "wrong password" — and deliberately so (telling
      // the two apart would let an attacker enumerate valid usernames). We
      // pass that same non-committal framing through rather than guessing
      // which one it was.
      return 'Benutzername oder Passwort falsch.';
    }
    return null;
  }

  async logout(): Promise<void> {
    await this.supabase.getClient().auth.signOut();
  }

  /** Returns `null` on success, or a user-facing German error message.
   *  Clears `must_change_password` as part of the SAME update — so a user who
   *  changes their password on first login is never asked again, and a
   *  failed update never leaves the flag in a half-cleared state (Supabase
   *  applies `data` and `password` together, atomically, in one PATCH). */
  async changePassword(newPassword: string): Promise<string | null> {
    if (newPassword.length < 4) {
      // Matches the spirit of the seeded "1234" — this is a single-user
      // hobby dashboard behind a login whose entire job is "keep casual
      // visitors out", not a system that needs NIST-grade complexity rules.
      // A floor mainly guards against fat-fingering an empty/near-empty
      // value, not against brute-forcing (Supabase Auth already rate-limits
      // password attempts server-side regardless of length).
      return 'Das Passwort muss mindestens 4 Zeichen lang sein.';
    }
    const { error } = await this.supabase.getClient().auth.updateUser({
      password: newPassword,
      data: { must_change_password: false },
    });
    if (error) {
      return `Passwort konnte nicht geändert werden: ${error.message}`;
    }
    return null;
  }
}
