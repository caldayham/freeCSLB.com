import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "CSLB Study v2",
  description: "Fact-graph-backed study platform for CSLB exams",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  const user = data.user;

  return (
    <html lang="en">
      <body className="bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
        <div className="flex justify-center px-4 py-8">
          {/* Left rail — portal target for the floating coach chat. Stays
              zero-width until an exam page's CoachChat portals in, so the
              content column is unaffected on non-exam pages. */}
          <div id="coach-chat-rail" className="shrink-0" />
          <div className="w-full max-w-3xl min-w-0 space-y-8">
            <nav className="flex items-center justify-between text-sm">
              <Link href="/" className="font-semibold tracking-tight">CSLB v2</Link>
              <div className="text-xs text-stone-500">
                {user ? (
                  <form action="/auth/sign-out" method="post" className="flex items-center gap-3">
                    <span className="font-mono">{user.email}</span>
                    <button type="submit" className="underline hover:text-stone-900 dark:hover:text-stone-100">sign out</button>
                  </form>
                ) : (
                  <Link href="/login" className="underline hover:text-stone-900 dark:hover:text-stone-100">sign in</Link>
                )}
              </div>
            </nav>
            {children}
          </div>
          {/* Top-level coverage rail — portal target. Stays zero-width (and
              invisible) until an exam page's CoachFlow portals its live
              coverage bar in, so the nav + page header above align to the
              content column's right edge, not the bar's. */}
          <div id="coverage-rail" className="shrink-0" />
        </div>
      </body>
    </html>
  );
}
