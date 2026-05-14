import Anthropic from "@anthropic-ai/sdk";

/**
 * Lazy server-only Anthropic client. Throws helpfully if the env var isn't set.
 */
let _client: Anthropic | null = null;
export function getAnthropic() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in env");
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Default model + thinking config for planning-tier work (coach, post-mortem).
 * Opus 4.7 with adaptive thinking — the model decides how hard to think.
 */
export const PLANNER_MODEL = "claude-opus-4-7";
