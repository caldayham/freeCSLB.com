-- ============================================================
-- 0004 — Question enrichment: the empathetic "why" layer
--
-- v1 generated three enrichment fields per question (enrichments.json):
--   extended_explanation — the deep "why" behind the fact
--   metaphor             — a memorable analogy
--   wrong_answers        — per-option array; each non-null entry explains why
--                          that wrong option is tempting and bridges to the
--                          correct answer. The entry at correct_index is null.
--
-- Ingest merges these from version-1/data/enrichments.json by external_id.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS extended_explanation TEXT,
  ADD COLUMN IF NOT EXISTS metaphor             TEXT,
  ADD COLUMN IF NOT EXISTS wrong_answers        JSONB;
