import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Magic-link landing route. Supabase sends users here with a `code` query
 * param; we exchange it for a session (which sets the auth cookies via
 * createServerSupabase's setAll), then bounce them to wherever they were
 * trying to go (?next=/practice/...) or the home page.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (!code) return NextResponse.redirect(new URL("/login", url.origin));

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const failed = new URL("/login", url.origin);
    failed.searchParams.set("error", error.message);
    return NextResponse.redirect(failed);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
