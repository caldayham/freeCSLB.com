/**
 * Answer coaching: for every WRONG option of every question in an exam,
 * generate a short empathetic re-positioning statement and write the aligned
 * array to questions.answer_coaching (JSONB). This is what shows up in the
 * Incorrect feedback box when the learner picks that option — it validates the
 * reasoning that made the option tempting, then gently corrects the
 * misconception and points to why the correct answer fits better.
 *
 * Usage:
 *   npm run db:coach-answers -- law-business
 *   npm run db:coach-answers -- law-business --force   (re-do rows already done)
 *
 * Runs ~CONCURRENCY questions in flight at once against Opus. Resumable: by
 * default only touches rows where answer_coaching IS NULL, so a crash/Ctrl-C
 * just means re-run. Idempotent.
 *
 * REQUIRES: SUPABASE_SECRET_KEY (bypasses RLS), ANTHROPIC_API_KEY.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local") });

const CONCURRENCY = 10;
const MODEL = "claude-opus-4-7";

// Map the CLI exam key to the exam_id stored in Postgres (mirrors ingest.ts).
const EXAM_IDS: Record<string, string> = {
  c27: "c27-audited",
  "law-business": "law-business",
};

// ---------- Shapes ----------

type QuestionRow = {
  id: string;
  external_id: string | null;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  reference: string | null;
};

type WrongCoaching = { index: number; statement: string };

// ---------- Clients ----------

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in v2/.env.local");
  }
  return createClient(url, secret, { auth: { persistSession: false } });
}

function getAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in v2/.env.local");
  return new Anthropic({ apiKey });
}

// ---------- The coaching call ----------

const SYSTEM_PROMPT = `You write empathetic answer coaching for the California contractor Law & Business licensing exam.

For each question you get the stem, every answer option, which option is correct, and the official explanation. For EVERY WRONG option, write a short re-positioning statement (2-4 sentences) that the learner sees the moment they pick that option:

1. Validate first — name the plausible reasoning that makes this specific wrong option tempting. The learner had a reason; surface it without judgment. This is the part that loosens the false understanding so a correct one can take its place.
2. Then gently correct — explain the precise misconception, and why the correct answer is the better fit. Be concrete and specific to THIS option, not generic.
3. Warm, direct, concise — like a good tutor sitting next to them. No "great try", no praise padding, no restating the whole official explanation.

Accuracy is non-negotiable — this is exam prep, and a confidently wrong correction plants a false memory. If you are unsure about a fine point, keep the statement to what you are certain of.

Write a statement for every wrong option — do not skip any. Do NOT write anything for the correct option.`;

const COACH_TOOL: Anthropic.Tool = {
  name: "save_answer_coaching",
  description: "Save the empathetic coaching statement for each wrong option of this question.",
  input_schema: {
    type: "object",
    properties: {
      wrong: {
        type: "array",
        description: "One entry per wrong option — every wrong option must be covered.",
        items: {
          type: "object",
          properties: {
            index: {
              type: "integer",
              description: "0-based index of the wrong option this statement is for",
            },
            statement: {
              type: "string",
              description: "2-4 sentence empathetic re-positioning statement for this wrong option",
            },
          },
          required: ["index", "statement"],
        },
      },
    },
    required: ["wrong"],
  },
};

/** Returns an array aligned with q.options — null at the correct index and at
 *  any wrong option the model failed to cover, a statement everywhere else. */
async function coachOne(anthropic: Anthropic, q: QuestionRow): Promise<(string | null)[]> {
  const optionLines = q.options
    .map(
      (o, i) =>
        `  [${i}] ${String.fromCharCode(65 + i)}. ${o}${i === q.correct_index ? "  <- CORRECT" : ""}`,
    )
    .join("\n");
  const userContent = `Question:\n${q.stem}\n\nOptions:\n${optionLines}\n\nOfficial explanation:\n${q.explanation ?? "(none)"}\n\nReference:\n${q.reference ?? "(none)"}`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [COACH_TOOL],
    tool_choice: { type: "tool", name: "save_answer_coaching" },
    messages: [{ role: "user", content: userContent }],
  });

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("model did not call save_answer_coaching");
  }
  const input = block.input as { wrong?: WrongCoaching[] };
  const wrong = Array.isArray(input.wrong) ? input.wrong : [];

  const aligned: (string | null)[] = q.options.map(() => null);
  for (const w of wrong) {
    if (
      typeof w?.index === "number" &&
      w.index >= 0 &&
      w.index < q.options.length &&
      w.index !== q.correct_index &&
      typeof w?.statement === "string" &&
      w.statement.trim()
    ) {
      aligned[w.index] = w.statement.trim();
    }
  }
  return aligned;
}

// ---------- Concurrency pool ----------

async function runPool<T>(items: T[], worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// ---------- Main ----------

async function fetchPending(
  supabase: SupabaseClient,
  examId: string,
  force: boolean,
): Promise<QuestionRow[]> {
  const all: QuestionRow[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    let query = supabase
      .from("questions")
      .select("id, external_id, stem, options, correct_index, explanation, reference")
      .eq("exam_id", examId)
      .range(from, from + PAGE - 1);
    if (!force) query = query.is("answer_coaching", null);
    const { data, error } = await query;
    if (error) throw new Error(`questions read: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as QuestionRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  const examKey = process.argv[2];
  const force = process.argv.includes("--force");
  const examId = examKey && EXAM_IDS[examKey];
  if (!examId) {
    console.error(
      `Usage: npm run db:coach-answers -- <exam> [--force]\n  Known exams: ${Object.keys(EXAM_IDS).join(", ")}`,
    );
    process.exit(2);
  }

  const supabase = getServiceClient();
  const anthropic = getAnthropic();

  console.log(`=== Answer coaching '${examId}'${force ? " (--force: redoing all)" : ""} ===\n`);
  const pending = await fetchPending(supabase, examId, force);
  if (pending.length === 0) {
    console.log("Nothing to do — every question already coached. (Use --force to redo.)");
    return;
  }
  console.log(`${pending.length} questions to coach, ${CONCURRENCY} in flight at a time.\n`);

  let done = 0;
  let failed = 0;
  let incomplete = 0;
  const startedAt = Date.now();

  await runPool(pending, async (q) => {
    const label = q.external_id ?? q.id;
    try {
      const aligned = await coachOne(anthropic, q);
      const { error } = await supabase
        .from("questions")
        .update({ answer_coaching: aligned })
        .eq("id", q.id);
      if (error) throw new Error(`update: ${error.message}`);
      done += 1;
      const covered = aligned.filter((s) => s !== null).length;
      const expected = q.options.length - 1; // every option but the correct one
      const flag = covered < expected ? " ⚠ incomplete" : "";
      if (covered < expected) incomplete += 1;
      console.log(`  [${done + failed}/${pending.length}] ${label} — ${covered}/${expected} wrong options coached${flag}`);
    } catch (e) {
      failed += 1;
      console.error(`  [${done + failed}/${pending.length}] ${label} — FAILED: ${(e as Error).message}`);
    }
  });

  const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n✅ Done in ${secs}s — ${done} coached, ${failed} failed.`);
  if (incomplete > 0) {
    console.log(`   ${incomplete} had an uncovered wrong option — re-run with --force to redo those rows if needed.`);
  }
  if (failed > 0) console.log(`   Re-run the same command to retry the ${failed} that failed.`);
}

main().catch((err) => {
  console.error("Answer coaching failed:", err);
  process.exit(1);
});
