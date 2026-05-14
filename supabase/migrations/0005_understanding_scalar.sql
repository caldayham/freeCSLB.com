-- ============================================================
-- 0005 — Understanding scalar: replace the Beta posterior with a single
--        signed score per (user, fact), and rewrite log_attempt to match.
--
-- The model (see the design discussion):
--   understanding ∈ [-1, +1]   — 0 = unexplored, signed "how well do I know it"
--
--   retrieval factor   r = 1 - exp(-Δt / τ_cement)      τ_cement = 240s (4 min)
--                      (≈1 for a first attempt or a long gap; ≈0 right after)
--   correct:   u += P · (1 - u) · r        P = 0.3   (gated — cementing credit)
--   wrong:     u += -P · (1 + u)                     (NOT gated — a miss is honest)
--
-- "% of remaining distance to the cap" gives the ELO/surprise asymmetry for
-- free: a confident miss drops hard, a surprising win jumps hard, and the
-- score saturates toward ±1 without ever reaching it.
--
-- Forgetting (decay toward 0 over days) and the mass-weighted picker live in
-- application code (lib/coach/scoring.ts) — not here.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- Schema: add `understanding`, seed from old posteriors, drop alpha/beta ----

ALTER TABLE fact_state
  ADD COLUMN IF NOT EXISTS understanding NUMERIC NOT NULL DEFAULT 0;

-- Seed understanding from existing Beta posteriors (2·mean − 1) so any test
-- history carries over. Guarded so the migration is re-runnable after the
-- alpha/beta columns are dropped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fact_state' AND column_name = 'posterior_alpha'
  ) THEN
    UPDATE fact_state
    SET understanding = LEAST(1.0, GREATEST(-1.0,
      2.0 * (posterior_alpha / NULLIF(posterior_alpha + posterior_beta, 0)) - 1.0
    ))
    WHERE attempts_count > 0;
  END IF;
END $$;

ALTER TABLE fact_state DROP COLUMN IF EXISTS posterior_alpha;
ALTER TABLE fact_state DROP COLUMN IF EXISTS posterior_beta;

-- ---- log_attempt: rewrite the per-fact update ----

CREATE OR REPLACE FUNCTION log_attempt(
  p_question_id      UUID,
  p_exam_id          TEXT,
  p_selected_index   SMALLINT,
  p_correct          BOOLEAN,
  p_context          TEXT,
  p_response_time_ms INT     DEFAULT NULL,
  p_session_id       UUID    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_user_id     UUID        := auth.uid();
  v_attempt_id  UUID;
  v_now         TIMESTAMPTZ := NOW();
  v_p           NUMERIC     := 0.3;    -- base learning rate
  v_tau_cement  NUMERIC     := 240;    -- retrieval time-constant, seconds (4 min)
  v_fact        RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- 1. Insert the attempt (source of truth — never lose this row).
  INSERT INTO attempts (
    user_id, question_id, session_id, exam_id,
    selected_index, correct, context, response_time_ms, ts
  )
  VALUES (
    v_user_id, p_question_id, p_session_id, p_exam_id,
    p_selected_index, p_correct, p_context, p_response_time_ms, v_now
  )
  RETURNING id INTO v_attempt_id;

  -- 2. Update understanding for every fact this question tests.
  FOR v_fact IN
    SELECT fact_id FROM question_facts WHERE question_id = p_question_id
  LOOP
    INSERT INTO fact_state (
      user_id, fact_id, exam_id,
      understanding, attempts_count, last_attempt_at, last_correct, updated_at
    )
    VALUES (
      v_user_id, v_fact.fact_id, p_exam_id,
      -- First attempt from u=0, r≈1: correct → +P, wrong → -P.
      CASE WHEN p_correct THEN v_p ELSE -v_p END,
      1, v_now, p_correct, v_now
    )
    ON CONFLICT (user_id, fact_id) DO UPDATE SET
      understanding = LEAST(1.0, GREATEST(-1.0,
        CASE
          WHEN p_correct THEN
            -- u += P · (1 - u) · r   — gated by the retrieval factor
            fact_state.understanding
            + v_p * (1.0 - fact_state.understanding)
              * (1.0 - EXP(
                  -EXTRACT(EPOCH FROM (
                    v_now - COALESCE(fact_state.last_attempt_at, v_now - INTERVAL '100 years')
                  )) / v_tau_cement
                ))
          ELSE
            -- u += -P · (1 + u)      — not gated
            fact_state.understanding - v_p * (1.0 + fact_state.understanding)
        END
      )),
      attempts_count  = fact_state.attempts_count + 1,
      last_attempt_at = v_now,
      last_correct    = p_correct,
      updated_at      = v_now;
  END LOOP;

  RETURN v_attempt_id;
END;
$$;

GRANT EXECUTE ON FUNCTION log_attempt(UUID, TEXT, SMALLINT, BOOLEAN, TEXT, INT, UUID) TO authenticated;
