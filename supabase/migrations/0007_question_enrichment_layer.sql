-- ============================================================
-- 0007 — Question enrichment layer: the "good to know" augmentation
--
-- Distinct from 0004's empathetic "why" (extended_explanation/metaphor).
-- This is factual augmentation surfaced in the Correct/Incorrect feedback box:
--   acronyms — every acronym/abbreviation in the question or explanation,
--              spelled out (CSLB → Contractors State License Board)
--   notes    — adjacent good-to-know facts, common gotchas, the kind of
--              context that builds the neuropathway around the answer
--
-- Shape (JSONB):
--   { "acronyms": [{ "term": "CSLB", "expansion": "Contractors State..." }],
--     "notes": ["...", "..."] }
--
-- NULL = not yet enriched. The enrich script (scripts/enrich.ts) only touches
-- rows where enrichment IS NULL, so it's resumable and idempotent.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS enrichment JSONB;
