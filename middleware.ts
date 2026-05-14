import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Refreshes the Supabase auth cookie on every request so server components
 * see a non-stale session. Without this, the JWT eventually expires and
 * RPC calls start failing with "not authenticated" even though the user
 * is logged in.
 *
 * Required pattern from @supabase/ssr: create the response first, pass cookie
 * setters to the client, then call `supabase.auth.getUser()` to trigger a
 * refresh if needed.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (entries: { name: string; value: string; options: CookieOptions }[]) => {
        // Apply to both the request (so this same handler sees them) and the response.
        for (const { name, value } of entries) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of entries) response.cookies.set(name, value, options);
      },
    },
  });

  // Triggers the cookie refresh if needed. Result intentionally unused.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // Skip static assets — only run on actual route requests.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
