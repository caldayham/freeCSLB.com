import { redirect } from "next/navigation";
import { createServerSupabase } from "./server";

/**
 * Server-component helper. Returns the current user or redirects to /login.
 * Use at the top of any protected server component or server action.
 */
export async function requireUser() {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  return { user: data.user, supabase };
}
