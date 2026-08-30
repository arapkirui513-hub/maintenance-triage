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

export async function parseAndRepair({
  input,
  initialOutput,
  signal,
}) {
  const firstResult = parseAndValidate(initialOutput);

  if (firstResult.success) {
    return {
      success: true,
      data: firstResult.data,
      repairCount: 0,
    };
  }

  const repairCount = 1;

  // TransportError is deliberately allowed to propagate.
  // The route owns transport-error-to-HTTP mapping.
  const repairOutput = await repairMaintenanceReport({
    input,
    invalidOutput: initialOutput,
    validationError: firstResult.error,
    signal,
  });

  const repairedResult = parseAndValidate(repairOutput);

  if (repairedResult.success) {
    return {
      success: true,
      data: repairedResult.data,
      repairCount,
    };
  }

  // Quarantine represents model-output/content failures only.
  // A repair transport failure never reaches this point because it
  // propagates to the route.
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