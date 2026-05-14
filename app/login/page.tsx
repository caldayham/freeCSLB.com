"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
      return;
    }
    setStatus("sent");
  }

  return (
    <div className="max-w-sm mx-auto py-12 space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-sm text-stone-500 mt-1">Magic link, no password.</p>
      </header>

      {status === "sent" ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          Check your inbox. The link will sign you in and bounce you back here.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-stone-500">Email</span>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-stone-300 dark:border-stone-700 bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={status === "sending"}
            className="w-full rounded-md bg-stone-900 dark:bg-stone-100 text-stone-50 dark:text-stone-900 px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {status === "sending" ? "Sending…" : "Send magic link"}
          </button>
          {status === "error" && errorMsg ? (
            <p className="text-xs text-red-600">{errorMsg}</p>
          ) : null}
        </form>
      )}
    </div>
  );
}
