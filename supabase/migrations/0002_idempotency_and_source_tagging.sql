-- ============================================================
-- 0002 — Patch for an existing 0001 install:
--   (a) add source-tagging columns that were added to 0001 after the
--       initial run (sources[], consensus on facts; bank on questions)
--   (b) add the UNIQUE constraint on questions(external_id) so the
--       ingest script's ON CONFLICT (external_id) works
--
-- Idempotent: safe to re-run.
-- ============================================================

-- --- (a) New columns ---
ALTER TABLE facts
  ADD COLUMN IF NOT EXISTS sources   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS consensus BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS bank TEXT;

-- --- (b) UNIQUE constraint for ON CONFLICT (external_id) ---
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'questions_external_id_key'
  ) THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_external_id_key UNIQUE (external_id);
  END IF;
END $$;
