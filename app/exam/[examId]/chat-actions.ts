"use server";

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, PLANNER_MODEL } from "@/lib/anthropic";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCoachInput = {
  examName: string;
  /** Prior turns in this thread — last ~10 are sent for continuity. */
  history: ChatMessage[];
  question: string;
};

const SYSTEM_PROMPT = (examName: string) =>
  `You are a study coach for the California contractor licensing exam "${examName}". The learner is downloading this exam into their brain and will ask you to explain concepts, terms, calculations, and rules in more depth than a one-line answer gives.

Be accurate first — this is exam prep, a confident wrong answer is harmful. Be concise: a few tight paragraphs, plain language, a concrete example or number when it helps it stick. No filler, no "great question". If something is genuinely outside the California Law & Business / trade exam scope, say so briefly rather than guessing.`;

/**
 * One turn of the floating coach chat. Independent of the exam flow — the
 * learner keeps answering questions while this runs. Non-streaming: returns the
 * full answer when Opus is done; the widget shows a "thinking…" state meanwhile.
 */
export async function askCoachAction(
  input: AskCoachInput,
): Promise<{ answer: string } | { error: string }> {
  try {
    const anthropic = getAnthropic();
    const history = input.history.slice(-10);
    const res = await anthropic.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT(input.examName),
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: input.question },
      ],
    });
    const answer = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!answer) return { error: "No answer came back — try rephrasing." };
    return { answer };
  } catch (e) {
    console.error("[askCoachAction] failed:", e);
    return { error: (e as Error).message };
  }
}
