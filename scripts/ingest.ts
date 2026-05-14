/**
 * Generic ingestion: read v1's audited question banks + canonical facts files and
 * load them into Postgres (Supabase). Handles single-bank exams (c27) and
 * multi-bank exams (law-business: flashcards + ai-expanded with overlap signal).
 *
 * Usage:
 *   npm run db:ingest -- c27
 *   npm run db:ingest -- law-business
 *
 * Reads from ../version-1/data/. Idempotent — re-running upserts.
 *
 * REQUIRES: SUPABASE_SECRET_KEY (bypasses RLS for bulk insert).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env.local") });

// ---------- Shapes ----------

type V1Question = {
  id: string;
  exam: string;
  section: number;
  sectionName: string;
  topic: string;
  question: string;
  options: [string, string, string, string];
  correctIndex: number;
  explanation: string;
  reference: string;
  difficulty: "easy" | "medium" | "hard";
  isMath: boolean;
  source?: string; // "flashcards" | "ai-expanded" | undefined (c27 = curated)
};

type V1Enrichment = {
  id: string; // matches V1Question.id
  extendedExplanation?: string;
  metaphor?: string;
  wrongAnswers?: (string | null)[]; // aligned with options; null at correct_index
};

type V1Fact = {
  id: string;
  statement: string;
  category: string;
  questionCount: number;
  questionIds: string[];
  primaryForCount: number;
  originalPhrasings: string[];
  sources?: string[]; // ['flashcards', 'ai-expanded'] for multi-bank
  consensus?: boolean; // true when fact appears in 2+ banks
};

type V1FactsFile = {
  exam: string;
  totalCanonicalFacts: number;
  facts: V1Fact[];
  questionFactMap: Record<string, { factId: string; primary: boolean }[]>;
};

// ---------- Exam configs ----------

type BankSpec = {
  // Path under version-1/data
  questionsFile: string;
  // Tag for the question.bank column (NULL for single-bank exams)
  bank: string | null;
  // Tag for the question.source column
  source: "curated" | "generated_variant" | "generated_synth" | "generated_composite";
};

type ExamConfig = {
  id: string;
  name: string;
  description: string;
  factsFile: string; // canonical facts file under version-1/data
  banks: BankSpec[]; // 1+ banks
};

const EXAMS: Record<string, ExamConfig> = {
  c27: {
    id: "c27-audited",
    name: "C-27 Landscaping (Audited)",
    description: "Audited and corrected C-27 question bank, 296 questions × 334 facts",
    factsFile: "facts-c27-audited.json",
    banks: [
      { questionsFile: "questions-c27-audited.json", bank: null, source: "curated" },
    ],
  },
  "law-business": {
    id: "law-business",
    name: "Law & Business",
    description:
      "California contractor Law & Business exam — flashcards (community) + AI-expanded banks, both audited; canonical facts deduplicated across banks with consensus signal",
    factsFile: "facts-law-business-audited.json",
    banks: [
      {
        questionsFile: "questions-law-business-flashcards-audited.json",
        bank: "flashcards",
        source: "curated",
      },
      {
        questionsFile: "questions-law-business-ai-audited.json",
        bank: "ai-expanded",
        source: "generated_synth",
      },
    ],
  },
};

// ---------- Client ----------

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in v2/.env.local",
    );
  }
  return createClient(url, secret, { auth: { persistSession: false } });
}

// ---------- Helpers ----------

async function upsertInBatches<T>(
  supabase: SupabaseClient,
  table: string,
  rows: T[],
  batchSize: number,
  onConflict: string,
  label: string,
) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + batchSize) as object[], { onConflict });
    if (error) throw new Error(`${label} upsert at ${i}: ${error.message}`);
  }
}

async function readExternalIdToUuid(
  supabase: SupabaseClient,
  examId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("questions")
      .select("id, external_id")
      .eq("exam_id", examId)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`question UUID read: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) if (row.external_id) map.set(row.external_id, row.id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// ---------- Main ----------

async function ingest(examKey: string) {
  const cfg = EXAMS[examKey];
  if (!cfg) throw new Error(`Unknown exam '${examKey}'. Known: ${Object.keys(EXAMS).join(", ")}`);

  console.log(`=== Ingest '${cfg.id}' into Postgres ===\n`);
  const v1Dir = resolve(__dirname, "..", "..", "version-1", "data");

  // Load all banks
  const allQuestions: (V1Question & { _bank: string | null; _source: BankSpec["source"] })[] = [];
  for (const bankSpec of cfg.banks) {
    const path = resolve(v1Dir, bankSpec.questionsFile);
    if (!existsSync(path)) throw new Error(`Missing questions file: ${path}`);
    const rows = JSON.parse(readFileSync(path, "utf-8")) as V1Question[];
    console.log(`  Loaded ${rows.length} questions from ${bankSpec.questionsFile} (bank=${bankSpec.bank ?? "—"}, source=${bankSpec.source})`);
    for (const q of rows) allQuestions.push({ ...q, _bank: bankSpec.bank, _source: bankSpec.source });
  }

  // Load canonical facts
  const factsPath = resolve(v1Dir, cfg.factsFile);
  if (!existsSync(factsPath)) {
    throw new Error(
      `Missing facts file: ${factsPath}\n  (For 'law-business' this is produced by the synthesizer agent — wait for it to complete.)`,
    );
  }
  const factsFile = JSON.parse(readFileSync(factsPath, "utf-8")) as V1FactsFile;
  console.log(`  Loaded ${factsFile.facts.length} canonical facts from ${cfg.factsFile}\n`);

  // Load enrichments (the empathetic "why" layer) — shared file across all exams,
  // keyed by question id. Optional: ingest still works if the file is absent.
  const enrichmentById = new Map<string, V1Enrichment>();
  const enrichPath = resolve(v1Dir, "enrichments.json");
  if (existsSync(enrichPath)) {
    const enrichments = JSON.parse(readFileSync(enrichPath, "utf-8")) as V1Enrichment[];
    for (const e of enrichments) enrichmentById.set(e.id, e);
    const matched = allQuestions.filter((q) => enrichmentById.has(q.id)).length;
    console.log(`  Loaded ${enrichments.length} enrichments — ${matched}/${allQuestions.length} questions matched\n`);
  } else {
    console.log(`  No enrichments.json found — questions will have no enrichment layer\n`);
  }

  const supabase = getServiceClient();

  // 1. Upsert exam
  console.log("[exams] upserting…");
  {
    const { error } = await supabase
      .from("exams")
      .upsert({ id: cfg.id, name: cfg.name, description: cfg.description });
    if (error) throw new Error(`exam upsert: ${error.message}`);
  }

  // 2. Upsert facts (with sources[] + consensus tagging)
  const maxQC = Math.max(...factsFile.facts.map((f) => f.questionCount), 1);
  console.log(`[facts] upserting ${factsFile.facts.length} rows…`);
  {
    const rows = factsFile.facts.map((f) => ({
      id: f.id,
      exam_id: cfg.id,
      statement: f.statement,
      category: f.category,
      importance_intrinsic: f.questionCount / maxQC,
      frequency_estimate: f.questionCount / maxQC,
      difficulty: "medium" as const,
      verified: true,
      sources: f.sources ?? [],
      consensus: f.consensus ?? false,
    }));
    await upsertInBatches(supabase, "facts", rows, 200, "id", "facts");
    const consensusCount = factsFile.facts.filter((f) => f.consensus).length;
    console.log(`  done — max questionCount=${maxQC}, consensus facts=${consensusCount}`);
  }

  // 3. Upsert questions (with bank + source tagging)
  console.log(`[questions] upserting ${allQuestions.length} rows…`);
  {
    const rows = allQuestions.map((q) => {
      const e = enrichmentById.get(q.id);
      return {
        exam_id: cfg.id,
        external_id: q.id,
        stem: q.question,
        options: q.options,
        correct_index: q.correctIndex,
        explanation: q.explanation,
        reference: q.reference,
        question_type: q.isMath ? "calc" : "mcq",
        difficulty: q.difficulty,
        source: q._source,
        bank: q._bank,
        generated_by: q._source === "curated" ? null : "audited-v1",
        verified: true,
        verifier_notes: "Migrated from v1 audited bank",
        extended_explanation: e?.extendedExplanation ?? null,
        metaphor: e?.metaphor ?? null,
        wrong_answers: e?.wrongAnswers ?? null,
      };
    });
    await upsertInBatches(supabase, "questions", rows, 100, "external_id", "questions");
    console.log(`  done`);
  }

  // 4. Map external_id → uuid
  console.log("[question_facts] reading question UUIDs…");
  const uuidByExternal = await readExternalIdToUuid(supabase, cfg.id);
  console.log(`  mapped ${uuidByExternal.size} questions`);

  // 5. Upsert question_facts
  // Dedupe (qid, factId) pairs per question — synthesizer may emit the same
  // fact twice (once primary, once secondary). Prefer primary.
  console.log("[question_facts] writing question→fact mappings…");
  {
    const rows: { question_id: string; fact_id: string; primacy: "primary" | "secondary" }[] = [];
    let missingQuestions = 0;
    let dedupedDuplicates = 0;
    for (const [externalId, refs] of Object.entries(factsFile.questionFactMap)) {
      const qid = uuidByExternal.get(externalId);
      if (!qid) {
        missingQuestions += 1;
        continue;
      }
      const factPrimacy = new Map<string, boolean>();
      for (const r of refs) {
        const prev = factPrimacy.get(r.factId);
        if (prev === undefined) {
          factPrimacy.set(r.factId, r.primary);
        } else {
          dedupedDuplicates += 1;
          if (r.primary) factPrimacy.set(r.factId, true); // primary wins
        }
      }
      for (const [factId, isPrimary] of factPrimacy) {
        rows.push({ question_id: qid, fact_id: factId, primacy: isPrimary ? "primary" : "secondary" });
      }
    }
    await upsertInBatches(supabase, "question_facts", rows, 500, "question_id,fact_id", "question_facts");
    const notes = [
      missingQuestions ? `${missingQuestions} unmapped questionFactMap entries` : null,
      dedupedDuplicates ? `${dedupedDuplicates} duplicate (q,fact) pairs deduped` : null,
    ].filter(Boolean);
    console.log(`  ${rows.length} rows merged${notes.length ? ` (${notes.join("; ")})` : ""}`);
  }

  console.log(`\n✅ Ingest complete for '${cfg.id}'.`);
  console.log(`   - 1 exam, ${factsFile.facts.length} facts, ${allQuestions.length} questions, question_facts populated`);
}

const examKey = process.argv[2];
if (!examKey) {
  console.error(`Usage: npm run db:ingest -- <exam>\n  Known exams: ${Object.keys(EXAMS).join(", ")}`);
  process.exit(2);
}

ingest(examKey).catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
