/**
 * Question enrichment: for every question in an exam, generate the "good to
 * know" augmentation layer — acronym expansions + adjacent context notes —
 * and write it to questions.enrichment (JSONB). This is the content that shows
 * up in the Correct/Incorrect feedback box alongside the existing explanation.
 *
 * Usage:
 *   npm run db:enrich -- law-business
 *   npm run db:enrich -- law-business --force   (re-enrich rows that already have it)
 *
 * Runs ~CONCURRENCY questions in flight at once against Opus. Resumable: by
 * default only touches rows where enrichment IS NULL, so a crash/Ctrl-C just
 * means re-run. Idempotent.
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

type Enrichment = {
  acronyms: { term: string; expansion: string }[];
  notes: string[];
};

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

// ---------- The enrichment call ----------

const SYSTEM_PROMPT = `You enrich exam questions for the California contractor Law & Business licensing exam.

For each question you are given the stem, the answer options, the correct answer, and the official explanation. You produce TWO things:

1. acronyms — EVERY acronym or abbreviation that appears anywhere in the stem, options, or explanation, spelled out in full. Include even "obvious" ones (LLC, IRS, OSHA) — a learner downloading this material cold should never hit an unexplained acronym. If a term is industry jargon rather than a true acronym, skip it. If there are genuinely none, return an empty array.

2. notes — 1 to 4 short, high-value "good to know" facts that build the neuropathway AROUND this answer: the adjacent rule, the common trap, the number that's easy to confuse, the "why this exists" context, a memory hook. These must be ACCURATE for the California Law & Business exam and genuinely additive — do not restate the explanation. If you are not confident a note is correct, omit it. Quality over quantity: 1 excellent note beats 4 padded ones. An empty array is acceptable if the explanation already says everything worth knowing.

Be precise and factual. This is exam prep — a wrong note is worse than no note.`;

const ENRICH_TOOL: Anthropic.Tool = {
  name: "save_enrichment",
  description: "Save the acronym expansions and good-to-know notes for this question.",
  input_schema: {
    type: "object",
    properties: {
      acronyms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            term: { type: "string", description: "The acronym exactly as it appears, e.g. CSLB" },
            expansion: { type: "string", description: "The full spelled-out form" },
          },
          required: ["term", "expansion"],
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "1-4 short good-to-know facts, or empty if none add value",
      },
    },
    required: ["acronyms", "notes"],
  },
};

async function enrichOne(anthropic: Anthropic, q: QuestionRow): Promise<Enrichment> {
  const optionLines = q.options
    .map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o}${i === q.correct_index ? "  <- correct" : ""}`)
    .join("\n");
  const userContent = `Question:\n${q.stem}\n\nOptions:\n${optionLines}\n\nOfficial explanation:\n${q.explanation ?? "(none)"}\n\nReference:\n${q.reference ?? "(none)"}`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [ENRICH_TOOL],
    tool_choice: { type: "tool", name: "save_enrichment" },
    messages: [{ role: "user", content: userContent }],
  });

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("model did not call save_enrichment");
  }
  const input = block.input as Partial<Enrichment>;
  return {
    acronyms: Array.isArray(input.acronyms) ? input.acronyms : [],
    notes: Array.isArray(input.notes) ? input.notes : [],
  };
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
    if (!force) query = query.is("enrichment", null);
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
    console.error(`Usage: npm run db:enrich -- <exam> [--force]\n  Known exams: ${Object.keys(EXAM_IDS).join(", ")}`);
    process.exit(2);
  }

  const supabase = getServiceClient();
  const anthropic = getAnthropic();

  console.log(`=== Enrich '${examId}'${force ? " (--force: re-enriching all)" : ""} ===\n`);
  const pending = await fetchPending(supabase, examId, force);
  if (pending.length === 0) {
    console.log("Nothing to do — every question already enriched. (Use --force to redo.)");
    return;
  }
  console.log(`${pending.length} questions to enrich, ${CONCURRENCY} in flight at a time.\n`);

  let done = 0;
  let failed = 0;
  const startedAt = Date.now();

  await runPool(pending, async (q) => {
    const label = q.external_id ?? q.id;
    try {
      const enrichment = await enrichOne(anthropic, q);
      const { error } = await supabase
        .from("questions")
        .update({ enrichment })
        .eq("id", q.id);
      if (error) throw new Error(`update: ${error.message}`);
      done += 1;
      console.log(
        `  [${done + failed}/${pending.length}] ${label} — ${enrichment.acronyms.length} acronyms, ${enrichment.notes.length} notes`,
      );
    } catch (e) {
      failed += 1;
      console.error(`  [${done + failed}/${pending.length}] ${label} — FAILED: ${(e as Error).message}`);
    }
  });

  const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n✅ Done in ${secs}s — ${done} enriched, ${failed} failed.`);
  if (failed > 0) console.log(`   Re-run the same command to retry the ${failed} that failed.`);
}

main().catch((err) => {
  console.error("Enrich failed:", err);
  process.exit(1);
});
