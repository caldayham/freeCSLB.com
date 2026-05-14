import Link from "next/link";
import { requireUser } from "@/lib/supabase/require-auth";
import { SHARED_USER_ID } from "@/lib/shared-user";
import { pickNext } from "@/lib/coach/next";
import { mass } from "@/lib/coach/scoring";
import { DEFAULT_ALGO_ID } from "@/lib/coach/algos";
import { CoachFlow } from "./coach-flow";
import { CoachChat } from "./coach-chat";
import type { ChartFactState, FactMeta } from "./category-chart";

/**
 * The one exam page: a continuous coach drill. The server picks Q1
 * algorithmically (instant — zero cold-start wait) and hands off to CoachFlow,
 * which keeps the queue full via Opus in the background.
 */
export default async function ExamPage({
  params,
}: {
  params: Promise<{ examId: string }>;
}) {
  const { examId } = await params;
  const { supabase } = await requireUser();

  const { data: exam, error: examErr } = await supabase
    .from("exams")
    .select("id, name")
    .eq("id", examId)
    .maybeSingle();
  if (examErr) return <p className="text-sm text-red-600">{examErr.message}</p>;
  if (!exam) {
    return (
      <p className="text-sm text-stone-500">
        No exam with id <code className="font-mono">{examId}</code>.{" "}
        <Link href="/" className="underline">Back</Link>
      </p>
    );
  }

  // Static fact metadata + current per-user state for the coverage chart, plus
  // the full attempt history (RLS-scoped to this user) that seeds the accuracy
  // tracker — so it survives reloads instead of starting blank each session.
  const [
    { data: facts, error: factsErr },
    { data: states, error: statesErr },
    { data: attempts, error: attemptsErr },
  ] = await Promise.all([
    supabase
      .from("facts")
      .select("id, category, importance_intrinsic, frequency_estimate, consensus")
      .eq("exam_id", examId),
    supabase
      .from("fact_state")
      .select("fact_id, understanding, attempts_count")
      .eq("exam_id", examId)
      .eq("user_id", SHARED_USER_ID),
    supabase
      .from("attempts")
      .select("correct")
      .eq("exam_id", examId)
      .eq("user_id", SHARED_USER_ID)
      .order("ts", { ascending: true }),
  ]);
  if (factsErr) return <p className="text-sm text-red-600">{factsErr.message}</p>;
  if (statesErr) return <p className="text-sm text-red-600">{statesErr.message}</p>;
  if (attemptsErr) return <p className="text-sm text-red-600">{attemptsErr.message}</p>;
  if (!facts || facts.length === 0) {
    return (
      <p className="text-sm text-stone-500">
        No facts ingested for <code className="font-mono">{examId}</code> yet.
      </p>
    );
  }

  // Mass computed server-side from the facts' content signals — it's what
  // sizes each slice in the coverage rainbow.
  const factMeta: FactMeta[] = facts.map((f) => ({
    id: f.id,
    category: f.category,
    mass: mass(f),
  }));
  const initialFactState: ChartFactState = {};
  for (const s of states ?? []) {
    initialFactState[s.fact_id] = {
      understanding: Number(s.understanding),
      attempts: s.attempts_count,
    };
  }

  // Every attempt ever, oldest-first — ScoreChart chunks this into runs of 4.
  const initialResults: boolean[] = (attempts ?? []).map((a) => a.correct);

  // Cold-start Q1 — same picker as every subsequent question, just server-side.
  // Uses the default algo; the client's selected algo takes over from Q2.
  const { question: firstQuestion } = await pickNext(supabase, examId, [], DEFAULT_ALGO_ID);
  if (!firstQuestion) {
    return <p className="text-sm text-stone-500">No questions available for {examId}.</p>;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{exam.name}</h1>
          <p className="text-xs text-stone-500 mt-1 font-mono">{exam.id}</p>
        </div>
        <Link href="/" className="text-xs text-stone-500 underline hover:text-stone-900 dark:hover:text-stone-100">
          ← exams
        </Link>
      </header>

      <CoachFlow
        examId={examId}
        firstQuestion={firstQuestion}
        facts={factMeta}
        initialFactState={initialFactState}
        initialResults={initialResults}
      />

      <CoachChat examId={examId} examName={exam.name} />
    </div>
  );
}
