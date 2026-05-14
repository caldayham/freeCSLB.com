import type { Coverage } from "./types";

/**
 * Classify a fact's mastery band from its understanding scalar (-1..+1) +
 * attempt count. Pure function — these thresholds are display constants only,
 * retunable with zero migration.
 *
 *   unseen      — no attempts logged
 *   struggling  — understanding < 0  (actively getting it wrong)
 *   explored    — 0 ≤ understanding < 0.5
 *   stable      — 0.5 ≤ understanding < 0.75
 *   mastered    — understanding ≥ 0.75
 *
 * Bands come from understanding alone — NOT understanding × mass. A trivial
 * fact known cold is still "mastered"; it just contributes few points to the
 * weighted total.
 */
export function classifyCoverage(opts: { attempts: number; understanding: number }): Coverage {
  if (opts.attempts === 0) return "unseen";
  const u = opts.understanding;
  if (u < 0) return "struggling";
  if (u < 0.5) return "explored";
  if (u < 0.75) return "stable";
  return "mastered";
}

export const COVERAGE_ORDER: Coverage[] = ["unseen", "explored", "struggling", "stable", "mastered"];

export const COVERAGE_COLORS: Record<Coverage, string> = {
  unseen: "bg-stone-200 dark:bg-stone-800 text-stone-700 dark:text-stone-300",
  explored: "bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-200",
  struggling: "bg-red-100 dark:bg-red-950 text-red-900 dark:text-red-200",
  stable: "bg-sky-100 dark:bg-sky-950 text-sky-900 dark:text-sky-200",
  mastered: "bg-emerald-100 dark:bg-emerald-950 text-emerald-900 dark:text-emerald-200",
};
