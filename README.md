# CSLB Study v2

Fact-graph-backed study platform for CSLB licensing exams. Multi-exam from day 1, **Postgres-only**.

## Architecture

- **Postgres (Supabase)** — everything: facts, fact_edges (the knowledge graph), questions, question→fact mappings, user attempts, sessions, derived fact_state. Auth via Supabase Auth. RLS-protected.
- **Anthropic** — Opus for planning + post-mortem, Sonnet for question generation + verification.

**Core principle.** `attempts` is the source of truth for everything user-specific. `fact_state` (per-user Bayesian posteriors) is materialized but always recomputable from attempts. Algorithm changes don't lose data.

**Why no graph database?** The full knowledge graph is ~334 facts × ~6 edges = ~2000 edges; Postgres handles all our queries in <1ms with recursive CTEs. If we ever need true graph algorithms (PageRank, community detection on millions of edges), the cleanest path is **Apache AGE** — a Postgres extension that adds Cypher to the existing DB, no second database needed. Bolting on a dedicated graph DB is over-engineering for current scale.

## Setup

### Prerequisites

- Node 20+
- Supabase project (free tier fine) — https://supabase.com
- Anthropic API key

### Install + configure

```sh
cd v2
npm install
cp .env.local.example .env.local
```

Fill `.env.local` from the Supabase project's API settings:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Same page → publishable key (`sb_publishable_...`) |
| `SUPABASE_SECRET_KEY` | Same page → secret key (`sb_secret_...`) — **server-only, never commit** |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com |

### Run the migration

In Supabase Dashboard → SQL Editor, paste and run:

```
supabase/migrations/0001_initial.sql
```

That creates: `exams`, `facts`, `fact_edges`, `questions`, `question_facts`, `sessions`, `attempts`, `fact_state` with RLS policies.

### Ingest audited question banks

The ingest script is generic — pass the exam key. Idempotent.

```sh
npm run db:ingest:c27         # 296Q × 334 facts, single-bank ('curated')
npm run db:ingest:lb          # ~398Q across 2 banks ('flashcards' + 'ai-expanded'), canonical facts deduplicated with consensus signal
```

Under the hood: `tsx scripts/ingest.ts <exam>`. Multi-bank exams (like `law-business`) tag each question with its `bank` and each fact records the `sources[]` it appeared in plus a `consensus` boolean (true when the fact shows up in 2+ banks — strong "real exam material" signal).

### Run dev server

```sh
npm run dev
```

Open http://localhost:3000.

## Layout

```
v2/
├── app/
│   ├── page.tsx           Home (loaded-exams + practice/coverage links)
│   ├── layout.tsx         Nav + auth chip
│   ├── login/             Magic-link sign-in
│   ├── auth/
│   │   ├── callback/      Magic-link landing → exchangeCodeForSession
│   │   └── sign-out/      POST → signOut → /login
│   ├── practice/
│   │   ├── page.tsx       Exam picker
│   │   ├── actions.ts     Server action: log_attempt RPC wrapper
│   │   └── [examId]/      Random question + interactive runner
│   └── coverage/
│       ├── page.tsx       Exam picker
│       └── [examId]/      Per-fact mastery view from fact_state
├── lib/
│   ├── supabase/
│   │   ├── client.ts      Browser client (publishable key)
│   │   ├── server.ts      SSR client + service client (secret key)
│   │   └── require-auth.ts  Server-component auth gate
│   ├── coverage.ts        classifyCoverage() — pure mastery classifier
│   └── types.ts           Shared TS types matching the schema
├── middleware.ts          Refreshes auth cookie on every request
├── supabase/
│   └── migrations/        Postgres SQL migrations
└── scripts/
    └── ingest.ts          Generic loader from v1 data files (c27, law-business)
```

## Milestones

| | Status |
|---|---|
| **1. Schema + ingest** | ✅ |
| **2. Auth + attempts + Bayesian fact_state** | ✅ |
| **3. Composite question generation w/ verification** | pending |
| **4. Coach using everything** | ✅ (continuous: algorithmic cold-start + Opus background queue) |

### Milestone 2 — what landed

- Magic-link auth (Supabase Auth, `@supabase/ssr`): `/login`, `/auth/callback`, sign-out POST, plus `middleware.ts` that refreshes the JWT cookie every request.
- Postgres function `log_attempt(...)` (migration 0003): inserts the attempt **and** updates fact_state for every linked fact in a single transaction. Bayesian Beta update with **14-day half-life decay toward the Beta(1,1) prior** — old evidence bleeds back to uncertainty so re-tests count again. Runs under the caller's RLS (no SECURITY DEFINER).
- `/practice/[examId]` — random question, server action wraps the RPC, UI shows correctness + the per-fact posterior shift.
- `/coverage/[examId]` — fact list grouped by category with mastery classification (unseen/explored/struggling/stable/mastered). Reads straight from fact_state, no derived tables.

To run migration 0003 (and 0002 if not already applied), paste both files into Supabase SQL Editor.

### Beyond

- Manually tag ~30 anchor facts per exam (`importance_intrinsic = 1.0`) — boosts planner priority
- Populate `fact_edges` with `prerequisite_for` relationships (manual or LLM-assisted)
- Then composite question generation: target a fact tuple, generate, verify, store

## Versioning

v1 (the original Next.js app + audited C-27 bank) lives in `../version-1/`. It's the data source for the initial ingest and the fallback if v2 isn't ready.
