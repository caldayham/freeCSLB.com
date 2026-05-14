/**
 * Coach scoring — the understanding-scalar model. Pure, debuggable, no LLM.
 *
 * Each fact carries a signed `understanding ∈ [-1, +1]` (stored in fact_state,
 * updated by the log_attempt RPC). This module is the *read* side: it applies
 * forgetting decay, computes a fact's `mass`, and ranks facts for the picker.
 *
 *   effectiveUnderstanding — stored understanding decayed toward 0 over days
 *   retrievalFactor        — 0 right after an attempt → 1 over ~4 min
 *   mass                   — how much a fact is worth knowing (wide range)
 *   rankFacts              — leverage score = mass · (1 - u²) · r
 *
 * The (1 - u²) term is a parabola: it peaks at u = 0 and falls to zero at both
 * u = ±1. Uncertainty is highest for facts you're 50/50 on — unseen, or freshly
 * explored — and lowest for facts you're certain about *either* way. Two things
 * fall out for free:
 *   - exploration is emergent: an unseen fact sits at the peak, so it's
 *     naturally the highest-leverage thing at its mass tier (no quota needed).
 *   - the "struggling fact spirals up forever" trap is gone: a severely
 *     negative fact slides back *down* the curve instead of climbing.
 */

export const TAU_CEMENT_SECONDS = 240; // 4 min — within-session cementing gate
export const TAU_FORGET_DAYS = 7; // between-session forgetting
// Mass spans ~1 .. ~3 — a *gentle* modulation, not the dominant term. At a
// wider range (e.g. ln(50)) a high-mass fact you mostly know out-ranks an
// unseen fact at the (1-u²) peak; at ln(3), (1-u²) drives and mass nudges.
export const MASS_K = Math.log(3);

/**
 * KNOWN LIMITATION — the single `understanding` scalar conflates *retrievability*
 * (do I know it right now) with *stability* (how durably). It can't tell a fact
 * crammed to 0.8 (fragile) from one earned to 0.8 over spaced sessions (durable).
 * FSRS — Anki's scheduler — solves this with a separate per-fact `stability`
 * number that grows most on successful long-delay recalls.
 *
 * Deliberately deferred: this is an exam-cram tool with a near-term deadline,
 * not a lifelong-retention system. The model just needs honest decay and to
 * keep re-testing until exam day. Revisit if "trust solid facts and stop
 * showing them" becomes a felt need.
 */

export type StoredState = {
  understanding: number; // -1..+1, snapshot at last attempt
  attempts: number;
  lastAttemptAt: Date | null;
};

/**
 * Forgetting decay: stored understanding drifts toward 0 over days when the
 * fact isn't refreshed. This is the long-timescale retention pressure — it's
 * what re-surfaces a fact you knew weeks ago.
 */
export function effectiveUnderstanding(s: StoredState, now: Date = new Date()): number {
  if (s.attempts === 0 || s.lastAttemptAt === null) return 0;
  const days = (now.getTime() - s.lastAttemptAt.getTime()) / 86_400_000;
  return s.understanding * Math.exp(-days / TAU_FORGET_DAYS);
}

/**
 * Retrieval factor ∈ [0, 1]: ~0 right after an attempt, climbing to ~1 over
 * ~4 minutes. Gates BOTH the credit a re-test earns (in the RPC) and the
 * picker's "gain if served now" — so a just-missed fact is suppressed, then
 * climbs back as time passes.
 */
export function retrievalFactor(lastAttemptAt: Date | null, now: Date = new Date()): number {
  if (lastAttemptAt === null) return 1; // never attempted — no "too soon"
  const seconds = (now.getTime() - lastAttemptAt.getTime()) / 1000;
  return 1 - Math.exp(-seconds / TAU_CEMENT_SECONDS);
}

/**
 * Mass: how much a fact is worth knowing. ~1 (trivial) to ~3 (core exam
 * material) — a gentle nudge on top of the (1-u²) leverage term, not a term
 * that can override it.
 */
export function mass(f: {
  importance_intrinsic: number;
  frequency_estimate: number;
  consensus: boolean;
}): number {
  const s = 0.5 * f.importance_intrinsic + 0.3 * f.frequency_estimate + 0.2 * (f.consensus ? 1 : 0);
  return Math.exp(MASS_K * s);
}

/**
 * The raw, algo-independent signals for one fact at one moment. A ranking algo
 * is just a pure `(FactSignals) => number` — see lib/coach/algos.ts. These
 * signals are computed from substrate (facts + fact_state); nothing here is
 * algo-specific.
 */
export type FactSignals = {
  factId: string;
  category: string;
  statement: string;
  mass: number;
  understanding: number; // effective (decayed)
  attempts: number;
  retrieval: number; // r at `now`
  daysSinceLast: number | null;
};

/** A fact's signals plus the score the active algo assigned it. */
export type FactScore = FactSignals & { score: number };

export type RankableFact = {
  id: string;
  category: string;
  statement: string;
  importance_intrinsic: number;
  frequency_estimate: number;
  consensus: boolean;
};

/**
 * Compute every fact's signals, score each with the supplied algo `scoreOf`,
 * and return sorted desc. `scoreOf` is the *only* algo-specific input — the
 * signals are pure substrate. Caller has already pulled `facts` and a Map of
 * fact_state rows by fact_id.
 */
export function rankFacts(
  facts: RankableFact[],
  stateByFact: Map<string, StoredState>,
  scoreOf: (s: FactSignals) => number,
  now: Date = new Date(),
): FactScore[] {
  const out: FactScore[] = facts.map((f) => {
    const stored = stateByFact.get(f.id) ?? { understanding: 0, attempts: 0, lastAttemptAt: null };
    const u = effectiveUnderstanding(stored, now);
    const r = retrievalFactor(stored.lastAttemptAt, now);
    const m = mass(f);
    const daysSinceLast =
      stored.lastAttemptAt !== null
        ? (now.getTime() - stored.lastAttemptAt.getTime()) / 86_400_000
        : null;
    const signals: FactSignals = {
      factId: f.id,
      category: f.category,
      statement: f.statement,
      mass: m,
      understanding: u,
      attempts: stored.attempts,
      retrieval: r,
      daysSinceLast,
    };
    return { ...signals, score: scoreOf(signals) };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}
