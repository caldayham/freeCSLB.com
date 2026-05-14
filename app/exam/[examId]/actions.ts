"use server";

import { createServerSupabase } from "@/lib/supabase/server";
import { pickNext, type CoachQuestion } from "@/lib/coach/next";

export type LogAttemptInput = {
  questionId: string;
  examId: string;
  selectedIndex: number;
  correctIndex: number;
  context: "drill" | "exam" | "review" | "coach_new" | "coach_review";
  responseTimeMs?: number;
  sessionId?: string | null;
  /** Algo that surfaced this question — recorded as the attempt's provenance. */
  pickedBy?: string | null;
};

/** Minimal fact_state snapshot — enough to re-classify coverage on the client. */
export type FactStateSnapshot = {
  fact_id: string;
  understanding: number;
  attempts: number;
};

export type LogAttemptResult = {
  attemptId: string;
  correct: boolean;
  /** Fresh state for every fact this question touched — drives the live chart. */
  updatedFacts: FactStateSnapshot[];
};

/**
 * Logs the attempt and reads back the touched facts' fresh state. That's it —
 * picking the next question is a *separate* call (`pickNextAction`), so the
 * next question can be prefetched while the user is still on the current one
 * rather than racing the explanation-read window.
 *
 * The UI never blocks on this — it shows correctness instantly from props and
 * fires this in the background; `updatedFacts` animates the chart a beat later.
 */
export async function logAttemptAction(input: LogAttemptInput): Promise<LogAttemptResult> {
  const supabase = await createServerSupabase();
  const correct = input.selectedIndex === input.correctIndex;

  const { data: attemptId, error: rpcErr } = await supabase.rpc("log_attempt", {
    p_question_id: input.questionId,
    p_exam_id: input.examId,
    p_selected_index: input.selectedIndex,
    p_correct: correct,
    p_context: input.context,
    p_response_time_ms: input.responseTimeMs ?? null,
    p_session_id: input.sessionId ?? null,
    p_picked_by: input.pickedBy ?? null,
  });
  if (rpcErr) throw new Error(`log_attempt RPC: ${rpcErr.message}`);
  if (!attemptId) throw new Error("log_attempt returned no attempt id");

  // Updated fact_state for the facts this question touched.
  const { data: linked, error: linkErr } = await supabase
    .from("question_facts")
    .select("fact_id")
    .eq("question_id", input.questionId);
  if (linkErr) throw new Error(`question_facts: ${linkErr.message}`);
  const factIds = (linked ?? []).map((r) => r.fact_id);

  let updatedFacts: FactStateSnapshot[] = [];
  if (factIds.length > 0) {
    const { data: states, error: stateErr } = await supabase
      .from("fact_state")
      .select("fact_id, understanding, attempts_count")
      .in("fact_id", factIds);
    if (stateErr) throw new Error(`fact_state: ${stateErr.message}`);
    updatedFacts = (states ?? []).map((s) => ({
      fact_id: s.fact_id,
      understanding: Number(s.understanding),
      attempts: s.attempts_count,
    }));
  }

  return { attemptId: attemptId as string, correct, updatedFacts };
}

export type PickNextInput = {
  examId: string;
  /** Recently-served question ids + the one currently on screen — kept out. */
  excludeQuestionIds: string[];
  /** Algo to rank with. */
  algoId: string;
};

/**
 * Picks the next question against current state, ranked by `algoId`. Separate
 * from `logAttemptAction` on purpose: the client fires this the moment a
 * question is *shown* — not when it's answered — so the next question is
 * prefetched against pre-answer state and the "Next" button is instant.
 *
 * The cost: the pick "lags one answer behind" — it doesn't reflect the answer
 * to the question currently on screen. That answer lands on the pick *after*.
 */
export async function pickNextAction(
  input: PickNextInput,
): Promise<{ nextQuestion: CoachQuestion | null }> {
  const supabase = await createServerSupabase();
  try {
    const { question } = await pickNext(supabase, input.examId, input.excludeQuestionIds, input.algoId);
    return { nextQuestion: question };
  } catch (e) {
    console.error("[pickNextAction] failed:", e);
    return { nextQuestion: null };
  }
}
