// Supabase Edge Function: setup-auth-user
//
// ONE-TIME admin setup helper for the dashboard's login (single user
// "bhorvath" — see trading_schema_v8_auth_gate.sql for why the dashboard now
// requires authentication at all). Creating an Auth user requires the GoTrue
// ADMIN API, which in turn requires the service-role key — exactly the same
// reason `market-scan`/`price-refresh` have to run server-side rather than
// from the browser (the anon key the SPA ships can't do this, by design).
//
// Idempotent and safe to invoke more than once: a second run finds the
// existing account and reports "already exists" rather than erroring or,
// worse, silently resetting whatever password the user has since chosen —
// re-running this must never be able to undo "change your password on first
// login" (see the `must_change_password` flag below).
//
// ── Why a synthetic email for a "username" ──────────────────────────────
// Supabase Auth (GoTrue) is built entirely around email/phone identities;
// there's no first-class "username" concept to hook into. Rather than bolt a
// parallel username system onto it (more moving parts, more to keep in sync),
// the login UI simply presents a "Benutzername" field and silently maps it to
// this one fixed synthetic address before calling `signInWithPassword` — see
// `auth.service.ts`. `.local` is a reserved, non-resolvable TLD: perfect for
// an identity that will never need to send or receive real mail.
// `email_confirm: true` skips the confirmation email GoTrue would otherwise
// try (and fail) to deliver to an address that can't receive one.
//
// ── The `must_change_password` flag ─────────────────────────────────────
// The user asked for "Passwort 1234 initial, beim ersten Login änderbar" —
// Supabase Auth has no built-in "force password change" concept, so this
// implements it with one boolean in `user_metadata`: set to `true` here at
// creation time, read by the frontend right after a successful login to
// decide whether to show the dashboard or a mandatory change-password screen
// first, and flipped to `false` by `AuthService.changePassword` the moment
// the user actually picks a new one. See `auth.service.ts` /
// `change-password.component.ts` for the other half of this flow.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const DASHBOARD_USER_EMAIL = 'bhorvath@reddit-stocks.local';
const INITIAL_PASSWORD = '1234';

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // GoTrue's admin API has no "getUserByEmail" lookup — list and search
    // instead. This project will only ever have this one dashboard account,
    // so a single unpaginated page is more than enough; no need for the
    // pagination dance a general-purpose tool would require.
    const { data: existingPage, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) throw listError;
    const existing = existingPage.users.find((u) => u.email === DASHBOARD_USER_EMAIL);

    if (existing) {
      return new Response(
        JSON.stringify(
          {
            ok: true,
            created: false,
            message:
              `Benutzer ${DASHBOARD_USER_EMAIL} existiert bereits (id ${existing.id}) — ` +
              `nichts verändert (insbesondere NICHT das Passwort zurückgesetzt, ` +
              `falls es seither geändert wurde).`,
          },
          null,
          2,
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: DASHBOARD_USER_EMAIL,
      password: INITIAL_PASSWORD,
      email_confirm: true,
      user_metadata: { must_change_password: true },
    });
    if (createError) throw createError;

    return new Response(
      JSON.stringify(
        {
          ok: true,
          created: true,
          message:
            `Benutzer ${DASHBOARD_USER_EMAIL} angelegt (id ${created.user?.id}). ` +
            `Initial-Passwort gesetzt, must_change_password=true — die App wird beim ` +
            `ersten Login eine Passwortänderung erzwingen.`,
        },
        null,
        2,
      ),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
