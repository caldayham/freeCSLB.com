import type { SupabaseClient } from "@supabase/supabase-js";
import { rankFacts, type FactScore, type StoredState } from "./scoring";
import { getAlgo } from "./algos";
import type { Question } from "@/lib/types";

/** A question plus: the coach's one-line rationale, the ids of every fact it
 *  tests (so the coverage bar can highlight which slices it moves), the id of
 *  the ranking algo that surfaced it (provenance for the event log + the
 *  attempt's `picked_by`), and the rank-debug snapshot that *justified* this
 *  pick (so the event log can show "why was I asked this"). */
export type CoachQuestion = Question & {
  why: string | null;
  factIds: string[];
  pickedBy: string;
  topRanked: RankDebugEntry[];
};

const QUESTION_COLUMNS =
  "id, exam_id, external_id, stem, options, correct_index, explanation, reference, extended_explanation, metaphor, wrong_answers, enrichment, answer_coaching, question_type, difficulty, source, bank, generated_by, verified, verifier_notes, created_at";

// ---------------------------------------------------------------------------
// Shared prep
// ---------------------------------------------------------------------------

/** Rank every fact in the exam, scored by the given algo. */
async function rankExamFacts(
  supabase: SupabaseClient,
  examId: string,
  algoId: string,
): Promise<{ ranked: FactScore[]; stateByFact: Map<string, StoredState> }> {
  const [{ data: facts, error: factsErr }, { data: states, error: statesErr }] = await Promise.all([
    supabase
      .from("facts")
      .select("id, statement, category, importance_intrinsic, frequency_estimate, consensus")
      .eq("exam_id", examId),
    supabase
      .from("fact_state")
      .select("fact_id, understanding, attempts_count, last_attempt_at")
      .eq("exam_id", examId),
  ]);
  if (factsErr) throw new Error(`facts: ${factsErr.message}`);
  if (statesErr) throw new Error(`fact_state: ${statesErr.message}`);
  if (!facts || facts.length === 0) throw new Error(`no facts loaded for exam '${examId}'`);

  const stateByFact = new Map<string, StoredState>();
  for (const s of states ?? []) {
    stateByFact.set(s.fact_id, {
      understanding: Number(s.understanding),
      attempts: s.attempts_count,
      lastAttemptAt: s.last_attempt_at ? new Date(s.last_attempt_at) : null,
    });
  }
  return { ranked: rankFacts(facts, stateByFact, getAlgo(algoId).scoreOf), stateByFact };
}

/** One row of the rank-debug payload — the leverage score with its components
 *  broken out, surfaced to the client's event log for algorithm tuning. */
export type RankDebugEntry = {
  factId: string;
  category: string;
  mass: number;
  understanding: number;
  retrieval: number;
  score: number;
  attempts: number;
};

/** Fetch full question rows for a set of ids, returned as a Map. */
async function hydrateQuestions(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, Question>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("questions").select(QUESTION_COLUMNS).in("id", ids);
  if (error) throw new Error(`hydrate questions: ${error.message}`);
  const map = new Map<string, Question>();
  for (const q of (data as Question[]) ?? []) map.set(q.id, q);
  return map;
}

/** Every fact id each question tests, grouped by question — drives the
 *  coverage-bar highlight for the question currently on screen. */
async function factsByQuestion(
  supabase: SupabaseClient,
  questionIds: string[],
): Promise<Map<string, string[]>> {
  if (questionIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("question_facts")
    .select("question_id, fact_id")
    .in("question_id", questionIds);
  if (error) throw new Error(`question_facts: ${error.message}`);
  const map = new Map<string, string[]>();
  for (const r of (data as { question_id: string; fact_id: string }[]) ?? []) {
    const arr = map.get(r.question_id) ?? [];
    arr.push(r.fact_id);
    map.set(r.question_id, arr);
  }
  return map;
}

type QFRow = {
  question_id: string;
  fact_id: string;
  primacy: "primary" | "secondary";
  questions: { id: string; stem: string } | { id: string; stem: string }[];
};

/** question_facts rows for a set of facts, grouped by fact, primary-first,
 *  capped, with excluded question ids filtered out. */
async function candidateQuestionsByFact(
  supabase: SupabaseClient,
  factIds: string[],
  excludeQuestionIds: Set<string>,
  perFactCap: number,
): Promise<Map<string, { qid: string; stem: string; primacy: "primary" | "secondary" }[]>> {
  const { data, error } = await supabase
    .from("question_facts")
    .select("question_id, fact_id, primacy, questions!inner(id, stem)")
    .in("fact_id", factIds);
  if (error) throw new Error(`question_facts: ${error.message}`);

  const byFact = new Map<string, { qid: string; stem: string; primacy: "primary" | "secondary" }[]>();
  for (const r of (data as QFRow[]) ?? []) {
    if (excludeQuestionIds.has(r.question_id)) continue;
    const qobj = Array.isArray(r.questions) ? r.questions[0] : r.questions;
    if (!qobj) continue;
    const list = byFact.get(r.fact_id) ?? [];
    list.push({ qid: r.question_id, stem: qobj.stem, primacy: r.primacy });
    byFact.set(r.fact_id, list);
  }
  for (const [k, v] of byFact) {
    v.sort((a, b) => (a.primacy === b.primacy ? 0 : a.primacy === "primary" ? -1 : 1));
    byFact.set(k, v.slice(0, perFactCap));
  }
  return byFact;
}

// ---------------------------------------------------------------------------
// The picker — pure algorithmic, instant, no LLM. One question at a time:
// every pick is computed fresh against current fact_state. No queue, no batch.
// ---------------------------------------------------------------------------

function algorithmicWhy(f: FactScore): string {
  if (f.attempts === 0) return `New territory — ${f.category}.`;
  return `${f.category} — understanding ${(f.understanding * 100).toFixed(0)}% after ${f.attempts} attempt${
    f.attempts === 1 ? "" : "s"
  }.`;
}

/**
 * Pick the single highest-leverage question not in the exclude window, scored
 * by `algoId`. The returned question carries the rank-debug snapshot that
 * *justified* it (`.topRanked`) — so the event log can answer "why was I asked
 * this". One rank pass — THE picker, used for cold-start and every refill.
 */
export async function pickNext(
  supabase: SupabaseClient,
  examId: string,
  excludeQuestionIds: string[],
  algoId: string,
): Promise<{ question: CoachQuestion | null }> {
  const { ranked } = await rankExamFacts(supabase, examId, algoId);
  const topRanked: RankDebugEntry[] = ranked.slice(0, 12).map((f) => ({
    factId: f.factId,
    category: f.category,
    mass: f.mass,
    understanding: f.understanding,
    retrieval: f.retrieval,
    score: f.score,
    attempts: f.attempts,
  }));

  // Walk facts by descending leverage; take the first whose best question
  // isn't in the exclude window. (40 = headroom past a full exclude window.)
  const exclude = new Set(excludeQuestionIds);
  const poolFacts = ranked.slice(0, 40);
  const qByFact = await candidateQuestionsByFact(
    supabase,
    poolFacts.map((f) => f.factId),
    exclude,
    1,
  );

  let picked: { qid: string; why: string } | null = null;
  for (const f of poolFacts) {
    const qs = qByFact.get(f.factId);
    if (qs && qs.length > 0) {
      picked = { qid: qs[0].qid, why: algorithmicWhy(f) };
      break;
    }
  }
  if (!picked) return { question: null };

  const [hydrated, factMap] = await Promise.all([
    hydrateQuestions(supabase, [picked.qid]),
    factsByQuestion(supabase, [picked.qid]),
  ]);
  const q = hydrated.get(picked.qid);
  return {
    question: q
      ? {
          ...q,
          why: picked.why,
          factIds: factMap.get(picked.qid) ?? [],
          pickedBy: getAlgo(algoId).id,
          topRanked,
        }
      : null,
  };
}
