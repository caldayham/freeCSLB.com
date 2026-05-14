"use client";

import { useEffect, useRef, useState } from "react";
import type { CoachQuestion } from "@/lib/coach/next";

/**
 * Audio-only mode — a hands-free voice layer ON TOP of the existing coach
 * drill. It doesn't change the question flow; it drives it:
 *
 *   1. Reads the question + its options aloud (text-to-speech).
 *   2. Listens for a spoken answer — "A", "bee", "three", "first"... (speech
 *      recognition) — and calls the drill's existing `pick(i)`.
 *   3. On any answer, reads "Correct"/"Incorrect" + the coaching + explanation
 *      aloud, then calls the drill's existing `advance()` to move on.
 *   4. Loops.
 *
 * Say "repeat" / "again" to re-hear the question. Tapping answers still works —
 * this is purely additive. Built on the browser Web Speech API (no server, no
 * key); recognition needs Chrome or Safari and a microphone grant.
 */

export type AudioCoachApi = {
  current: CoachQuestion;
  answered: boolean;
  correct: boolean;
  selected: number | null;
  /** Whether the next question has been prefetched (advance() is a no-op until). */
  hasNext: boolean;
  pick: (i: number) => void;
  advance: () => void;
};

const LETTERS = ["A", "B", "C", "D"];
const letter = (i: number) => LETTERS[i] ?? String(i + 1);

/** Speak `text`; resolves when finished (or immediately if TTS is unavailable). */
function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth) return resolve();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

function getRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** Map a spoken phrase to an answer index, or null if nothing usable was said. */
function parseAnswer(transcript: string, numOptions: number): number | null {
  const t = transcript.toLowerCase();
  const map: Record<string, number> = {
    a: 0, b: 1, c: 2, d: 3,
    "1": 0, "2": 1, "3": 2, "4": 3,
    one: 0, two: 1, three: 2, four: 3,
    first: 0, second: 1, third: 2, fourth: 3,
    // common mis-hears of the bare letters
    ay: 0, eh: 0, hey: 0, bee: 1, be: 1, see: 2, sea: 2, c: 2, dee: 3, de: 3,
  };
  for (const token of t.split(/[^a-z0-9]+/)) {
    if (token in map && map[token] < numOptions) return map[token];
  }
  return null;
}

const isRepeat = (transcript: string) =>
  /\b(repeat|again|say that|one more|what was)\b/i.test(transcript);

export function useAudioCoach(api: AudioCoachApi) {
  const [audioOn, setAudioOn] = useState(false);
  const [status, setStatus] = useState("off");

  // Latest props/callbacks in a ref so recognition + TTS callbacks (which
  // outlive a render) always read fresh values.
  const apiRef = useRef(api);
  apiRef.current = api;
  const audioOnRef = useRef(false);
  audioOnRef.current = audioOn;

  const recRef = useRef<SpeechRecognition | null>(null);
  // True once feedback has been read and we're waiting on the prefetched next
  // question — advance() is a no-op until `hasNext` flips true.
  const pendingAdvanceRef = useRef(false);

  function stopListening() {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    }
  }

  function listen() {
    if (!audioOnRef.current || apiRef.current.answered) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setStatus("no voice input on this browser — tap an answer");
      return;
    }
    stopListening();
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 3;
    let heard = "";
    rec.onresult = (e: SpeechRecognitionEvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        for (let j = 0; j < e.results[i].length; j++) {
          heard += " " + e.results[i][j].transcript;
        }
      }
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setStatus("microphone blocked — allow it, then tap Audio mode again");
        setAudioOn(false);
        audioOnRef.current = false;
      }
    };
    rec.onend = () => {
      if (recRef.current !== rec) return; // superseded by a newer listen()
      recRef.current = null;
      if (!audioOnRef.current || apiRef.current.answered) return;
      const said = heard.trim();
      if (isRepeat(said)) {
        void readQuestionThenListen();
        return;
      }
      const idx = parseAnswer(said, apiRef.current.current.options.length);
      if (idx !== null) {
        setStatus(`heard "${said}" → ${letter(idx)}`);
        apiRef.current.pick(idx);
        return;
      }
      setStatus(said ? `heard "${said}" — say A, B, C, or D` : "didn't catch that — listening…");
      listen(); // nothing usable — go again
    };
    recRef.current = rec;
    setStatus("listening — say A, B, C, or D");
    try {
      rec.start();
    } catch {
      recRef.current = null;
    }
  }

  async function readQuestionThenListen() {
    if (!audioOnRef.current) return;
    const q = apiRef.current.current;
    const opts = q.options.map((o, i) => `${letter(i)}. ${o}`).join(". ");
    setStatus("reading question");
    await speak(`Question. ${q.stem}. Options. ${opts}.`);
    if (!audioOnRef.current || apiRef.current.answered) return;
    listen();
  }

  async function readFeedbackThenAdvance() {
    const a = apiRef.current;
    let msg = a.correct ? "Correct." : "Incorrect.";
    if (!a.correct && a.selected !== null && a.current.answer_coaching?.[a.selected]) {
      msg += " " + a.current.answer_coaching[a.selected];
    }
    if (a.current.explanation) msg += " " + a.current.explanation;
    setStatus(a.correct ? "correct" : "incorrect");
    await speak(msg);
    if (!audioOnRef.current) return;
    setStatus("next question…");
    pendingAdvanceRef.current = true;
    apiRef.current.advance(); // no-op if next isn't prefetched yet; the hasNext effect retries
  }

  // A new, unanswered question is on screen → read it, then listen.
  useEffect(() => {
    pendingAdvanceRef.current = false;
    if (!audioOn || api.answered) return;
    void readQuestionThenListen();
    return () => {
      window.speechSynthesis?.cancel();
      stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOn, api.current.id]);

  // The question got answered (by voice OR tap) → read feedback, then advance.
  useEffect(() => {
    if (!audioOn || !api.answered) return;
    stopListening();
    window.speechSynthesis?.cancel();
    void readFeedbackThenAdvance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOn, api.answered]);

  // advance() can't fire until the next question is prefetched — retry on hasNext.
  useEffect(() => {
    if (audioOn && api.answered && api.hasNext && pendingAdvanceRef.current) {
      pendingAdvanceRef.current = false;
      apiRef.current.advance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOn, api.answered, api.hasNext]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    setAudioOn((on) => {
      const next = !on;
      audioOnRef.current = next;
      if (next) {
        // Prime TTS + trigger the mic permission prompt inside the user gesture.
        void speak("Audio mode on.");
        setStatus("audio on");
      } else {
        window.speechSynthesis?.cancel();
        stopListening();
        pendingAdvanceRef.current = false;
        setStatus("off");
      }
      return next;
    });
  }

  return { audioOn, toggle, status };
}
