"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { askCoachAction, type ChatMessage } from "./chat-actions";

/**
 * Floating coach chat — portaled into the layout's left rail, independent of
 * the exam flow. Ask "explain accrual accounting more" and keep answering
 * questions while Opus cooks; the answer lands in the scrollable thread when
 * it's ready. Being an in-flow rail (not a fixed overlay), it pushes the exam
 * content column to the right rather than covering the gutter.
 *
 * Thread persists per-exam in localStorage. One request in flight at a time
 * (keeps the thread ordered) — but it never blocks the exam, which is a
 * separate component entirely.
 */
export function CoachChat({ examId, examName }: { examId: string; examName: string }) {
  const storageKey = `coach_chat_${examId}`;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [railEl, setRailEl] = useState<HTMLElement | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setRailEl(document.getElementById("coach-chat-rail"));
  }, []);

  // Restore thread + collapsed state.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setMessages(JSON.parse(raw) as ChatMessage[]);
      setCollapsed(localStorage.getItem(`${storageKey}_collapsed`) === "true");
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, [storageKey]);

  // Persist thread.
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(storageKey, JSON.stringify(messages));
  }, [messages, hydrated, storageKey]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(`${storageKey}_collapsed`, String(next));
      return next;
    });
  }

  async function send() {
    const q = input.trim();
    if (!q || pending) return;
    setInput("");
    setError(null);
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: q }]);
    setPending(true);
    const res = await askCoachAction({ examName, history, question: q });
    setPending(false);
    if ("answer" in res) {
      setMessages((m) => [...m, { role: "assistant", content: res.answer }]);
    } else {
      setError(res.error);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!railEl) return null;

  if (collapsed) {
    return createPortal(
      <button
        onClick={toggleCollapsed}
        className="hidden xl:block sticky top-0 mr-6 rounded-md border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3 py-2 text-xs font-medium shadow-sm hover:bg-stone-100 dark:hover:bg-stone-900"
        title="Open coach chat"
      >
        Ask the coach →
      </button>,
      railEl,
    );
  }

  return createPortal(
    <aside className="hidden xl:flex sticky top-0 h-[calc(100vh-4rem)] mr-6 w-[19rem] flex-col rounded-lg border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 shadow-sm">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-stone-200 dark:border-stone-800">
        <span className="text-xs font-semibold">Ask the coach</span>
        <div className="flex items-center gap-2 text-xs text-stone-500">
          {messages.length > 0 ? (
            <button
              onClick={() => setMessages([])}
              className="underline hover:text-stone-900 dark:hover:text-stone-100"
              title="Clear thread"
            >
              clear
            </button>
          ) : null}
          <button
            onClick={toggleCollapsed}
            className="underline hover:text-stone-900 dark:hover:text-stone-100"
            title="Collapse"
          >
            hide
          </button>
        </div>
      </header>

      <div ref={threadRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !pending ? (
          <p className="text-xs text-stone-400 leading-relaxed">
            Stuck on a concept? Ask anything — e.g. &ldquo;explain accrual accounting
            more&rdquo;. Answers land here while you keep drilling.
          </p>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <div
              className={`inline-block max-w-[95%] rounded-md px-2.5 py-1.5 text-xs leading-relaxed whitespace-pre-wrap text-left ${
                m.role === "user"
                  ? "bg-stone-200 dark:bg-stone-800"
                  : "bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {pending ? (
          <div className="text-left">
            <div className="inline-block rounded-md px-2.5 py-1.5 text-xs text-stone-400 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
              thinking…
            </div>
          </div>
        ) : null}
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </div>

      <div className="border-t border-stone-200 dark:border-stone-800 p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Ask a question…"
          className="w-full resize-none rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-stone-400"
        />
        <button
          onClick={send}
          disabled={pending || !input.trim()}
          className="mt-1.5 w-full rounded-md border border-stone-300 dark:border-stone-700 px-3 py-1.5 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-900 disabled:opacity-40"
        >
          {pending ? "asking…" : "Ask  (↵)"}
        </button>
      </div>
    </aside>,
    railEl,
  );
}
