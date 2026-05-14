"use server";

import { createServiceSupabase } from "@/lib/supabase/server";
import { pickNext, type CoachQuestion } from "@/lib/coach/next";
import { retrievalFactor } from "@/lib/coach/scoring";
import { SHARED_USER_ID } from "@/lib/shared-user";

/** Base learning rate — mirrors v_p in the old log_attempt RPC. */
const LEARNING_RATE = 0.3;

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
 * picking the next question is a *separate* call (`pickNextAction`).
 *
 * Zero-auth MVP: this is a TypeScript port of the old `log_attempt` Postgres
 * RPC (migration 0006) — the RPC keyed off `auth.uid()`, which is NULL with no
 * session. Here we run as SHARED_USER_ID via the RLS-bypassing service client
 * and apply the same understanding-scalar math:
 *   correct: u += P·(1-u)·r   (gated by the retrieval factor)
 *   wrong:   u += -P·(1+u)    (not gated)
 * clamped to [-1, +1]. First-ever attempt starts from u=0, r=1.
 */
export async function logAttemptAction(input: LogAttemptInput): Promise<LogAttemptResult> {
  const supabase = createServiceSupabase();
  const correct = input.selectedIndex === input.correctIndex;
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Insert the attempt (source of truth — never lose this row).
  const { data: attempt, error: insErr } = await supabase
    .from("attempts")
    .insert({
      user_id: SHARED_USER_ID,
      question_id: input.questionId,
      session_id: input.sessionId ?? null,
      exam_id: input.examId,
      selected_index: input.selectedIndex,
      correct,
      context: input.context,
      response_time_ms: input.responseTimeMs ?? null,
      picked_by: input.pickedBy ?? null,
      ts: nowIso,
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`insert attempt: ${insErr.message}`);

  // 2. Facts this question tests.
  const { data: linked, error: linkErr } = await supabase
    .from("question_facts")
    .select("fact_id")
    .eq("question_id", input.questionId);
  if (linkErr) throw new Error(`question_facts: ${linkErr.message}`);
  const factIds = (linked ?? []).map((r) => r.fact_id);

  let updatedFacts: FactStateSnapshot[] = [];
  if (factIds.length > 0) {
    // Current state for those facts (so we can apply the delta in TS).
    const { data: existing, error: exErr } = await supabase
      .from("fact_state")
      .select("fact_id, understanding, attempts_count, last_attempt_at")
      .eq("user_id", SHARED_USER_ID)
      .in("fact_id", factIds);
    if (exErr) throw new Error(`fact_state read: ${exErr.message}`);
    const byFact = new Map((existing ?? []).map((r) => [r.fact_id, r]));

    const rows = factIds.map((factId) => {
      const prev = byFact.get(factId);
      let u: number;
      if (!prev) {
        // First attempt: from u=0, r≈1 → correct +P, wrong -P.
        u = correct ? LEARNING_RATE : -LEARNING_RATE;
      } else {
        const cur = Number(prev.understanding);
        if (correct) {
          const r = retrievalFactor(
            prev.last_attempt_at ? new Date(prev.last_attempt_at) : null,
            now,
          );
          u = cur + LEARNING_RATE * (1 - cur) * r;
        } else {
          u = cur - LEARNING_RATE * (1 + cur);
        }
        u = Math.min(1, Math.max(-1, u));
      }
      return {
        user_id: SHARED_USER_ID,
        fact_id: factId,
        exam_id: input.examId,
        understanding: u,
        attempts_count: (prev?.attempts_count ?? 0) + 1,
        last_attempt_at: nowIso,
        last_correct: correct,
        updated_at: nowIso,
      };
    });

    const { data: upserted, error: upErr } = await supabase
      .from("fact_state")
      .upsert(rows, { onConflict: "user_id,fact_id" })
      .select("fact_id, understanding, attempts_count");
    if (upErr) throw new Error(`fact_state upsert: ${upErr.message}`);
    updatedFacts = (upserted ?? []).map((s) => ({
      fact_id: s.fact_id,
      understanding: Number(s.understanding),
      attempts: s.attempts_count,
    }));
  }

  return { attemptId: attempt.id as string, correct, updatedFacts };
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
  const supabase = createServiceSupabase();
  try {
    const { question } = await pickNext(supabase, input.examId, input.excludeQuestionIds, input.algoId);
    return { nextQuestion: question };
  } catch (e) {
    console.error("[pickNextAction] failed:", e);
    return { nextQuestion: null };
  }
}
