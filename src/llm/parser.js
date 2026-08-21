import { ModelOutputSchema } from "./schema.js";
import { quarantineFailure } from "./quarantine.js";
import {
  repairMaintenanceReport,
  PROMPT_VERSION,
} from "./client.js";

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i
  );

  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseAndValidate(rawText) {
  let parsed;

  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch (error) {
    return {
      success: false,
      stage: "json_parse",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const result = ModelOutputSchema.safeParse(parsed);

  if (!result.success) {
    return {
      success: false,
      stage: "schema_validation",
      error: result.error.issues,
    };
  }

  return {
    success: true,
    data: result.data,
  };
}

function buildRepairMessage({ originalOutput, validationError }) {
  return [
    "Your previous response could not be accepted by the application's output validator.",
    "Return ONLY one corrected JSON object matching the required maintenance-triage schema.",
    "Do not add fields. Do not include Markdown or explanatory text.",
    "",
    "Validation error:",
    JSON.stringify(validationError),
    "",
    "Previous response:",
    originalOutput,
  ].join("\n");
}

export async function parseAndRepair({
  input,
  initialOutput,
}) {
  const firstResult = parseAndValidate(initialOutput);

  if (firstResult.success) {
    return {
      success: true,
      data: firstResult.data,
      repairCount: 0,
    };
  }

  let repairOutput = null;
  const repairCount = 1;

  try {
    repairOutput = await repairMaintenanceReport({
      input,
      invalidOutput: initialOutput,
      validationError: firstResult.error,
    });
  } catch (error) {
    quarantineFailure({
      input,
      promptVersion: PROMPT_VERSION,
      originalOutput: initialOutput,
      repairOutput: null,
      validationError: error instanceof Error
        ? error.message
        : String(error),
      repairCount,
    });

    return {
      success: false,
      stage: "repair_call",
      error: error instanceof Error ? error.message : String(error),
      repairCount,
    };
  }

  const repairedResult = parseAndValidate(repairOutput);

  if (repairedResult.success) {
    return {
      success: true,
      data: repairedResult.data,
      repairCount,
    };
  }

  quarantineFailure({
    input,
    promptVersion: PROMPT_VERSION,
    originalOutput: initialOutput,
    repairOutput,
    validationError: repairedResult.error,
    repairCount,
  });

  return {
    success: false,
    stage: repairedResult.stage,
    error: repairedResult.error,
    repairCount,
  };
}