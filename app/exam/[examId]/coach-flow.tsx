"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CoachQuestion, RankDebugEntry } from "@/lib/coach/next";
import { ALGOS, DEFAULT_ALGO_ID } from "@/lib/coach/algos";
import { logAttemptAction, pickNextAction } from "./actions";
import { OverallBar, CategoryBars, type FactMeta, type ChartFactState } from "./category-chart";
import { ScoreChart } from "./score-chart";

const EXCLUDE_WINDOW = 15; // recently-served ids kept out of the next pick

// ---- Debug event log ----

type FactDelta = { factId: string; category: string; mass: number; before: number; after: number };
type DebugEvent = {
  ts: number;
  questionExternalId: string | null;
  questionStem: string;
  pickedBy: string; // which algo surfaced this question
  selectedLabel: string;
  correct: boolean;
  factDeltas: FactDelta[];
  // The ranking that PICKED this question — "why was I asked this".
  topRanked: RankDebugEntry[] | null;
  // The prefetched next question (in hand at answer time).
  nextUp: { externalId: string | null; stem: string; why: string | null } | null;
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

// Minimal structural types for the Web Speech API recognition object — not in
// lib.dom across all TS configs, so we model just what listen() touches.
type SpeechRecognitionEventLike = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: (e: SpeechRecognitionEventLike) => void;
  onerror: () => void;
  onend: () => void;
  start: () => void;
  abort: () => void;
};

/** Map a spoken phrase ("a", "answer B", "the third one") to an option index. */
function parseSpokenAnswer(raw: string, numOptions: number): number | null {
  const s = raw.toLowerCase();
  const letter = s.match(/\b([a-d])\b/);
  if (letter) {
    const idx = letter[1].charCodeAt(0) - 97;
    if (idx < numOptions) return idx;
  }
  const words: Record<string, number> = {
    one: 0, two: 1, three: 2, four: 3,
    first: 0, second: 1, third: 2, fourth: 3,
    "1": 0, "2": 1, "3": 2, "4": 3,
  };
  for (const [w, idx] of Object.entries(words)) {
    if (idx < numOptions && new RegExp(`\\b${w}\\b`).test(s)) return idx;
  }
  return null;
}

/** Speak text via the Web Speech API; resolves when done (or immediately if unsupported). */
function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return resolve();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.85;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.speak(u);
    } catch {
      resolve();
    }
  });
}

function formatEvent(e: DebugEvent): string {
  const lines: string[] = [];
  lines.push(`[${fmtTime(e.ts)}] Q ${e.questionExternalId ?? "?"} [${e.pickedBy}]  "${e.questionStem}"`);
  lines.push(`  answered ${e.selectedLabel} → ${e.correct ? "✓ correct" : "✗ incorrect"}`);
  let totalWtd = 0;
  for (const d of e.factDeltas) {
    const delta = d.after - d.before;
    const wtd = delta * d.mass;
    totalWtd += wtd;
    lines.push(
      `    ${d.factId} [${d.category}] mass ${d.mass.toFixed(1)}: ` +
        `${d.before.toFixed(3)} → ${d.after.toFixed(3)} ` +
        `(Δ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}, mass-wtd ${wtd >= 0 ? "+" : ""}${wtd.toFixed(2)})`,
    );
  }
  lines.push(`  total mass-weighted Δ: ${totalWtd >= 0 ? "+" : ""}${totalWtd.toFixed(2)}`);
  if (e.topRanked && e.topRanked.length > 0) {
    lines.push(`  picked from this ranking:`);
    for (const r of e.topRanked) {
      lines.push(
        `    ${r.factId} [${r.category}]  score ${r.score.toFixed(2)}  ` +
          `mass ${r.mass.toFixed(1)}  u ${r.understanding.toFixed(3)}  r ${r.retrieval.toFixed(2)}  n ${r.attempts}`,
      );
    }
  }
  if (e.nextUp) {
    lines.push(`  next up: ${e.nextUp.externalId ?? "?"}  "${e.nextUp.stem}"`);
    if (e.nextUp.why) lines.push(`    why: ${e.nextUp.why}`);
  }
  return lines.join("\n");
}

/**
 * The continuous coach — no queue, no batch. One question on screen, one
 * pre-fetched next. Answering fires `logAttemptAction`, which logs the attempt,
 * updates fact_state, and picks the next question against that *fresh* state —
 * all in one round-trip, in the background, while you read the explanation.
 *
 * The coverage rainbow is portaled into the top-level rail. The event log
 * records every answer with per-fact deltas + the rank algorithm's top
 * candidates — copy it out to discuss tuning.
 *
 * Keyboard: 1-4 / A-D to answer, ↵ / space to advance.
 */
export function CoachFlow({
  examId,
  firstQuestion,
  facts,
  initialFactState,
  initialResults,
}: {
  examId: string;
  firstQuestion: CoachQuestion;
  facts: FactMeta[];
  initialFactState: ChartFactState;
  /** Correctness of every attempt ever, oldest-first — seeds the ScoreChart. */
  initialResults: boolean[];
}) {
  const [current, setCurrent] = useState<CoachQuestion>(firstQuestion);
  const [next, setNext] = useState<CoachQuestion | null>(null);
  const [factState, setFactState] = useState<ChartFactState>(initialFactState);
  const [selected, setSelected] = useState<number | null>(null);
  const [answered, setAnswered] = useState(false);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  // Correctness of every answer in order — seeded from the full attempt
  // history, appended live, chunked into runs of 4 by ScoreChart.
  const [results, setResults] = useState<boolean[]>(initialResults);
  const [error, setError] = useState<string | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [eventLog, setEventLog] = useState<DebugEvent[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [copied, setCopied] = useState(false);
  const [algoId, setAlgoId] = useState(DEFAULT_ALGO_ID);
  // Audio mode: hands-free voice loop — reads the question, listens for a
  // spoken answer, reads the verdict + coaching, auto-advances. Repeat.
  const [audioMode, setAudioMode] = useState(false);
  const [audioStatus, setAudioStatus] = useState("");

  // The top-level coverage rail (rendered by the root layout). We portal the
  // coverage bar into it so the page nav + header align to its left edge.
  const [railEl, setRailEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setRailEl(document.getElementById("coverage-rail"));
  }, []);

  const servedIdsRef = useRef<string[]>([firstQuestion.id]);
  const startedAtRef = useRef(Date.now());
  const factStateRef = useRef<ChartFactState>(initialFactState);
  // Read inside the background log callback — always fresh even if the
  // keyboard handler's closure is stale.
  const algoIdRef = useRef(DEFAULT_ALGO_ID);
  // Refs the audio loop reads from inside its async closures (where state
  // would be stale): live `answered`, the prefetched `next`, the active
  // SpeechRecognition instance.
  const answeredRef = useRef(false);
  const nextRef = useRef<CoachQuestion | null>(null);
  const recognitionRef = useRef<{ abort: () => void } | null>(null);
  useEffect(() => {
    answeredRef.current = answered;
  }, [answered]);
  useEffect(() => {
    nextRef.current = next;
  }, [next]);

  const factById = useMemo(() => {
    const m = new Map<string, FactMeta>();
    for (const f of facts) m.set(f.id, f);
    return m;
  }, [facts]);

  // Keep a ref of factState so the background log callback can read the
  // *before* values to compute per-fact deltas.
  useEffect(() => {
    factStateRef.current = factState;
  }, [factState]);

  // Restore UI preferences.
  useEffect(() => {
    const cats = localStorage.getItem("coach_show_categories");
    if (cats !== null) setShowCategories(cats === "true");
    const log = localStorage.getItem("coach_show_log");
    if (log !== null) setShowLog(log === "true");
    const algo = localStorage.getItem("coach_algo");
    if (algo !== null && algo in ALGOS) {
      setAlgoId(algo);
      algoIdRef.current = algo;
    }
  }, []);

  function changeAlgo(id: string) {
    setAlgoId(id);
    algoIdRef.current = id;
    localStorage.setItem("coach_algo", id);
  }
  function toggleCategories() {
    setShowCategories((v) => {
      const n = !v;
      localStorage.setItem("coach_show_categories", String(n));
      return n;
    });
  }
  function toggleLog() {
    setShowLog((v) => {
      const n = !v;
      localStorage.setItem("coach_show_log", String(n));
      return n;
    });
  }

  async function copyLog() {
    const text = eventLog.map(formatEvent).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("clipboard copy failed");
    }
  }

  // Prefetch the next question against *current* state — fired the moment a
  // question is shown (mount, and each advance), NOT when it's answered. This
  // is the "lag one behind": the pick doesn't see the on-screen question's
  // answer, but it's ready well before the user clicks Next.
  function fetchNext(currentId: string) {
    pickNextAction({
      examId,
      excludeQuestionIds: [...servedIdsRef.current.slice(-EXCLUDE_WINDOW), currentId],
      algoId: algoIdRef.current,
    })
      .then((res) => setNext(res.nextQuestion))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  // Kick off the first prefetch once preferences are restored (so it uses the
  // restored algo). Runs after the prefs-restore effect by definition order.
  useEffect(() => {
    fetchNext(firstQuestion.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(i: number) {
    if (answered || selected !== null) return;
    setSelected(i);
    setAnswered(true); // instant — correctness is a client-side prop

    const correct = i === current.correct_index;
    setAnsweredCount((n) => n + 1);
    if (correct) setCorrectCount((n) => n + 1);
    setResults((r) => [...r, correct]);
    servedIdsRef.current = [...servedIdsRef.current, current.id];

    const q = current;
    const nextSnapshot = next; // the prefetched next, in hand at answer time
    const selectedLabel = String.fromCharCode(65 + i);

    logAttemptAction({
      questionId: q.id,
      examId,
      selectedIndex: i,
      correctIndex: q.correct_index,
      context: "drill",
      responseTimeMs: Date.now() - startedAtRef.current,
      pickedBy: q.pickedBy,
    })
      .then((res) => {
        const before = factStateRef.current;
        const factDeltas: FactDelta[] = res.updatedFacts.map((uf) => {
          const fm = factById.get(uf.fact_id);
          return {
            factId: uf.fact_id,
            category: fm?.category ?? "?",
            mass: fm?.mass ?? 0,
            before: before[uf.fact_id]?.understanding ?? 0,
            after: uf.understanding,
          };
        });
        setEventLog((log) => [
          ...log,
          {
            ts: Date.now(),
            questionExternalId: q.external_id,
            questionStem: q.stem,
            pickedBy: q.pickedBy,
            selectedLabel,
            correct: res.correct,
            factDeltas,
            topRanked: q.topRanked, // the ranking that picked THIS question
            nextUp: nextSnapshot
              ? {
                  externalId: nextSnapshot.external_id,
                  stem: nextSnapshot.stem,
                  why: nextSnapshot.why,
                }
              : null,
          },
        ]);
        setFactState((prev) => {
          const n = { ...prev };
          for (const f of res.updatedFacts) {
            n[f.fact_id] = { understanding: f.understanding, attempts: f.attempts };
          }
          return n;
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  function advance() {
    // Read from the ref so the audio loop's stale closure still advances correctly.
    const nc = nextRef.current ?? next;
    if (!answered || !nc) return;
    setCurrent(nc);
    setNext(null);
    setSelected(null);
    setAnswered(false);
    setError(null);
    startedAtRef.current = Date.now();
    fetchNext(nc.id); // prefetch against current state, while nc is on screen
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!answered) {
        const map: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3, a: 0, b: 1, c: 2, d: 3 };
        const idx = map[e.key.toLowerCase()];
        if (idx !== undefined && idx < current.options.length) {
          e.preventDefault();
          pick(idx);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        advance();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, current, next]);

  // ---- Audio mode: hands-free drill via the Web Speech API ----
  // listen() captures one spoken phrase. Resolves (never rejects) so the drill
  // loop can't wedge. Defined in-component because it registers the live
  // recognition object on recognitionRef for cancellation. speak() is the
  // module-level helper. iOS needs the first speak() to fire from a user
  // gesture — the toggle button handles that.
  function listen(): Promise<string> {
    return new Promise((resolve) => {
      const w = window as unknown as {
        webkitSpeechRecognition?: new () => SpeechRecognitionLike;
        SpeechRecognition?: new () => SpeechRecognitionLike;
      };
      const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
      if (!SR) return resolve("");
      const rec = new SR();
      rec.lang = "en-US";
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      recognitionRef.current = rec;
      let heard = "";
      rec.onresult = (e: SpeechRecognitionEventLike) => {
        for (let i = 0; i < e.results.length; i++) {
          for (let j = 0; j < e.results[i].length; j++) {
            heard += e.results[i][j].transcript + " ";
          }
        }
      };
      rec.onerror = () => {
        recognitionRef.current = null;
        resolve(heard.trim());
      };
      rec.onend = () => {
        recognitionRef.current = null;
        resolve(heard.trim());
      };
      try {
        rec.start();
      } catch {
        resolve("");
      }
    });
  }

  // Question cycle: read the stem + options aloud, then listen for an answer.
  // Re-runs each time a new question lands (current.id) or audio is toggled on.
  useEffect(() => {
    if (!audioMode) return;
    let cancelled = false;
    (async () => {
      if (answeredRef.current) return; // already answered (e.g. manual click)
      const labels = ["A", "B", "C", "D"];
      const q =
        `Question. ${current.stem} ` +
        current.options.map((o, i) => `${labels[i]}. ${o}.`).join(" ");
      setAudioStatus("reading question…");
      await speak(q);
      while (!cancelled && !answeredRef.current) {
        setAudioStatus("listening — say A, B, C, or D");
        const phrase = await listen();
        if (cancelled || answeredRef.current) return;
        const idx = parseSpokenAnswer(phrase, current.options.length);
        if (idx !== null) {
          setAudioStatus(`heard ${labels[idx]}`);
          pick(idx);
          return;
        }
        await speak("Sorry, I didn't catch that. Say A, B, C, or D.");
      }
    })();
    return () => {
      cancelled = true;
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* noop */
      }
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioMode, current.id]);

  // Feedback cycle: once answered, read the verdict + coaching aloud, then
  // auto-advance as soon as the next question is prefetched.
  useEffect(() => {
    if (!audioMode || !answered) return;
    let cancelled = false;
    (async () => {
      const isCorrect = selected === current.correct_index;
      let verdict = isCorrect ? "Correct." : "Incorrect.";
      if (!isCorrect) {
        const coaching = selected !== null ? current.answer_coaching?.[selected] : null;
        const right = current.options[current.correct_index];
        verdict += ` The answer is ${String.fromCharCode(65 + current.correct_index)}. ${right}.`;
        if (coaching) verdict += ` ${coaching}`;
        if (current.explanation) verdict += ` ${current.explanation}`;
      }
      setAudioStatus(isCorrect ? "correct" : "incorrect — here's why");
      await speak(verdict);
      if (cancelled) return;
      setAudioStatus("next question…");
      for (let i = 0; i < 30 && !cancelled; i++) {
        if (nextRef.current) {
          advance();
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioMode, answered, current.id]);

  // Toggling audio off: stop everything immediately.
  useEffect(() => {
    if (audioMode) return;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* noop */
    }
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setAudioStatus("");
  }, [audioMode]);

  function toggleAudio() {
    setAudioMode((on) => {
      const next = !on;
      // Prime the speech engine inside this user gesture so iOS allows it.
      if (next) {
        try {
          window.speechSynthesis?.cancel();
        } catch {
          /* noop */
        }
      }
      return next;
    });
  }

  const correct = answered && selected === current.correct_index;

  return (
    <div className="space-y-6">
      {/* The drill. A min-h-screen flex column so the accuracy tracker at the
          bottom can be pushed to the viewport bottom (mt-auto) and pinned there
          (sticky). The coverage bar is portaled out to the top-level rail. */}
      <div className="min-w-0 flex flex-col gap-6 min-h-screen">
        {/* Score + algo selector */}
        <div className="flex items-center justify-between text-xs text-stone-500">
          <span>
            {answeredCount > 0 ? (
              <>
                {correctCount}/{answeredCount} correct
              </>
            ) : (
              "Answer to begin — 1-4 / A-D"
            )}
          </span>
          <label className="flex items-center gap-1.5" title={ALGOS[algoId]?.description}>
            <span className="text-stone-400">algo</span>
            <select
              value={algoId}
              onChange={(e) => changeAlgo(e.target.value)}
              className="bg-transparent border border-stone-300 dark:border-stone-700 rounded px-1.5 py-0.5 text-xs"
            >
              {Object.values(ALGOS).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Audio mode — hands-free, eyes-free drill. Reads the question + options
            aloud, listens for a spoken A/B/C/D, reads the verdict, auto-advances. */}
        <button
          onClick={toggleAudio}
          className={[
            "w-full rounded-lg border px-4 py-3 text-sm font-medium transition",
            audioMode
              ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
              : "border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-900",
          ].join(" ")}
        >
          {audioMode ? "■ Stop audio mode" : "▶ Audio mode — hands-free"}
          {audioMode && audioStatus ? (
            <span className="block text-xs font-normal opacity-70 mt-0.5">{audioStatus}</span>
          ) : null}
        </button>

        {/* Question */}
        <div className="space-y-5">
          {current.why ? (
            <div className="text-xs text-stone-500 italic border-l-2 border-stone-300 dark:border-stone-700 pl-3">
              {current.why}
            </div>
          ) : null}

          <div className="space-y-1">
            <div className="text-xs text-stone-500 font-mono">
              {current.external_id ?? current.id.slice(0, 8)}
            </div>
            <p className="text-base leading-relaxed">{current.stem}</p>
          </div>

          <ol className="space-y-2">
            {current.options.map((opt, i) => {
              const isCorrectAnswer = answered && i === current.correct_index;
              const isWrongPick = answered && i === selected && i !== current.correct_index;
              return (
                <li key={i}>
                  <button
                    disabled={answered}
                    onClick={() => pick(i)}
                    className={[
                      "w-full text-left rounded-md border px-3 py-2 text-sm transition",
                      isCorrectAnswer
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
                        : isWrongPick
                        ? "border-red-500 bg-red-50 dark:bg-red-950"
                        : "border-stone-200 dark:border-stone-800 hover:border-stone-400",
                    ].join(" ")}
                  >
                    <span className="font-mono text-xs text-stone-400 mr-2">
                      {String.fromCharCode(65 + i)}.
                    </span>
                    {opt}
                  </button>
                </li>
              );
            })}
          </ol>

          {answered ? (
            <div className="space-y-3">
              <div
                className={`rounded-md p-3 text-sm ${
                  correct
                    ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-900"
                    : "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200 border border-red-200 dark:border-red-900"
                }`}
              >
                <div className="font-medium mb-1">{correct ? "Correct" : "Incorrect"}</div>
                {!correct && selected !== null && current.answer_coaching?.[selected] ? (
                  <p className="text-xs leading-relaxed mb-2 border-l-2 border-current/30 pl-2.5">
                    {current.answer_coaching[selected]}
                  </p>
                ) : null}
                {current.explanation ? (
                  <p className="text-xs leading-relaxed">{current.explanation}</p>
                ) : null}
                {current.enrichment &&
                (current.enrichment.acronyms.length > 0 ||
                  current.enrichment.notes.length > 0) ? (
                  <div className="mt-3 pt-3 border-t border-current/15 space-y-2">
                    {current.enrichment.acronyms.length > 0 ? (
                      <dl className="text-xs leading-relaxed space-y-0.5">
                        {current.enrichment.acronyms.map((a) => (
                          <div key={a.term} className="flex gap-1.5">
                            <dt className="font-mono font-medium shrink-0">{a.term}</dt>
                            <dd className="opacity-80">— {a.expansion}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {current.enrichment.notes.length > 0 ? (
                      <ul className="text-xs leading-relaxed list-disc pl-4 space-y-1">
                        {current.enrichment.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {current.reference ? (
                  <p className="text-xs mt-2 text-stone-500 dark:text-stone-400 font-mono">
                    {current.reference}
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-stone-400">Click an answer — or press 1-4 / A-D.</p>
          )}

          {error ? <p className="text-xs text-red-600">log issue: {error}</p> : null}
        </div>

        {/* Opt-in per-category breakdown */}
        <div className="border-t border-stone-200 dark:border-stone-800 pt-4 space-y-3">
          <button
            onClick={toggleCategories}
            className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
          >
            {showCategories ? "▾" : "▸"} Category breakdown
          </button>
          {showCategories ? <CategoryBars facts={facts} factState={factState} /> : null}
        </div>

        {/* Debug event log */}
        <div className="border-t border-stone-200 dark:border-stone-800 pt-4 space-y-2">
          <div className="flex items-center justify-between">
            <button
              onClick={toggleLog}
              className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
            >
              {showLog ? "▾" : "▸"} Event log ({eventLog.length})
            </button>
            {eventLog.length > 0 ? (
              <button
                onClick={copyLog}
                className="text-xs text-stone-500 underline hover:text-stone-900 dark:hover:text-stone-100"
              >
                {copied ? "copied" : "copy"}
              </button>
            ) : null}
          </div>
          {showLog ? (
            <div className="font-mono text-[10px] leading-relaxed text-stone-500 whitespace-pre-wrap max-h-96 overflow-y-auto rounded border border-stone-200 dark:border-stone-800 p-2 bg-stone-100/50 dark:bg-stone-900/50">
              {eventLog.length === 0
                ? "no events yet — answer a question"
                : eventLog.map((e, i) => (
                    <div key={i} className={i > 0 ? "mt-3" : ""}>
                      {formatEvent(e)}
                    </div>
                  ))}
            </div>
          ) : null}
        </div>

        {/* Accuracy tracker — last child of the flex column. mt-auto drops it
            to the bottom when the drill is short; sticky bottom-4 keeps it
            pinned to the viewport bottom as the drill scrolls behind it. Once
            answered, the full-width Next button rests above the chart (20px
            gap), the whole stack growing upward off the pinned bottom edge. */}
        <div className="mt-auto sticky bottom-4 z-30">
          {answered ? (
            <button
              onClick={advance}
              autoFocus
              disabled={!next}
              className="w-full mb-2.5 rounded-lg border border-stone-300 dark:border-stone-700 bg-stone-50/95 dark:bg-stone-950/95 backdrop-blur shadow-md px-4 py-3 text-sm font-medium hover:bg-stone-100 dark:hover:bg-stone-900 disabled:opacity-50"
            >
              {next ? (
                <>
                  Next → <span className="text-xs text-stone-400 ml-2">(↵ / space)</span>
                </>
              ) : (
                "loading next…"
              )}
            </button>
          ) : null}
          <ScoreChart results={results} />
        </div>
      </div>

      {/* Coverage rainbow — portaled into the top-level rail so it lives beside
          the nav + page header, not inside the drill column. Sticks at full
          viewport height as the drill scrolls. */}
      {railEl
        ? createPortal(
            <div className="sticky top-0 h-[calc(100vh-4rem)] ml-6 flex w-32">
              <OverallBar facts={facts} factState={factState} highlightFactIds={current.factIds} />
            </div>,
            railEl,
          )
        : null}
    </div>
  );
}
