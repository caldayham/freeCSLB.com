import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client tied to the current request's cookies.
 * Reads the user session from cookies; respects RLS.
 *
 * Uses the publishable key (with cookies for session). The secret key is for
 * elevated server-only operations (see `serviceClient` below).
 */
export async function createServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase env missing on server (URL or PUBLISHABLE_KEY)");
  }
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (entries: { name: string; value: string; options: CookieOptions }[]) => {
        try {
          for (const { name, value, options } of entries) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, can't set cookies — safe to ignore;
          // a middleware refresh handles session continuity.
        }
      },
    },
  });
}

/**
 * Server-side Supabase client using the SECRET key (sb_secret_...).
 * Bypasses RLS — only use for trusted server-only operations:
 *   - migrations / seed data ingestion
 *   - cross-user analytics
 *   - admin endpoints that you authenticate independently
 *
 * NEVER expose this client (or any data it returns) to untrusted callers.
 */
export function createServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error("Supabase service env missing (URL or SECRET_KEY)");
  }
  // Static (no cookies) client with elevated key. createServerClient works here too
  // but we use the auth-helpers-free form for clarity that this bypasses sessions.
  return createServerClient(url, secret, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
