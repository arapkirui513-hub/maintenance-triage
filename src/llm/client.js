import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { withTransportRetry } from "./retry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "prompts",
  "maintenance-triage-v1.md"
);

const PROMPT_VERSION = "maintenance-triage-v1";

// Valid response used by the normal stub case and as the repaired
// response for controlled Stage 3 tests.
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
      timeout: 15_000,
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
 * Remove a surrounding JSON code fence if the model returns one.
 */
function stripCodeFence(text) {
  const trimmed = text.trim();

  const fenceMatch = trimmed.match(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i
  );

  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Return the controlled initial stub response for Stage 3 testing.
 *
 * LLM_STUB_CASE is only used when LLM_STUB=1.
 */
function getStubInitialResponse() {
  const testCase = process.env.LLM_STUB_CASE || "valid";

  switch (testCase) {
    case "valid":
      return JSON.stringify(STUB_RESPONSE);

    case "fenced":
      return [
        "```json",
        JSON.stringify(STUB_RESPONSE, null, 2),
        "```",
      ].join("\n");

    case "malformed":
      return '{"equipment_type":"ventilator","issue_type":';

    case "invalid_enum":
      return JSON.stringify({
        ...STUB_RESPONSE,
        equipment_type: "syringe_pump",
      });

    case "extra_field":
      return JSON.stringify({
        ...STUB_RESPONSE,
        patient_risk: "critical",
      });

    case "repair_invalid":
      return '{"equipment_type":"ventilator","issue_type":';

    default:
      throw new Error(`Unknown LLM_STUB_CASE: ${testCase}`);
  }
}

/**
 * Return the controlled repair response for Stage 3 testing.
 *
 * All repair cases except repair_invalid return valid schema output.
 */
function getStubRepairResponse() {
  const testCase = process.env.LLM_STUB_CASE || "valid";

  if (testCase === "repair_invalid") {
    return '{"equipment_type":"ventilator","urgency":';
  }

  return JSON.stringify({
    ...STUB_RESPONSE,
    confidence: 0.9,
    reason: "Repaired stub response: valid maintenance triage output.",
  });
}

/**
 * Calls the model or returns a deterministic stub response.
 *
 * Real model calls are wrapped by the transport retry layer.
 *
 * Returns raw text. Parsing and schema validation belong to parser.js.
 */
export async function classifyMaintenanceReport(text) {
  if (process.env.LLM_STUB === "1") {
    return getStubInitialResponse();
  }

  const rawResponse = await withTransportRetry(
    async () => {
      return getClient().chat.completions.create({
        model: process.env.LLM_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: getSystemPrompt(),
          },
          {
            // Untrusted maintenance report remains separate from
            // the system prompt.
            role: "user",
            content: text,
          },
        ],
      });
    },
    {
      callType: "initial",
    }
  );

  return stripCodeFence(rawResponse.choices[0].message.content);
}

/**
 * Makes exactly one repair attempt after the initial model output
 * fails parsing or schema validation.
 *
 * Transport failures inside this one repair attempt may be retried
 * by retry.js, but parser.js still controls the maximum repair count.
 *
 * In stub mode, returns a deterministic controlled response so
 * Stage 3 can be tested without spending model quota.
 */
export async function repairMaintenanceReport({
  input,
  invalidOutput,
  validationError,
}) {
  if (process.env.LLM_STUB === "1") {
    return getStubRepairResponse();
  }

  const repairMessage = [
    "Your previous response failed the application's output validation.",
    "Return ONLY one corrected JSON object matching the maintenance-triage schema.",
    "Do not add fields.",
    "Do not return Markdown, code fences, or explanatory text.",
    "",
    "Validation error:",
    JSON.stringify(validationError),
  ].join("\n");

  const rawResponse = await withTransportRetry(
    async () => {
      return getClient().chat.completions.create({
        model: process.env.LLM_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: getSystemPrompt(),
          },
          {
            role: "user",
            content: input,
          },
          {
            role: "assistant",
            content: invalidOutput,
          },
          {
            role: "user",
            content: repairMessage,
          },
        ],
      });
    },
    {
      callType: "repair",
    }
  );

  return stripCodeFence(rawResponse.choices[0].message.content);
}

export { PROMPT_VERSION };