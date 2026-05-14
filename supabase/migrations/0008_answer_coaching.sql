-- ============================================================
-- 0008 — Answer coaching: the empathetic "why your answer is wrong" layer
--
-- For every WRONG option of a question, a short re-positioning statement the
-- learner sees in the Incorrect feedback box when they pick that option: it
-- validates the plausible reasoning that made the option tempting, then gently
-- corrects the misconception and points to why the correct answer fits better.
-- Built to loosen a false understanding and seat the right one — not just to
-- mark the answer wrong.
--
-- Shape (JSONB): an array aligned with questions.options —
--   null at the correct index (and any option left uncovered),
--   a coaching string at each wrong index.
--   e.g. ["You might have reasoned...", null, "This is tempting because...", "..."]
--
-- NULL column = not yet generated. scripts/coach-answers.ts only touches rows
-- where answer_coaching IS NULL, so it's resumable and idempotent.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS answer_coaching JSONB;
