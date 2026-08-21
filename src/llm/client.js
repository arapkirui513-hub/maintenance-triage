import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "maintenance-triage-v1.md");
const PROMPT_VERSION = "maintenance-triage-v1";

// A fixed, schema-valid stub response. Used when LLM_STUB=1 so the route,
// validation, and policy logic can all be tested with zero model calls and
// zero spend.
const STUB_RESPONSE = {
  equipment_type: "ventilator",
  issue_type: "alarm_fault",
  urgency: "high",
  assigned_team: "biomedical_engineering",
  confidence: 0.91,
  reason: "Stub response: simulated ventilator alarm requiring review.",
};

let client = null;
let systemPrompt = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      timeout: 15_000, // 15s, not the SDK's 10-minute default. Retry policy comes in Stage 4.
    });
  }
  return client;
}

function getSystemPrompt() {
  if (!systemPrompt) {
    systemPrompt = readFileSync(PROMPT_PATH, "utf-8");
  }
  return systemPrompt;
}

/**
 * Strips a leading ```json / trailing ``` fence if the model added one,
 * and returns the raw text otherwise. Does not attempt JSON.parse here;
 * that happens one layer up so parse failures can feed the Stage 3
 * repair-retry path instead of throwing here.
 */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

/**
 * Calls the model (or returns the stub) and returns the raw text content,
 * fence-stripped but NOT yet JSON.parsed or schema-validated. The caller
 * (the route, in Stage 1/2; the repair loop, from Stage 3 on) is
 * responsible for parsing and validating.
 *
 * @param {string} text - the user-submitted maintenance report
 * @returns {Promise<string>} raw JSON text
 */
export async function classifyMaintenanceReport(text) {
  if (process.env.LLM_STUB === "1") {
    return JSON.stringify(STUB_RESPONSE);
  }

  const res = await getClient().chat.completions.create({
    model: process.env.LLM_MODEL,
    temperature: 0, // classification, not creativity; same input should give the same shape
    messages: [
      { role: "system", content: getSystemPrompt() },
      // The report is untrusted content and stays in its own user message,
      // never concatenated into the system prompt. See prompts/maintenance-triage-v1.md.
      { role: "user", content: text },
    ],
  });

  return stripCodeFence(res.choices[0].message.content);
}

export { PROMPT_VERSION };
