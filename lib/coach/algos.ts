import type { FactSignals } from "./scoring";

/**
 * A ranking algo is a pure function over a fact's substrate signals → a score.
 * Nothing here mutates anything; the algos just sit on top of the substrate
 * (facts, attempts, fact_state). Swap algos with a switch — the underlying
 * truth is untouched, and every attempt records which algo picked it
 * (`attempts.picked_by`) so the substrate itself carries the experiment.
 *
 * To compare algos fairly, two rules (see the discussion):
 *   - interleave them (alternate question-by-question) — controls for the
 *     "everything gains fast early, slow late" regime confound.
 *   - score them by ONE frozen, exogenous objective — never by an algo's own
 *     definition of mass, or it just agrees with itself.
 */
export type RankAlgo = {
  id: string;
  label: string;
  description: string;
  scoreOf: (s: FactSignals) => number;
};

export const ALGOS: Record<string, RankAlgo> = {
  "leverage-v1": {
    id: "leverage-v1",
    label: "Leverage (mass-weighted)",
    description: "mass · (1 - u²) · retrieval — importance nudges the pick.",
    scoreOf: (s) => s.mass * (1 - s.understanding * s.understanding) * s.retrieval,
  },
  "equal-mass": {
    id: "equal-mass",
    label: "Equal mass",
    description:
      "(1 - u²) · retrieval — mass-blind. Pure uncertainty: an unseen fact (u≈0) " +
      "categorically out-ranks a known one, since it has the most room to gain.",
    scoreOf: (s) => (1 - s.understanding * s.understanding) * s.retrieval,
  },
  "missed-focus": {
    id: "missed-focus",
    label: "Missed-focus",
    description:
      "((1 - u) / 2) · retrieval — mass-blind, asymmetric. Unlike the (1 - u²) " +
      "algos, this is monotonic in u: missed facts (u<0) out-rank unseen (u≈0) " +
      "out-rank known (u>0). A fact you keep missing keeps coming back hard — " +
      "retrieval still gates re-showing it too soon.",
    scoreOf: (s) => ((1 - s.understanding) / 2) * s.retrieval,
  },
};

export const DEFAULT_ALGO_ID = "leverage-v1";

/** Resolve an algo id to its definition, falling back to the default. */
export function getAlgo(id: string | null | undefined): RankAlgo {
  return (id && ALGOS[id]) || ALGOS[DEFAULT_ALGO_ID];
}
