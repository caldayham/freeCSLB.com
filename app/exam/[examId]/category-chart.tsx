export type FactMeta = { id: string; category: string; mass: number };
export type ChartFactState = Record<string, { understanding: number; attempts: number }>;

/**
 * Color a fact directly from its understanding scalar (-1..+1). It's a rainbow:
 *
 *   -1 ───── 0 ──────────────── +1
 *   red  orange  yellow  green  blue  indigo
 *   missed×N    unseen   learning   →   mastered
 *
 * u = 0 (unexplored) is one flat yellow. Negatives ramp fast to red (a couple
 * misses and you see it). Positives sweep the long way through green → indigo.
 */
function understandingColor(u: number): string {
  const hue = u >= 0 ? 60 + u * 210 : Math.max(0, 60 + u * 100);
  return `hsl(${Math.round(hue)} 78% 55%)`;
}

/**
 * The coverage bar IS the distribution. Every fact is a slice; slices are
 * sorted by understanding, colored by it, and **sized by mass** — a core exam
 * fact is a wide band, a trivial one a sliver, so a pile of low-mass facts
 * can't make coverage look worse than it is. A 1px gap between every slice
 * shows the actual fact density and makes massive facts pop.
 *
 * Horizontal: most-negative left → most-positive right.
 * Vertical: most-positive (mastered) top → most-negative (missed) bottom.
 *
 * `highlightFactIds` — when set, the slices for those facts get a bright inset
 * ring and the rest dim back, so you can see exactly which fact(s) the question
 * on screen will move.
 */
function RainbowBar({
  facts,
  factState,
  orientation = "horizontal",
  tall = false,
  highlightFactIds,
}: {
  facts: FactMeta[];
  factState: ChartFactState;
  orientation?: "horizontal" | "vertical";
  tall?: boolean;
  highlightFactIds?: string[];
}) {
  const highlight = highlightFactIds && highlightFactIds.length > 0 ? new Set(highlightFactIds) : null;
  const ascending = [...facts].sort((a, b) => {
    const ua = factState[a.id]?.understanding ?? 0;
    const ub = factState[b.id]?.understanding ?? 0;
    return ua - ub;
  });
  // Vertical reads "good = up", so highest understanding renders first (top).
  const ordered = orientation === "vertical" ? ascending.reverse() : ascending;

  // No `overflow-hidden` — the highlighted slice's outer glow needs to escape.
  const containerClass =
    orientation === "vertical"
      ? "flex flex-col h-full w-full gap-px rounded-sm bg-stone-300 dark:bg-stone-700"
      : `flex w-full ${tall ? "h-4" : "h-2"} gap-px rounded-sm bg-stone-300 dark:bg-stone-700`;

  return (
    <div className={containerClass}>
      {ordered.map((f) => {
        const u = factState[f.id]?.understanding ?? 0;
        const isHighlit = highlight?.has(f.id) ?? false;
        const dimmed = highlight !== null && !isHighlit;
        return (
          <div
            key={f.id}
            className={[
              "min-w-0 min-h-0 transition-all duration-500",
              // Highlighted: an outer white glow that radiates past the slice,
              // so even a 1px-tall low-mass slice is clearly visible.
              isHighlit
                ? "relative z-10 shadow-[0_0_8px_3px_rgba(255,255,255,0.9)]"
                : "",
              dimmed ? "opacity-90" : "",
            ].join(" ")}
            style={{ flex: `${f.mass} 1 0`, backgroundColor: understandingColor(u) }}
            title={`${f.category} · understanding ${(u * 100).toFixed(0)} · mass ${f.mass.toFixed(1)}`}
          />
        );
      })}
    </div>
  );
}

/**
 * Split the exam into three buckets by understanding sign — positive (got it
 * right more than wrong), unseen (never moved off zero), negative — and report
 * each bucket two ways: as a share of total **mass** (importance-weighted) and
 * as a share of **fact count** (every fact equal). Six numbers; they shift live
 * as answers land.
 */
type StateStats = {
  posMassPct: number; posEqPct: number;
  zeroMassPct: number; zeroEqPct: number;
  negMassPct: number; negEqPct: number;
};

function computeStateStats(facts: FactMeta[], factState: ChartFactState): StateStats {
  let totalMass = 0, posMass = 0, negMass = 0, zeroMass = 0;
  let pos = 0, neg = 0, zero = 0;
  for (const f of facts) {
    const u = factState[f.id]?.understanding ?? 0;
    totalMass += f.mass;
    if (u > 0) { posMass += f.mass; pos += 1; }
    else if (u < 0) { negMass += f.mass; neg += 1; }
    else { zeroMass += f.mass; zero += 1; }
  }
  const n = facts.length || 1;
  const m = totalMass || 1;
  return {
    posMassPct: (posMass / m) * 100, posEqPct: (pos / n) * 100,
    zeroMassPct: (zeroMass / m) * 100, zeroEqPct: (zero / n) * 100,
    negMassPct: (negMass / m) * 100, negEqPct: (neg / n) * 100,
  };
}

/** One bucket's readout: a colored label + the mass-weighted % over the
 *  equal-weight %. Mono + tabular so digits don't jiggle as they change. */
function StatRow({
  label,
  color,
  massPct,
  eqPct,
}: {
  label: string;
  color: string;
  massPct: number;
  eqPct: number;
}) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] font-medium" style={{ color }}>
        {label}
      </div>
      <div className="font-mono tabular-nums text-sm">
        {massPct.toFixed(1)}%<span className="text-[9px] text-stone-400 ml-1">mass</span>
      </div>
      <div className="font-mono tabular-nums text-xs text-stone-400">
        {eqPct.toFixed(1)}%<span className="text-[9px] ml-1">even</span>
      </div>
    </div>
  );
}

/**
 * Headline coverage rainbow — every fact in the exam as one full-height
 * vertical stack, sorted + colored + sized by understanding/mass — with the
 * six-number state readout stacked alongside it (positive at top, unseen
 * middle, negative bottom, matching the bar's own gradient).
 */
export function OverallBar({
  facts,
  factState,
  highlightFactIds,
}: {
  facts: FactMeta[];
  factState: ChartFactState;
  highlightFactIds?: string[];
}) {
  const s = computeStateStats(facts, factState);
  return (
    <div className="flex h-full w-full gap-2.5">
      <div className="w-7 h-full shrink-0">
        <RainbowBar
          facts={facts}
          factState={factState}
          orientation="vertical"
          highlightFactIds={highlightFactIds}
        />
      </div>
      <div className="flex flex-col justify-between flex-1 min-w-0 py-0.5">
        <StatRow label="positive" color={understandingColor(0.7)} massPct={s.posMassPct} eqPct={s.posEqPct} />
        <StatRow label="unseen" color={understandingColor(0)} massPct={s.zeroMassPct} eqPct={s.zeroEqPct} />
        <StatRow label="negative" color={understandingColor(-0.7)} massPct={s.negMassPct} eqPct={s.negEqPct} />
      </div>
    </div>
  );
}

/**
 * Per-category rainbows — opt-in detail. Same spectrum, scoped to each
 * category's facts, so you can see one cluster going indigo while another
 * is still a wall of yellow.
 */
export function CategoryBars({ facts, factState }: { facts: FactMeta[]; factState: ChartFactState }) {
  const byCategory = new Map<string, FactMeta[]>();
  for (const f of facts) {
    const arr = byCategory.get(f.category) ?? [];
    arr.push(f);
    byCategory.set(f.category, arr);
  }
  const rows = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="space-y-1.5">
      {rows.map(([category, catFacts]) => (
        <div key={category} className="space-y-0.5">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-stone-600 dark:text-stone-300">{category}</span>
            <span className="font-mono text-stone-400">{catFacts.length}</span>
          </div>
          <RainbowBar facts={catFacts} factState={factState} />
        </div>
      ))}
    </div>
  );
}
