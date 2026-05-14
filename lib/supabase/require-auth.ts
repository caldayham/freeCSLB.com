import { createServiceSupabase } from "./server";
import { SHARED_USER_ID } from "@/lib/shared-user";

/**
 * Zero-auth MVP. Every visitor is the one shared account (see lib/shared-user.ts).
 * Returns that user + an RLS-bypassing service client, so protected server
 * components work with no session and no /login redirect.
 *
 * To restore real auth: bring back `supabase.auth.getUser()` + redirect("/login").
 */
export async function requireUser() {
  return { user: { id: SHARED_USER_ID }, supabase: createServiceSupabase() };
}
