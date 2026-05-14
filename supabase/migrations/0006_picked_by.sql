-- ============================================================
-- 0006 — Record which ranking algo surfaced each question.
--
-- The ranking algo is a pure function sitting on top of the substrate; the
-- substrate (facts, attempts, fact_state) is the source of truth. To compare
-- algos, every attempt records which algo picked the question it answered —
-- so the experiment data lives IN the substrate, no separate log.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS picked_by TEXT;

-- log_attempt gains p_picked_by. Adding a parameter creates a NEW overload, so
-- drop the old 7-arg signature first to avoid two functions lingering.
DROP FUNCTION IF EXISTS log_attempt(UUID, TEXT, SMALLINT, BOOLEAN, TEXT, INT, UUID);

CREATE OR REPLACE FUNCTION log_attempt(
  p_question_id      UUID,
  p_exam_id          TEXT,
  p_selected_index   SMALLINT,
  p_correct          BOOLEAN,
  p_context          TEXT,
  p_response_time_ms INT     DEFAULT NULL,
  p_session_id       UUID    DEFAULT NULL,
  p_picked_by        TEXT    DEFAULT NULL
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
    selected_index, correct, context, response_time_ms, picked_by, ts
  )
  VALUES (
    v_user_id, p_question_id, p_session_id, p_exam_id,
    p_selected_index, p_correct, p_context, p_response_time_ms, p_picked_by, v_now
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
      CASE WHEN p_correct THEN v_p ELSE -v_p END,
      1, v_now, p_correct, v_now
    )
    ON CONFLICT (user_id, fact_id) DO UPDATE SET
      understanding = LEAST(1.0, GREATEST(-1.0,
        CASE
          WHEN p_correct THEN
            fact_state.understanding
            + v_p * (1.0 - fact_state.understanding)
              * (1.0 - EXP(
                  -EXTRACT(EPOCH FROM (
                    v_now - COALESCE(fact_state.last_attempt_at, v_now - INTERVAL '100 years')
                  )) / v_tau_cement
                ))
          ELSE
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

GRANT EXECUTE ON FUNCTION log_attempt(UUID, TEXT, SMALLINT, BOOLEAN, TEXT, INT, UUID, TEXT) TO authenticated;
