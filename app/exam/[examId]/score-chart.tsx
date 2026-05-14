"use client";

/**
 * Floating accuracy tracker — the card itself; CoachFlow fixes it to the
 * viewport bottom (aligned to the content column via a measured anchor) so
 * it's always visible. Every completed run of 4 answers becomes one bar at that
 * run's hit rate (3/4 → 75%, 4/4 → 100%); bars accumulate left→right so you
 * watch your rolling rate fill in. Two lines run through the bars:
 *   - the short line — average over the previous 4 runs (16 questions)
 *   - the long line  — average over the previous 8 runs (32 questions)
 * so you can read short-term swings against the slower long-term trend.
 * The trailing in-progress run shows as a faint bar that fills as you answer.
 *
 * Every run from the full attempt history is shown — bars flex to share the
 * width, so a long history just means thinner bars.
 */

const BATCH = 4; // answers per bar
const ROLL_SHORT = 4; // runs per short-average point  (16 questions)
const ROLL_LONG = 8; // runs per long-average point   (32 questions)
const LONG_COLOR = "#3b82f6"; // blue-500 — the long-trend line + its readout

function barColor(pct: number): string {
  // red (0%) → yellow (50%) → green (100%)
  return `hsl(${Math.round((pct / 100) * 140)} 70% 50%)`;
}

/** Trailing mean of `pcts` with a window of `win` entries. */
function rollingMean(pcts: number[], win: number): number[] {
  return pcts.map((_, i) => {
    const w = pcts.slice(Math.max(0, i - win + 1), i + 1);
    return w.reduce((s, v) => s + v, 0) / w.length;
  });
}

/** Polyline points in a 0-100 viewBox — x = bar-slot center, y inverted. */
function linePoints(rolling: number[], slots: number): string {
  return rolling.map((r, i) => `${((i + 0.5) / slots) * 100},${100 - r}`).join(" ");
}

const CARD_CLASS =
  "rounded-lg border border-stone-300 dark:border-stone-700 bg-stone-50/95 dark:bg-stone-950/95 backdrop-blur shadow-lg px-3 py-2.5";

export function ScoreChart({ results }: { results: boolean[] }) {
  // Empty state — still render the card so the widget is visibly present
  // (an empty card here means no attempts came back, not a layout bug).
  if (results.length === 0) {
    return (
      <div className={CARD_CLASS}>
        <p className="text-xs text-stone-400">
          Answer questions — your hit rate per run of 4 fills in here.
        </p>
      </div>
    );
  }

  // Chunk into runs of 4. The last chunk is "in progress" if it isn't full.
  const batches: boolean[][] = [];
  for (let i = 0; i < results.length; i += BATCH) batches.push(results.slice(i, i + BATCH));
  const tail = batches[batches.length - 1];
  const partial = tail.length < BATCH ? tail : null;
  const complete = partial ? batches.slice(0, -1) : batches;

  // Hit rate per completed run — denominator is always 4.
  const pcts = complete.map((b) => (b.filter(Boolean).length / BATCH) * 100);
  const rollingShort = rollingMean(pcts, ROLL_SHORT);
  const rollingLong = rollingMean(pcts, ROLL_LONG);

  const partialPct = partial ? (partial.filter(Boolean).length / BATCH) * 100 : null;
  const latestShort = rollingShort.length > 0 ? rollingShort[rollingShort.length - 1] : null;
  const latestLong = rollingLong.length > 0 ? rollingLong[rollingLong.length - 1] : null;

  const slots = pcts.length + (partial ? 1 : 0);
  const shortPoints = linePoints(rollingShort, slots);
  const longPoints = linePoints(rollingLong, slots);

  return (
    <div className={CARD_CLASS}>
      <div className="flex items-stretch gap-3">
        <div className="flex flex-col justify-center shrink-0 w-16 gap-1.5">
          <div className="leading-none">
            <div className="text-[9px] text-stone-400">16q avg</div>
            <div className="font-mono tabular-nums text-base text-stone-900 dark:text-stone-100">
              {latestShort != null ? `${latestShort.toFixed(0)}%` : "–"}
            </div>
          </div>
          <div className="leading-none">
            <div className="text-[9px] text-stone-400">32q avg</div>
            <div className="font-mono tabular-nums text-base" style={{ color: LONG_COLOR }}>
              {latestLong != null ? `${latestLong.toFixed(0)}%` : "–"}
            </div>
          </div>
        </div>
        <div className="relative flex-1 h-16">
          <div className="absolute inset-0 flex items-end gap-px">
            {pcts.map((p, i) => (
              <div
                key={i}
                className="flex-1 min-w-0 rounded-t-sm transition-all duration-300"
                style={{ height: `${Math.max(p, 2)}%`, backgroundColor: barColor(p) }}
                title={`run ${i + 1}: ${p.toFixed(0)}%`}
              />
            ))}
            {partialPct != null ? (
              <div
                className="flex-1 min-w-0 rounded-t-sm opacity-40 transition-all duration-300"
                style={{ height: `${Math.max(partialPct, 2)}%`, backgroundColor: barColor(partialPct) }}
                title={`in progress: ${partialPct.toFixed(0)}%`}
              />
            ) : null}
          </div>
          {pcts.length > 1 ? (
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none text-stone-900 dark:text-stone-100"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              {/* Long trend (64q) underneath, then the short line (16q) on top. */}
              <polyline
                points={longPoints}
                fill="none"
                stroke={LONG_COLOR}
                strokeWidth="1.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              <polyline
                points={shortPoints}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : null}
        </div>
      </div>
    </div>
  );
}
