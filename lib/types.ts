/**
 * Shared types matching the Postgres schema.
 * Mirror of supabase/migrations/0001_initial.sql column shapes.
 */

// ---- Reference / content tables ----

export type Exam = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
};

export type Difficulty = "easy" | "medium" | "hard";

export type Fact = {
  id: string;
  exam_id: string;
  statement: string;
  category: string;
  importance_intrinsic: number; // 0-1
  frequency_estimate: number;   // 0-1
  difficulty: Difficulty;
  verified: boolean;
  sources: string[];            // which source bank(s) — ['flashcards', 'ai-expanded']
  consensus: boolean;           // true when fact appears in 2+ banks (high-signal)
  created_at: string;
};

export type FactEdgeKind = "prerequisite_for" | "contrasts_with" | "sibling_of";

export type FactEdge = {
  from_fact_id: string;
  to_fact_id: string;
  kind: FactEdgeKind;
  weight: number;
  created_at: string;
};

/** questions.enrichment JSONB — see scripts/enrich.ts + migration 0007. */
export type QuestionEnrichment = {
  acronyms: { term: string; expansion: string }[];
  notes: string[];
};

export type QuestionType = "mcq" | "calc" | "scenario" | "diagram_text";
export type QuestionSource = "curated" | "generated_variant" | "generated_synth" | "generated_composite";

export type Question = {
  id: string; // uuid
  exam_id: string;
  external_id: string | null;
  stem: string;
  options: [string, string, string, string];
  correct_index: number;
  explanation: string | null;
  reference: string | null;
  // Enrichment layer (from v1 enrichments.json) — the empathetic "why".
  extended_explanation: string | null;
  metaphor: string | null;
  wrong_answers: (string | null)[] | null; // aligned with options; null at correct_index
  // "Good to know" augmentation layer (scripts/enrich.ts) — surfaced in the
  // Correct/Incorrect feedback box. null = not yet enriched.
  enrichment: QuestionEnrichment | null;
  // Empathetic per-wrong-answer coaching (scripts/coach-answers.ts) — aligned
  // with options, null at correct_index; shown in the Incorrect feedback box
  // for the option the learner actually picked. null column = not yet generated.
  answer_coaching: (string | null)[] | null;
  question_type: QuestionType;
  difficulty: Difficulty;
  source: QuestionSource;
  bank: string | null;          // 'flashcards' | 'ai-expanded' | null for single-bank exams
  generated_by: string | null;
  verified: boolean;
  verifier_notes: string | null;
  created_at: string;
};

export type QuestionFact = {
  question_id: string;
  fact_id: string;
  primacy: "primary" | "secondary";
};

// ---- User-scoped tables ----

export type SessionMode = "coach" | "drill" | "exam" | "review";

export type SessionRow = {
  id: string;
  user_id: string;
  exam_id: string;
  mode: SessionMode;
  plan_meta: unknown | null;
  started_at: string;
  ended_at: string | null;
};

export type AttemptContext = "coach_new" | "coach_review" | "drill" | "exam" | "review";

export type Attempt = {
  id: string;
  user_id: string;
  question_id: string;
  session_id: string | null;
  exam_id: string;
  selected_index: number | null;
  correct: boolean;
  context: AttemptContext;
  response_time_ms: number | null;
  ts: string;
};

export type FactState = {
  user_id: string;
  fact_id: string;
  exam_id: string;
  understanding: number; // -1..+1, signed; 0 = unexplored
  attempts_count: number;
  last_attempt_at: string | null;
  last_correct: boolean | null;
  updated_at: string;
};

// ---- Derived classifications ----

export type Coverage = "unseen" | "explored" | "struggling" | "stable" | "mastered";
