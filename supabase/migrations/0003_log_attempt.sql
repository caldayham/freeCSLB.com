-- ============================================================
-- 0003 — Atomic log_attempt RPC
--
-- One Postgres function that:
--   1. Inserts a row into `attempts` (the source-of-truth event log)
--   2. For each fact linked to the question (via question_facts), updates
--      the user's fact_state posterior using a Bayesian Beta-distribution
--      update with time-decay-toward-prior.
--
-- All in a single transaction. Either everything commits or nothing does.
--
-- Math (per fact):
--   τ_days = (NOW - last_attempt_at), zero if first attempt
--   decay  = exp(-τ_days / HALF_LIFE_DAYS)          -- 14-day half-life
--   α'     = 1 + decay·(α - 1) + (correct ? 1 : 0)
--   β'     = 1 + decay·(β - 1) + (correct ? 0 : 1)
--
-- Interpretation: old evidence (alpha/beta accumulated long ago) bleeds back
-- toward the uninformative prior Beta(1,1). Recent evidence dominates. This
-- is what "I knew it last week but I'm rusty now" looks like in math.
--
-- SECURITY INVOKER (the default): the function executes as the calling user,
-- so the existing RLS policies on attempts/fact_state still apply. No magic.
-- ============================================================

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
  v_user_id        UUID := auth.uid();
  v_attempt_id     UUID;
  v_now            TIMESTAMPTZ := NOW();
  v_half_life_secs NUMERIC := 14.0 * 86400;   -- 14-day half-life, in seconds
  v_fact           RECORD;
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

  -- 2. Update fact_state for every fact this question tests.
  --    A question with 1 primary + 2 secondary facts updates 3 fact_state rows.
  FOR v_fact IN
    SELECT fact_id FROM question_facts WHERE question_id = p_question_id
  LOOP
    INSERT INTO fact_state (
      user_id, fact_id, exam_id,
      posterior_alpha, posterior_beta,
      attempts_count, last_attempt_at, last_correct, updated_at
    )
    VALUES (
      v_user_id, v_fact.fact_id, p_exam_id,
      1.0 + (CASE WHEN p_correct THEN 1.0 ELSE 0.0 END),
      1.0 + (CASE WHEN p_correct THEN 0.0 ELSE 1.0 END),
      1, v_now, p_correct, v_now
    )
    ON CONFLICT (user_id, fact_id) DO UPDATE SET
      posterior_alpha =
        1.0
        + EXP(-EXTRACT(EPOCH FROM (v_now - COALESCE(fact_state.last_attempt_at, v_now))) / v_half_life_secs)
          * (fact_state.posterior_alpha - 1.0)
        + (CASE WHEN p_correct THEN 1.0 ELSE 0.0 END),
      posterior_beta =
        1.0
        + EXP(-EXTRACT(EPOCH FROM (v_now - COALESCE(fact_state.last_attempt_at, v_now))) / v_half_life_secs)
          * (fact_state.posterior_beta - 1.0)
        + (CASE WHEN p_correct THEN 0.0 ELSE 1.0 END),
      attempts_count  = fact_state.attempts_count + 1,
      last_attempt_at = v_now,
      last_correct    = p_correct,
      updated_at      = v_now;
  END LOOP;

  RETURN v_attempt_id;
END;
$$;

GRANT EXECUTE ON FUNCTION log_attempt(UUID, TEXT, SMALLINT, BOOLEAN, TEXT, INT, UUID) TO authenticated;
