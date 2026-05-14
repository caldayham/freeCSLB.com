-- ============================================================
-- 0001_initial — Postgres-only schema for cslb-study-v2
--
-- Five concepts:
--   exams           — study domains (c27-audited, law-business-new, ...)
--   facts           — atomic knowledge units (the universe of what to learn)
--   fact_edges      — typed relationships between facts (knowledge graph)
--   questions       — practice questions (test one or more facts)
--   question_facts  — which facts each question tests (with primary/secondary)
--
-- Plus user-scoped tables:
--   sessions        — grouping of attempts
--   attempts        — event log; the SOURCE OF TRUTH for user state
--   fact_state      — materialized Bayesian posterior per (user, fact); rebuildable
--
-- Architectural principle: anything in fact_state can be recomputed from attempts.
-- Never lose attempts.
-- ============================================================

-- ---- Exams ----
CREATE TABLE IF NOT EXISTS exams (
  id          TEXT PRIMARY KEY,                  -- e.g., 'c27-audited', 'law-business-new'
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Facts (atomic knowledge) ----
CREATE TABLE IF NOT EXISTS facts (
  id                    TEXT PRIMARY KEY,        -- e.g., 'fact_001' (stable across migrations)
  exam_id               TEXT NOT NULL REFERENCES exams(id),
  statement             TEXT NOT NULL,
  category              TEXT NOT NULL,
  importance_intrinsic  NUMERIC NOT NULL DEFAULT 0.5,  -- 0-1, anchor weight (manual + derived)
  frequency_estimate    NUMERIC NOT NULL DEFAULT 0.5,  -- 0-1, expected exam recurrence
  difficulty            TEXT NOT NULL DEFAULT 'medium',
  verified              BOOLEAN NOT NULL DEFAULT FALSE,
  sources               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],  -- which source bank(s) this fact came from
  consensus             BOOLEAN NOT NULL DEFAULT FALSE,           -- true when fact appears in 2+ banks (high-signal)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS facts_exam_id_idx ON facts(exam_id);
CREATE INDEX IF NOT EXISTS facts_category_idx ON facts(category);
CREATE INDEX IF NOT EXISTS facts_importance_idx ON facts(exam_id, importance_intrinsic DESC);

-- ---- Fact edges (typed relationships — the knowledge graph) ----
-- prerequisite_for: from is required to understand to
-- contrasts_with:   easily confusable pair (symmetric, but stored as directed for simplicity)
-- sibling_of:       same topic cluster (symmetric, stored as directed)
CREATE TABLE IF NOT EXISTS fact_edges (
  from_fact_id  TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  to_fact_id    TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('prerequisite_for', 'contrasts_with', 'sibling_of')),
  weight        NUMERIC NOT NULL DEFAULT 1.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_fact_id, to_fact_id, kind),
  CHECK (from_fact_id <> to_fact_id)
);

CREATE INDEX IF NOT EXISTS fact_edges_from_kind_idx ON fact_edges(from_fact_id, kind);
CREATE INDEX IF NOT EXISTS fact_edges_to_kind_idx ON fact_edges(to_fact_id, kind);

-- ---- Questions ----
CREATE TABLE IF NOT EXISTS questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id         TEXT NOT NULL REFERENCES exams(id),
  external_id     TEXT UNIQUE,                   -- original ID, e.g., 'c27-audited-202' or 'lb-new-005' — UNIQUE so ingest ON CONFLICT works
  stem            TEXT NOT NULL,
  options         JSONB NOT NULL,                -- ["A","B","C","D"]
  correct_index   SMALLINT NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  explanation     TEXT,
  reference       TEXT,
  question_type   TEXT NOT NULL DEFAULT 'mcq',   -- mcq | calc | scenario | diagram_text
  difficulty      TEXT NOT NULL DEFAULT 'medium',
  source          TEXT NOT NULL,                 -- curated | generated_variant | generated_synth | generated_composite
  bank            TEXT,                          -- which source bank for multi-source exams (e.g., 'flashcards' | 'ai-expanded'); NULL otherwise
  generated_by    TEXT,                          -- model id, e.g., 'claude-opus-4-7'
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  verifier_notes  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS questions_exam_id_idx ON questions(exam_id);
CREATE INDEX IF NOT EXISTS questions_external_id_idx ON questions(external_id);
CREATE INDEX IF NOT EXISTS questions_source_idx ON questions(source);

-- ---- Question → Fact mapping ----
-- A question tests one PRIMARY fact and any number of SECONDARY facts.
-- The planner asks for questions by fact_id; this join is the index.
CREATE TABLE IF NOT EXISTS question_facts (
  question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  fact_id       TEXT NOT NULL REFERENCES facts(id)     ON DELETE CASCADE,
  primacy       TEXT NOT NULL CHECK (primacy IN ('primary', 'secondary')),
  PRIMARY KEY (question_id, fact_id)
);

CREATE INDEX IF NOT EXISTS question_facts_fact_idx ON question_facts(fact_id, primacy);

-- Each question should have exactly one primary fact. (Enforced by app + this partial index.)
CREATE UNIQUE INDEX IF NOT EXISTS question_facts_one_primary_idx
  ON question_facts(question_id) WHERE primacy = 'primary';

-- ---- Sessions ----
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exam_id     TEXT NOT NULL REFERENCES exams(id),
  mode        TEXT NOT NULL,                     -- coach | drill | exam | review
  plan_meta   JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, started_at DESC);

-- ---- Attempts (the event log — source of truth) ----
CREATE TABLE IF NOT EXISTS attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id       UUID NOT NULL REFERENCES questions(id),
  session_id        UUID REFERENCES sessions(id) ON DELETE SET NULL,
  exam_id           TEXT NOT NULL REFERENCES exams(id),
  selected_index    SMALLINT,                    -- NULL = skipped
  correct           BOOLEAN NOT NULL,
  context           TEXT NOT NULL,               -- coach_new | coach_review | drill | exam | review
  response_time_ms  INT,
  ts                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attempts_user_ts_idx ON attempts(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS attempts_user_question_idx ON attempts(user_id, question_id);
CREATE INDEX IF NOT EXISTS attempts_session_idx ON attempts(session_id);

-- ---- Fact state (materialized cache; rebuildable from attempts) ----
CREATE TABLE IF NOT EXISTS fact_state (
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fact_id          TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  exam_id          TEXT NOT NULL REFERENCES exams(id),
  posterior_alpha  NUMERIC NOT NULL DEFAULT 1.0,  -- Beta-distribution successes
  posterior_beta   NUMERIC NOT NULL DEFAULT 1.0,  -- Beta-distribution failures
  attempts_count   INT NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  last_correct     BOOLEAN,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, fact_id)
);

CREATE INDEX IF NOT EXISTS fact_state_user_exam_idx ON fact_state(user_id, exam_id);

-- ============================================================
-- Row-Level Security
-- ============================================================

-- Reference data: world-readable
ALTER TABLE exams           ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_edges      ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_facts  ENABLE ROW LEVEL SECURITY;

-- DROP-then-CREATE pattern keeps this migration re-runnable (CREATE POLICY has no IF NOT EXISTS).
DROP POLICY IF EXISTS "read exams"          ON exams;
DROP POLICY IF EXISTS "read facts"          ON facts;
DROP POLICY IF EXISTS "read fact_edges"     ON fact_edges;
DROP POLICY IF EXISTS "read questions"      ON questions;
DROP POLICY IF EXISTS "read question_facts" ON question_facts;

CREATE POLICY "read exams"          ON exams          FOR SELECT USING (true);
CREATE POLICY "read facts"          ON facts          FOR SELECT USING (true);
CREATE POLICY "read fact_edges"     ON fact_edges     FOR SELECT USING (true);
CREATE POLICY "read questions"      ON questions      FOR SELECT USING (true);
CREATE POLICY "read question_facts" ON question_facts FOR SELECT USING (true);

-- User-scoped: own rows only
ALTER TABLE sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own sessions select"   ON sessions;
DROP POLICY IF EXISTS "own sessions insert"   ON sessions;
DROP POLICY IF EXISTS "own sessions update"   ON sessions;
DROP POLICY IF EXISTS "own sessions delete"   ON sessions;
DROP POLICY IF EXISTS "own attempts select"   ON attempts;
DROP POLICY IF EXISTS "own attempts insert"   ON attempts;
DROP POLICY IF EXISTS "own fact_state select" ON fact_state;
DROP POLICY IF EXISTS "own fact_state insert" ON fact_state;
DROP POLICY IF EXISTS "own fact_state update" ON fact_state;

CREATE POLICY "own sessions select"   ON sessions   FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own sessions insert"   ON sessions   FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own sessions update"   ON sessions   FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own sessions delete"   ON sessions   FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "own attempts select"   ON attempts   FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own attempts insert"   ON attempts   FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own fact_state select" ON fact_state FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own fact_state insert" ON fact_state FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own fact_state update" ON fact_state FOR UPDATE USING (auth.uid() = user_id);
