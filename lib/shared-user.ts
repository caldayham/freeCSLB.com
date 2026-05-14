/**
 * Zero-auth MVP: the whole site runs as ONE shared account. Anyone who visits
 * is treated as this user — no login, no email. All reads/writes go through the
 * RLS-bypassing service client (see lib/supabase/server.ts) scoped to this id.
 *
 * This is `cal@cf.design` — the account that owns the ingested fact_state and
 * attempt history. To go back to real per-user auth, restore the original
 * lib/supabase/require-auth.ts and the auth checks in app/page.tsx + actions.ts.
 */
export const SHARED_USER_ID = "8be63a75-4f90-467f-ac3a-605fd5b88a2d";
