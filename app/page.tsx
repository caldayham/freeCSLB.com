import Link from "next/link";
import { createServerSupabase } from "@/lib/supabase/server";
import { classifyCoverage, COVERAGE_COLORS, COVERAGE_ORDER } from "@/lib/coverage";
import type { Coverage } from "@/lib/types";

type ExamRow = { id: string; name: string; description: string | null };

async function getExamRollup(supabase: Awaited<ReturnType<typeof createServerSupabase>>, examId: string) {
  const [{ data: facts }, { data: states }] = await Promise.all([
    supabase.from("facts").select("id").eq("exam_id", examId),
    supabase.from("fact_state").select("fact_id, understanding, attempts_count").eq("exam_id", examId),
  ]);
  const stateByFact = new Map<string, { understanding: number; n: number }>();
  for (const s of states ?? [])
    stateByFact.set(s.fact_id, { understanding: Number(s.understanding), n: s.attempts_count });
  const counts: Record<Coverage, number> = { unseen: 0, explored: 0, struggling: 0, stable: 0, mastered: 0 };
  for (const f of facts ?? []) {
    const s = stateByFact.get(f.id);
    counts[
      classifyCoverage({
        attempts: s ? s.n : 0,
        understanding: s ? s.understanding : 0,
      })
    ]++;
  }
  return { total: facts?.length ?? 0, counts };
}

export default async function HomePage() {
  const supabase = await createServerSupabase();
  const { data: exams, error } = await supabase.from("exams").select("id, name, description").order("name");
  const { data: userData } = await supabase.auth.getUser();
  const signedIn = !!userData.user;

  if (error) return <p className="text-sm text-red-600">{error.message}</p>;

  const examRows = (exams as ExamRow[] | null) ?? [];

  // Only compute rollups for signed-in users (RLS returns no fact_state rows otherwise).
  const rollups = signedIn
    ? await Promise.all(examRows.map((e) => getExamRollup(supabase, e.id)))
    : examRows.map(() => null);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">CSLB Study v2</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400 mt-1">
          Pick an exam. Drill fast — coverage updates live below the question.
        </p>
      </header>

      {!signedIn ? (
        <section className="rounded-md border border-stone-200 dark:border-stone-800 p-5">
          <p className="text-sm">
            <Link href="/login" className="underline">Sign in</Link> to start.
          </p>
        </section>
      ) : examRows.length === 0 ? (
        <p className="text-xs text-stone-500">
          No exams loaded. Run <code className="font-mono">npm run db:ingest:c27</code> or{" "}
          <code className="font-mono">npm run db:ingest:lb</code>.
        </p>
      ) : (
        <ul className="space-y-3">
          {examRows.map((e, i) => {
            const r = rollups[i];
            return (
              <li key={e.id}>
                <Link
                  href={`/exam/${e.id}`}
                  className="block rounded-md border border-stone-200 dark:border-stone-800 p-5 hover:bg-stone-50 dark:hover:bg-stone-900 transition"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <div>
                      <div className="text-base font-medium">{e.name}</div>
                      {e.description ? (
                        <div className="text-xs text-stone-500 mt-1 max-w-prose">{e.description}</div>
                      ) : null}
                      <div className="text-[10px] text-stone-400 mt-2 font-mono">{e.id}</div>
                    </div>
                  </div>
                  {r ? (
                    <div className="mt-4 grid grid-cols-5 gap-1.5">
                      {COVERAGE_ORDER.map((c) => (
                        <div key={c} className={`rounded p-2 text-center ${COVERAGE_COLORS[c]}`}>
                          <div className="text-sm font-semibold">{r.counts[c]}</div>
                          <div className="text-[9px] uppercase tracking-wide mt-0.5">{c}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-stone-400">v0.1.0 · milestone 2 — auth, attempts, Bayesian fact_state</p>
    </div>
  );
}
