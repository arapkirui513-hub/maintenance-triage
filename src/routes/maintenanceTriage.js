import { Router } from "express";
import { InputSchema } from "../llm/schema.js";
import { classifyMaintenanceReport } from "../llm/client.js";
import { parseAndRepair } from "../llm/parser.js";
import { applyConfidencePolicy } from "../llm/policy.js";

const router = Router();

router.post("/maintenance-triage", async (req, res) => {
  // 1. Validate input before spending any model call.
  const inputResult = InputSchema.safeParse(req.body);

  if (!inputResult.success) {
    const issue = inputResult.error.issues[0];

    return res.status(400).json({
      error: "invalid_input",
      field: issue.path.join(".") || "text",
      message: issue.message,
    });
  }

  const { text } = inputResult.data;

  // 2. Call the model (or stub). Returns raw text.
  let rawText;

  try {
    rawText = await classifyMaintenanceReport(text);
  } catch (err) {
    // Stage 4 will replace this with timeout/retry-aware handling.
    return res.status(500).json({
      error: "model_call_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Parse and validate the model output.
  //    If parsing or schema validation fails, parser.js gets exactly
  //    one repair attempt. A second failure is quarantined and returned
  //    as a 422.
  const parsedResult = await parseAndRepair({
    input: text,
    initialOutput: rawText,
  });

  if (!parsedResult.success) {
    return res.status(422).json({
      error: "invalid_model_output",
      message: "Model output could not be validated after one repair attempt.",
      repair_count: parsedResult.repairCount,
    });
  }

  // 4. Apply the deterministic confidence policy.
  //    This remains application logic, not model logic.
  const finalResult = applyConfidencePolicy(parsedResult.data);

  return res.status(200).json(finalResult);
});

export default router;
